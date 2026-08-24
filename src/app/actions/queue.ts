"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import type { ActionResult } from "@/app/actions/tokens";
import { requireAdmin, requireDoctor, requireStaff, verifyDoctorPin } from "@/lib/auth";

/*
  Queue operations.

  Both reception and the doctor drive the same functions — the clinic decides
  who presses the button, not the software. Everything that must be safe
  under two simultaneous callers lives in the database (call_next claims a
  row atomically), so these are thin wrappers.
*/

export type QueueRow = {
  token_id: number;
  display_no: string;
  patient_name: string;
  seq: number;
  status: string;
  priority: number;
  queue_pos: number;
  eta_minutes: number;
  is_emergency: boolean;
  recall_count: number;
  /** When the patient was summoned. Null while still WAITING. */
  called_at: string | null;
};

export type DoctorQueue = {
  doctorId: number;
  doctorName: string;
  room: string;
  speciality: string;
  state: "AVAILABLE" | "ON_BREAK" | "FINISHED";
  expectedReturnAt: string | null;
  typicalMinutes: number;
  /** The patient in the room right now, if any. */
  current: {
    token_id: number;
    display_no: string;
    patient_name: string;
    started_at: string | null;
    status: string;
  } | null;
  waiting: QueueRow[];
  /** Called but not yet started — the doctor is expecting them. */
  called: QueueRow[];
  skipped: QueueRow[];
  seenToday: number;
};

/** Everything the queue screens need, for one doctor or all of them. */
export async function getQueues(doctorId?: number): Promise<DoctorQueue[]> {
  const doctors = await sql<
    {
      id: number;
      name: string;
      room: string;
      speciality: string;
      state: string;
      expected_return_at: string | null;
    }[]
  >`
    select d.id, d.name, d.room, d.speciality,
           coalesce(s.state, 'AVAILABLE') as state,
           s.expected_return_at
      from doctor d
      left join doctor_session s on s.doctor_id = d.id
     where d.active ${doctorId ? sql`and d.id = ${doctorId}` : sql``}
     order by d.sort_order, d.name
  `;

  return Promise.all(
    doctors.map(async (d) => {
      const [rows, current, skipped, typical, seen] = await Promise.all([
        sql<QueueRow[]>`select * from queue_with_eta(${d.id})`,
        sql<
          {
            token_id: number;
            display_no: string;
            patient_name: string;
            started_at: string | null;
            status: string;
          }[]
        >`
          select t.id as token_id, t.display_no, p.name as patient_name,
                 t.started_at, t.status
            from token t
            join visit v on v.id = t.visit_id
            join patient p on p.id = v.patient_id
           where t.doctor_id = ${d.id}
             and t.token_date = current_date
             and t.status = 'IN_CONSULTATION'
           order by t.started_at desc
           limit 1
        `,
        sql<QueueRow[]>`
          select t.id as token_id, t.display_no, p.name as patient_name,
                 t.seq, t.status, t.priority, 0 as queue_pos, 0 as eta_minutes,
                 ts.is_emergency, t.recall_count, t.called_at
            from token t
            join visit v on v.id = t.visit_id
            join patient p on p.id = v.patient_id
            join token_series ts on ts.id = t.series_id
           where t.doctor_id = ${d.id}
             and t.token_date = current_date
             and t.status in ('SKIPPED','NO_SHOW')
           order by t.seq
        `,
        sql<{ typical_consult_seconds: number }[]>`
          select typical_consult_seconds(${d.id})
        `,
        sql<{ count: number }[]>`
          select count(*)::int as count from token
           where doctor_id = ${d.id} and token_date = current_date
             and status = 'DONE'
        `,
      ]);

      return {
        doctorId: d.id,
        doctorName: d.name,
        room: d.room,
        speciality: d.speciality,
        state: d.state as DoctorQueue["state"],
        expectedReturnAt: d.expected_return_at,
        typicalMinutes: Math.round(
          (typical[0]?.typical_consult_seconds ?? 300) / 60,
        ),
        current: current[0] ?? null,
        waiting: rows.filter((r) => r.status === "WAITING"),
        called: rows.filter((r) => r.status === "CALLED"),
        skipped,
        seenToday: seen[0]?.count ?? 0,
      };
    }),
  );
}

const idSchema = z.coerce.number().int().positive();

/**
 * Calls the next patient.
 *
 * Auto-finishes whoever was in the room: doctors forget to press Done, and
 * every consultation time depends on that timestamp. One button instead of
 * two keeps the data honest without asking anything extra of the doctor.
 */
