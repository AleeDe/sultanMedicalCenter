"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  counterId,
  leaseGet,
  leaseRemaining,
  leaseSet,
  outboxAdd,
  outboxAll,
  outboxCount,
  outboxRemove,
  type OutboxItem,
} from "./db";
import {
  dbHealth,
  leaseBlock,
  syncToken,
  type SyncTokenInput,
} from "@/app/actions/offline";

/*
  The sync engine.

  Responsibilities, in the order they matter:
   1. know whether the server is genuinely reachable
   2. keep a block of token numbers leased ahead of need
   3. drain the outbox in order, exactly once per item

  navigator.onLine is not trusted on its own: it reports the network
  interface, not whether our server answers. A clinic connected to a router
  whose upstream is down reads as "online" and every write fails silently.
  So reachability is confirmed with a real round trip.

  That round trip deliberately does NOT touch the database. An earlier
  version probed with `select 1`, which meant a database fault — a rotated
  password, an exhausted pool — reported the clinic as offline. Two things
  went wrong at once: staff were sent to check a router that was fine, and
  the app switched to its offline path, which cannot issue anything unless
  it already holds leased numbers that only the server can grant.

  So there are three states, not two:

    online        server answers, database answers      normal
    serverOnly    server answers, database does not     wait; do not queue
    offline       server does not answer                use the leases

  Only the third is a real outage, and only the third should engage the
  offline path.
*/

export const LEASE_SIZE = 50;
export const LEASE_LOW = 15;

export type SyncState = {
  /** Reachable AND the database is usable — the only fully working state. */
  online: boolean;
  /** Reachable, but the server says its database is down. */
  serverOnly: boolean;
  /** What the server said is wrong, when it could say anything at all. */
  dbError: string | null;
  pending: number;
  remaining: number;
  syncing: boolean;
  leaseLow: boolean;
  lastError: string | null;
};

