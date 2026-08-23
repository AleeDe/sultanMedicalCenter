"use client";

import { useEffect, useState } from "react";
import { getQueues, type DoctorQueue } from "@/app/actions/queue";
import { QueueBoard } from "@/components/QueueBoard";
import { Card, Empty } from "@/components/ui";

/** Loads one doctor's queue on the client, after they have signed in. */
export function DoctorQueueView({ doctorId }: { doctorId: number }) {
  const [queues, setQueues] = useState<DoctorQueue[] | null>(null);

  useEffect(() => {
    let alive = true;
    getQueues(doctorId)
      .then((q) => alive && setQueues(q))
      .catch(() => alive && setQueues([]));
    return () => {
      alive = false;
    };
  }, [doctorId]);

  if (queues === null) {
    return (
      <div className="mx-auto max-w-4xl px-5 py-5">
        <Card>
          <Empty>Loading your queue…</Empty>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-5">
      {/* compact: the primary action is sized for a tablet pressed without
          looking, since the doctor's attention is on the patient. */}
      <QueueBoard initial={queues} doctorId={doctorId} compact />
    </div>
  );
}
