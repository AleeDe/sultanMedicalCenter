"use client";

/*
  IndexedDB wrapper.

  Deliberately hand-rolled rather than pulling in a library: three object
  stores and a handful of operations do not justify a dependency, and the
  failure modes here (a browser in private mode, a quota refusal) need to be
  handled explicitly rather than swallowed by an abstraction.

  Every write in the app goes here FIRST and to the network second, so the UI
  reads the same source whether or not there is a connection. There is no
  separate "offline mode" code path to get wrong.
*/

const DB_NAME = "tokgen";
const DB_VERSION = 1;

export type StoreName = "outbox" | "cache" | "leases";

/** One queued write, waiting for the server. */
export type OutboxItem = {
  id: string; // client-generated UUID; the server upserts on it
  kind: "ISSUE_TOKEN";
  payload: unknown;
  createdAt: number;
  attempts: number;
  lastError?: string;
};

/** A block of token numbers this machine owns. */
export type Lease = {
  id: string; // `${seriesId}` — one active lease per series
  leaseId: number;
  seriesId: number;
  code: string;
  seqFrom: number;
  seqTo: number;
  nextSeq: number;
  forDate: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no local storage available."));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("outbox")) {
        // Ordered by insertion: a token references a patient, so the queue
        // must drain in sequence rather than in parallel.
        db.createObjectStore("outbox", { keyPath: "id" }).createIndex(
          "createdAt",
          "createdAt",
        );
      }
      if (!db.objectStoreNames.contains("cache")) {
        db.createObjectStore("cache", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("leases")) {
        db.createObjectStore("leases", { keyPath: "id" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("Could not open local storage."));
  });

  return dbPromise;
}

async function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------------ cache */

export async function cacheSet(key: string, value: unknown): Promise<void> {
  await tx("cache", "readwrite", (s) =>
    s.put({ key, value, at: Date.now() }) as IDBRequest<IDBValidKey>,
  );
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const row = await tx<{ value: T } | undefined>("cache", "readonly", (s) =>
    s.get(key),
  );
  return row?.value ?? null;
}

/* ----------------------------------------------------------------- outbox */

export async function outboxAdd(item: OutboxItem): Promise<void> {
  await tx("outbox", "readwrite", (s) => s.put(item) as IDBRequest<IDBValidKey>);
}

/** Oldest first — the drain order the server depends on. */
export async function outboxAll(): Promise<OutboxItem[]> {
  const rows = await tx<OutboxItem[]>("outbox", "readonly", (s) => s.getAll());
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function outboxRemove(id: string): Promise<void> {
  await tx("outbox", "readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function outboxCount(): Promise<number> {
  return tx<number>("outbox", "readonly", (s) => s.count());
}

export async function outboxMarkFailed(
  id: string,
  error: string,
): Promise<void> {
  const item = await tx<OutboxItem | undefined>("outbox", "readonly", (s) =>
    s.get(id),
  );
  if (!item) return;
  await outboxAdd({ ...item, attempts: item.attempts + 1, lastError: error });
}

/* ----------------------------------------------------------------- leases */

export async function leaseGet(seriesId: number): Promise<Lease | null> {
  const row = await tx<Lease | undefined>("leases", "readonly", (s) =>
    s.get(String(seriesId)),
  );
  if (!row) return null;
  // A lease is only valid for the day it was issued: token numbers reset
  // daily, so yesterday's block would collide with today's numbering.
  const today = new Date().toISOString().slice(0, 10);
  return row.forDate === today ? row : null;
}

export async function leaseSet(lease: Lease): Promise<void> {
  await tx("leases", "readwrite", (s) => s.put(lease) as IDBRequest<IDBValidKey>);
}

export async function leaseAll(): Promise<Lease[]> {
  return tx<Lease[]>("leases", "readonly", (s) => s.getAll());
}

/** Consumes one number, returning null when the block is exhausted. */
export async function leaseTake(
  seriesId: number,
): Promise<{ seq: number; leaseId: number } | null> {
  const lease = await leaseGet(seriesId);
  if (!lease || lease.nextSeq > lease.seqTo) return null;

  const seq = lease.nextSeq;
  await leaseSet({ ...lease, nextSeq: seq + 1 });
  return { seq, leaseId: lease.leaseId };
}

/** How many numbers remain — the number reception actually needs to see. */
export async function leaseRemaining(seriesId: number): Promise<number> {
  const lease = await leaseGet(seriesId);
  if (!lease) return 0;
  return Math.max(0, lease.seqTo - lease.nextSeq + 1);
}

/* ------------------------------------------------------------- counter id */

const COUNTER_KEY = "tokgen.counterId";

/**
 * A stable per-machine id, generated on first run.
 *
 * Present from day one even though there is only one counter today: leases
 * are keyed on it, so adding a lab or pharmacy station later needs no
 * migration and no change to how numbers are allocated.
 */
export function counterId(): string {
  if (typeof localStorage === "undefined") return "unknown";
  let id = localStorage.getItem(COUNTER_KEY);
  if (!id) {
    id = `c-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(COUNTER_KEY, id);
  }
  return id;
}