export async function callNext(
  doctorId: number,
): Promise<ActionResult<{ display_no: string; patient_name: string } | null>> {
  const id = idSchema.safeParse(doctorId);
  if (!id.success) return { ok: false, error: "Unknown doctor." };
  await requireDoctor(id.data);

  try {
    const [row] = await sql<
      { display_no: string; patient_name: string }[]
    >`select * from call_next(${id.data}, true)`;

    revalidatePath("/queue");
    return { ok: true, data: row ?? null };
  } catch (err) {
    console.error("callNext failed", err);
    return { ok: false, error: "Could not call the next patient." };
  }
}

export async function startConsultation(
  tokenId: number,
): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(tokenId);
  if (!id.success) return { ok: false, error: "Unknown token." };
  await requireStaff();
  await sql`select start_consultation(${id.data})`;
  revalidatePath("/queue");
  return { ok: true, data: null };
}

export async function finishConsultation(
  tokenId: number,
): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(tokenId);
  if (!id.success) return { ok: false, error: "Unknown token." };
  await requireStaff();
  await sql`select finish_consultation(${id.data})`;
  revalidatePath("/queue");
  return { ok: true, data: null };
}

/** Skips a patient who did not appear. Recoverable until the second skip. */
export async function skipToken(
  tokenId: number,
): Promise<ActionResult<{ status: string }>> {
  const id = idSchema.safeParse(tokenId);
  if (!id.success) return { ok: false, error: "Unknown token." };
  await requireStaff();
  const [row] = await sql<{ skip_token: string }[]>`
    select skip_token(${id.data})
  `;
  revalidatePath("/queue");
  return { ok: true, data: { status: row.skip_token } };
}

/** Returns a skipped patient to the queue at their original position. */
export async function recallToken(
  tokenId: number,
): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(tokenId);
  if (!id.success) return { ok: false, error: "Unknown token." };
  await requireStaff();
  await sql`select recall_token(${id.data})`;
  revalidatePath("/queue");
  return { ok: true, data: null };
}

/**
 * Announces an already-called patient again.
 *
 * For the patient who was outside, or on the phone, or simply not listening.
 * The alternative the doctor had was to skip them, which costs the patient
 * their place over something that was never their fault.
 *
 * Distinct from recallToken(), which puts a SKIPPED patient back in line.
 */
export async function announceAgain(
  tokenId: number,
): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(tokenId);
  if (!id.success) return { ok: false, error: "Unknown token." };
  await requireStaff();
  await sql`select announce_again(${id.data})`;
  revalidatePath("/queue");
  return { ok: true, data: null };
}

const breakSchema = z.object({
  doctorId: idSchema,
  state: z.enum(["AVAILABLE", "ON_BREAK", "FINISHED"]),
  minutes: z.coerce.number().int().min(1).max(240).nullable(),
});

/**
 * Sets the doctor's availability.
 *
 * A break inflates every ETA in that doctor's queue. The expected return time
 * is what lets the board say WHY — an unexplained wait feels far longer than
 * an explained one, and a silently growing number destroys trust.
 */
export async function setDoctorState(
  input: z.input<typeof breakSchema>,
): Promise<ActionResult<null>> {
  const parsed = breakSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const v = parsed.data;
  // A doctor may set their own break; reception/admin may set anyone's.
  await requireDoctor(v.doctorId);

  const returnAt =
    v.state === "ON_BREAK" && v.minutes
      ? new Date(Date.now() + v.minutes * 60_000).toISOString()
      : null;

  await sql`
    insert into doctor_session (doctor_id, state, expected_return_at, updated_at)
    values (${v.doctorId}, ${v.state}, ${returnAt}, now())
    on conflict (doctor_id)
    do update set state = excluded.state,
                  expected_return_at = excluded.expected_return_at,
                  updated_at = now()
  `;

  revalidatePath("/queue");
  return { ok: true, data: null };
}

/* -------------------------------------------------------- doctor sign-in */

export async function checkDoctorPin(
  doctorId: number,
  pin: string,
): Promise<{ ok: boolean; isDefault: boolean }> {
  const clean = pin.trim();
  if (!/^\d{4,6}$/.test(clean)) return { ok: false, isDefault: false };

  const [row] = await sql<{ ok: boolean; is_default: boolean }[]>`
    select * from check_doctor_pin(${doctorId}, ${clean})
  `;

  // Blunts brute-forcing a 4-digit code over the network.
  await new Promise((r) => setTimeout(r, 400));
  return { ok: row?.ok ?? false, isDefault: row?.is_default ?? false };
}

