"use client";

import { DoctorGate } from "@/components/DoctorGate";
import { DoctorQueueView } from "@/components/DoctorQueueView";
import type { Doctor } from "@/lib/types";

/**
 * Sign-in wrapped around the doctor's queue.
 *
 * A client component rather than composing these in the page: a server
 * component cannot pass a render function to a client one — React rejects a
 * function as a child across that boundary — and the gate needs to hand the
 * signed-in doctor down.
 */
export function DoctorConsole({ doctors }: { doctors: Doctor[] }) {
  return (
    <DoctorGate doctors={doctors}>
      {(doctor) => <DoctorQueueView doctorId={doctor.id} />}
    </DoctorGate>
  );
}
