"use client";

import { useEffect, useState } from "react";
import { getQueues, type DoctorQueue } from "@/app/actions/queue";
import { QueueBoard } from "@/components/QueueBoard";
import { Card, Empty } from "@/components/ui";

/** Loads one doctor's queue on the client, after they have signed in. */
export function DoctorQueueView({ doctorId }: { doctorId: number }) {
  const [queues, setQueues] = useState<DoctorQueue[] | null>(null);

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
        .then((q) => alive && setQueues(q))
        // Keep whatever is on screen: a dropped request is not a reason to
        // blank a queue the doctor is working from.
        .catch(() => alive && setQueues((prev) => prev ?? []));

    void load();
    const t = setInterval(() => void load(), 15_000);

    // A phone suspends timers in the background; coming back to the app is
    // exactly when the list is most likely to be wrong.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      clearInterval(t);
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

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-5 sm:py-5">
      {/* compact: the primary action is sized for a tablet pressed without
          looking, since the doctor's attention is on the patient. */}
      <QueueBoard initial={queues} doctorId={doctorId} compact />
    </div>
  );
}