export async function changeDoctorPin(
  doctorId: number,
  currentPin: string,
  newPin: string,
): Promise<ActionResult<null>> {
  // The doctor changing their own PIN — must be signed in as that doctor.
  await requireDoctor(doctorId);

  if (!/^\d{4,6}$/.test(newPin.trim())) {
    return { ok: false, error: "New PIN must be 4 to 6 digits." };
  }
  if (newPin.trim() === "1234") {
    return { ok: false, error: "Choose something other than 1234." };
  }

  // Verify the current PIN through the lockout-aware path.
  const check = await verifyDoctorPin(doctorId, currentPin.trim());
  if (check.lockedSeconds > 0) {
    return { ok: false, error: "Too many attempts. Try again shortly." };
  }
  if (!check.ok) return { ok: false, error: "Current PIN is incorrect." };

  await sql`
    update doctor
       set pin_bcrypt = crypt(${newPin.trim()}, gen_salt('bf', 10)),
           pin_hash = null, pin_salt = null
     where id = ${doctorId}
  `;
  await sql`
    insert into audit_log (actor, action, entity, entity_id)
    values ('Doctor', 'CHANGE_DOCTOR_PIN', 'doctor', ${String(doctorId)})
  `;
  return { ok: true, data: null };
}

/** The wait to quote a patient right now, used when issuing a token. */
export async function estimateWait(
  doctorId: number,
  priority = 0,
): Promise<number> {
  const [row] = await sql<{ estimate_wait_minutes: number }[]>`
    select estimate_wait_minutes(${doctorId}, ${priority}::smallint)
  `;
  return row?.estimate_wait_minutes ?? 0;
}

/* ------------------------------------------------------------------ accuracy */

export type WaitAccuracyRow = {
  doctor_id: number;
  doctor_name: string;
  n: number;
  median_quoted: string;
  median_actual: string;
  median_error: string;
  over_ran_pct: string;
  suggested_mult: string;
};

/**
 * Predicted vs actual wait. Feeds the Admin -> Wait accuracy tab, which is
 * how the over-promise multiplier gets tuned against real data.
 */
export async function getWaitAccuracy(
  days = 30,
): Promise<WaitAccuracyRow[]> {
  const d = Number.isFinite(days) ? Math.min(365, Math.max(1, days)) : 30;
  return sql<WaitAccuracyRow[]>`select * from wait_accuracy(${d})`;
}

/**
 * Admin resets a doctor's PIN without knowing the current one.
 *
 * Deliberately separate from changeDoctorPin: that one requires the current
 * PIN and is the doctor changing their own. This is the locked-out path, so
 * it is audited by name — under a shared admin login the log is the only
 * record of who reset whose access.
 */
export async function resetDoctorPin(
  doctorId: number,
  newPin: string,
): Promise<ActionResult<null>> {
  // Admin-only, and the actor is taken from the VERIFIED session — never from
  // a caller-supplied argument, which was forgeable and let the audit log be
  // written under any name (part of TG-01).
  const session = await requireAdmin();

  const clean = newPin.trim();
  if (!/^\d{4,8}$/.test(clean)) {
    return { ok: false, error: "PIN must be 4 to 8 digits." };
  }
  if (clean === "1234") {
    return { ok: false, error: "Pick something other than the default 1234." };
  }

  // bcrypt, and clear the legacy sha256 columns so the old hash cannot be
  // used to verify after a reset.
  await sql`
    update doctor
       set pin_bcrypt = crypt(${clean}, gen_salt('bf', 10)),
           pin_hash = null, pin_salt = null
     where id = ${doctorId}
  `;
  await sql`
    insert into audit_log (actor, action, entity, entity_id)
    values (${session.actor}, 'RESET_DOCTOR_PIN', 'doctor', ${String(doctorId)})
  `;
  return { ok: true, data: null };
}

/** Which doctors are still on the default PIN. Drives the go-live warning. */
export async function getDefaultPinDoctors(): Promise<
  { id: number; name: string }[]
> {
  await requireAdmin();
  return sql<{ id: number; name: string }[]>`
    select id, name from doctor
     where active
       and (
         (pin_bcrypt is not null and pin_bcrypt = crypt('1234', pin_bcrypt))
         or (pin_bcrypt is null and pin_hash =
             encode(digest(coalesce(pin_salt,'') || '1234', 'sha256'), 'hex'))
       )
     order by sort_order, name
  `;
}
