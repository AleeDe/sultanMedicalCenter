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
import { leaseBlock, ping, syncToken, type SyncTokenInput } from "@/app/actions/offline";

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
*/

export const LEASE_SIZE = 50;
export const LEASE_LOW = 15;

export type SyncState = {
  online: boolean;
  pending: number;
  remaining: number;
  syncing: boolean;
  leaseLow: boolean;
  lastError: string | null;
};

export function useSync(seriesIds: number[]) {
  const [state, setState] = useState<SyncState>({
    online: true,
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

  /** Confirms the server answers, not merely that an interface is up. */
  const probe = useCallback(async (): Promise<boolean> => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return false;
    try {
      await ping();
      return true;
    } catch {
      return false;
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

  /** One pass: check reachability, then top up and drain if reachable. */
  const tick = useCallback(async () => {
    const online = await probe();
    setState((s) => ({ ...s, online }));
    if (!online) return;
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
