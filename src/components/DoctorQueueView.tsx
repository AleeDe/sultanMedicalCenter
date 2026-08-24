"use client";

import { useEffect, useState } from "react";
import { getQueues, type DoctorQueue } from "@/app/actions/queue";
import { QueueBoard } from "@/components/QueueBoard";
import { Card, Empty } from "@/components/ui";

/** Loads one doctor's queue on the client, after they have signed in. */
const STALE_MS = 45_000;

export function DoctorQueueView({ doctorId }: { doctorId: number }) {
  const [queues, setQueues] = useState<DoctorQueue[] | null>(null);
  /*
    When the list was last confirmed against the server.

    A doctor calling the next patient from a list that stopped updating ten
    minutes ago will call someone who has already been seen, or skip someone
    who arrived since. The board in the waiting room already says
    "Reconnecting" rather than showing numbers it cannot vouch for; this is
    the same promise on the screen the doctor actually acts from.
  */
  const [lastOk, setLastOk] = useState(() => Date.now());
  const [now, setNow] = useState<number | null>(null);

  /*
    Reception issues tokens into this queue continuously, so a doctor who
    signed in twenty minutes ago must not still be looking at the list as it
    was then. QueueBoard polls once it has data; this initial load did not,
    which left the first render stale until something else forced a refresh.
  */
  useEffect(() => {
    let alive = true;

    const load = () =>
      getQueues(doctorId)
        .then((q) => {
          if (!alive) return;
          setQueues(q);
          setLastOk(Date.now());
        })
        // Keep whatever is on screen: a dropped request is not a reason to
        // blank a queue the doctor is working from.
        .catch(() => alive && setQueues((prev) => prev ?? []));

    void load();
    const t = setInterval(() => void load(), 15_000);
    // Drives the staleness check. Client-only, so the server render cannot
    // disagree with the browser about what time it is.
    const clock = setInterval(() => setNow(Date.now()), 5_000);

    // A phone suspends timers in the background; coming back to the app is
    // exactly when the list is most likely to be wrong.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [doctorId]);

  if (queues === null) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-5 sm:px-5">
        <Card>
          <Empty>Loading your queue…</Empty>
        </Card>
      </div>
    );
  }

  const stale = now !== null && now - lastOk > STALE_MS;

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-5 sm:py-5">
      {stale && (
        <div
          role="status"
          className="animate-rise mb-3 flex items-center gap-2.5 rounded-[var(--r)]
            border border-[var(--gold)] bg-[var(--gold-soft)] px-3.5 py-2.5
            text-sm font-medium text-[var(--gold)]"
        >
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
          </span>
          Reconnecting — this list may be out of date. Do not call the next
          patient until it updates.
        </div>
      )}
      {/* compact: the primary action is sized for a tablet pressed without
          looking, since the doctor's attention is on the patient. */}
      <div className={stale ? "opacity-60" : undefined}>
        <QueueBoard initial={queues} doctorId={doctorId} compact />
      </div>
    </div>
  );
}