export function useSync(seriesIds: number[]) {
  const [state, setState] = useState<SyncState>({
    online: true,
    serverOnly: false,
    dbError: null,
    pending: 0,
    remaining: 0,
    syncing: false,
    leaseLow: false,
    lastError: null,
  });

  // Guards against two drains overlapping — an item processed twice is not
  // harmful (the server is idempotent) but it wastes a round trip and can
  // reorder the queue.
  const draining = useRef(false);
  /*
    The series list is held in a ref so the callbacks below stay stable —
    they are wired to a 20-second interval, and an identity that changed
    every render would tear down and rebuild the timer constantly.

    Written from an effect, never during render: mutating a ref while
    rendering is what React's rules of refs forbids.
  */
  const seriesRef = useRef(seriesIds);
  const seriesKey = seriesIds.join(",");
  useEffect(() => {
    seriesRef.current = seriesKey ? seriesKey.split(",").map(Number) : [];
  }, [seriesKey]);

  const refresh = useCallback(async () => {
    const pending = await outboxCount();
    const counts = await Promise.all(
      seriesRef.current.map((id) => leaseRemaining(id)),
    );
    // The binding constraint is the series with the fewest numbers left.
    const remaining = counts.length ? Math.min(...counts) : 0;
    setState((s) => ({
      ...s,
      pending,
      remaining,
      leaseLow: remaining < LEASE_LOW,
    }));
  }, []);

  /**
   * Asks the two questions separately: can we reach the server, and is its
   * database usable?
   *
   * /api/health touches nothing, so it still answers while the database is
   * refusing connections — which is exactly the case that used to be
   * misreported as an outage.
   */
  const probe = useCallback(async (): Promise<{
    reachable: boolean;
    dbOk: boolean;
    dbError: string | null;
  }> => {
    // A browser that knows it has no interface is believed immediately; the
    // reverse is never believed without a round trip.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return { reachable: false, dbOk: false, dbError: null };
    }

    try {
      const res = await fetch("/api/health", {
        cache: "no-store",
        // Bounded, so a captive portal that accepts the connection and then
        // never replies cannot hold the whole poll open.
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { reachable: false, dbOk: false, dbError: null };
    } catch {
      return { reachable: false, dbOk: false, dbError: null };
    }

    // Reachable. Now, separately, is the database usable?
    try {
      const health = await dbHealth();
      return {
        reachable: true,
        dbOk: health.ok,
        dbError: health.ok ? null : (health.error ?? "The database is unavailable."),
      };
    } catch {
      // The server answered /api/health but not this. Treat the database as
      // down rather than the network, because we have just proven the
      // network works.
      return {
        reachable: true,
        dbOk: false,
        dbError: "The database is unavailable.",
      };
    }
  }, []);

  /** Tops up leases so an outage never starts with an empty block. */
  const topUp = useCallback(async () => {
    for (const seriesId of seriesRef.current) {
      const remaining = await leaseRemaining(seriesId);
      if (remaining >= LEASE_LOW) continue;

      const res = await leaseBlock({
        counterId: counterId(),
        seriesId,
        size: LEASE_SIZE,
      });
      if (!res.ok) continue;

      const b = res.data;
      await leaseSet({
        id: String(seriesId),
        leaseId: b.leaseId,
        seriesId,
        code: b.code,
        seqFrom: b.seqFrom,
        seqTo: b.seqTo,
        nextSeq: b.seqFrom,
        forDate: b.forDate,
      });
    }
    await refresh();
  }, [refresh]);

  /**
   * Drains the outbox.
   *
   * Strictly in order and stopping on the first failure: a token references
   * a patient, so skipping ahead past a failed write would try to attach a
   * visit to a patient the server has never seen.
   */
  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    setState((s) => ({ ...s, syncing: true }));

    try {
      const items = await outboxAll();
      for (const item of items) {
        if (item.kind !== "ISSUE_TOKEN") {
          await outboxRemove(item.id);
          continue;
        }
        const res = await syncToken(item.payload as SyncTokenInput);
        if (!res.ok) {
          setState((s) => ({ ...s, lastError: res.error }));
          break; // keep order; retry on the next pass
        }
        await outboxRemove(item.id);
        await refresh();
      }
      setState((s) => ({ ...s, lastError: null }));
    } finally {
      draining.current = false;
      setState((s) => ({ ...s, syncing: false }));
      await refresh();
    }
  }, [refresh]);

  /** One pass: establish which of the three states we are in, then act. */
  const tick = useCallback(async () => {
    const { reachable, dbOk, dbError } = await probe();

    setState((s) => ({
      ...s,
      online: reachable && dbOk,
      serverOnly: reachable && !dbOk,
      dbError,
    }));

    /*
      Leasing and draining both need the database, so neither is attempted
      unless it is actually up. Retrying them against a database that has
      just said it is down only produces noise in the log.
    */
    if (!reachable || !dbOk) return;

    await topUp();
    await drain();
  }, [probe, topUp, drain]);

  useEffect(() => {
    /*
      Deferred to a task rather than run inline.

      refresh() and tick() both setState, and doing that synchronously in an
      effect body cascades a second render before the first has painted. A
      queued microtask lets the UI show its initial (assumed-online) state
      immediately, which is also the honest thing to display before any probe
      has actually completed.
    */
    const start = setTimeout(() => {
      void refresh();
      void tick();
    }, 0);

    // Browser events are a hint to check sooner, not the source of truth.
    // Both go through tick() rather than setting state inline: navigator's
    // "offline" can fire while our server is still reachable over a local
    // network, and vice versa.
    const onUp = () => void tick();
    const onDown = () => void tick();
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);

    // A slow poll catches the case the browser never fires an event for:
    // the interface stayed up but the upstream link came back.
    const timer = window.setInterval(() => void tick(), 20_000);

    return () => {
      clearTimeout(start);
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
      window.clearInterval(timer);
    };
  }, [refresh, tick]);

  /** Queues a token for later delivery. */
  const enqueue = useCallback(
    async (payload: SyncTokenInput) => {
      const item: OutboxItem = {
        id: payload.clientUuid,
        kind: "ISSUE_TOKEN",
        payload,
        createdAt: Date.now(),
        attempts: 0,
      };
      await outboxAdd(item);
      await refresh();
      // Try immediately; if it fails the poll will pick it up.
      void tick();
    },
    [refresh, tick],
  );

  return { ...state, enqueue, drain, topUp, refresh, probe };
}

/** Remaining numbers for one series — used by the token screen. */
export async function remainingFor(seriesId: number): Promise<number> {
  return leaseRemaining(seriesId);
}

export { leaseGet };
