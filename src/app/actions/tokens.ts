"use server";

import { z } from "zod";
import { sql } from "@/lib/db";
import { requireReception } from "@/lib/auth";
import { tierFor } from "@/lib/loyalty";
import { classifyQuery } from "@/lib/patient-search";
import type {
  ClinicSetting,
  Doctor,
  LoyaltyTier,
  PatientSearchResult,
  PatientSummary,
  PatientWithTier,
  RecentVisit,
  ReceiptLine,
  TokenReceipt,
  TokenSeries,
  Staff,
} from "@/lib/types";

const genderSchema = z.enum(["MALE", "FEMALE", "OTHER"]);

const issueSchema = z.object({
  patientId: z.coerce.number().int().positive().nullable(),
  name: z.string().trim().min(1, "Patient name is required").max(120),
  phone: z.string().trim().max(20).default(""),
  gender: genderSchema,
  age: z.coerce.number().int().min(0).max(130).nullable(),
  address: z.string().trim().max(200).default(""),
  seriesId: z.coerce.number().int().positive(),
  // Accepted for backward compatibility but IGNORED: the server derives the
  // fee from the series inside issueToken. Never trust this value (TG-03).
  fee: z.coerce.number().min(0),
  staffId: z.coerce.number().int().positive().nullable(),
  // Lab tests / services chosen at the counter, billed and paid together with
  // the consultation fee so the patient pays once and gets one slip.
  serviceIds: z.array(z.coerce.number().int().positive()).default([]),
  doctorId: z.coerce.number().int().positive().nullable(),
  /*
    A wait reception typed over the calculated one. Null means "use the
    estimate" — the ordinary case. Kept separate from the estimate all the way
    into the database so the accuracy tuning is never polluted by a guess.
  */
  waitOverride: z.coerce.number().int().min(0).max(600).nullable().default(null),
});

export type IssueTokenInput = z.input<typeof issueSchema>;

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export async function getSeries(): Promise<TokenSeries[]> {
  return sql<TokenSeries[]>`
    select id, code, label, is_emergency, base_fee, active, sort_order
      from token_series
     where active
     -- Deliberately sort_order, never "most used": a list that reorders
     -- itself destroys the receptionist's memorised motor sequence.
     order by sort_order, id
  `;
}

export async function getClinic(): Promise<ClinicSetting> {
  const [row] = await sql<ClinicSetting[]>`
    select name, address, phone, footer_note, paper_width
      from clinic_setting where id = 1
  `;
  return row;
}

export async function getDoctors(): Promise<Doctor[]> {
  return sql<Doctor[]>`
    select id, name, speciality, room, active, sort_order
      from doctor
     where active
     -- Fixed order, never "most booked": reception picks from memorised
     -- positions and a list that reshuffles itself destroys that.
     order by sort_order, name
  `;
}

export async function getStaff(): Promise<Staff[]> {
  return sql<Staff[]>`
    select id, name, active from staff where active order by name
  `;
}

/**
 * The single search entry point for reception. Replaces phone-only lookup:
 * a returning patient holding a slip with their MRN on it previously had no
 * way to be found by it, which defeated the point of issuing one.
 */
export async function findPatients(
  query: string,
): Promise<PatientSearchResult> {
  // Returns patient PII, so reception-only, same as the phone lookup it
  // supersedes (TG-04).
  await requireReception();
  const q = query.trim();
  const kind = classifyQuery(q);

  // Two characters of a name matches most of the register. Phone and MRN
  // need enough to be a real claim, not a prefix fishing expedition.
  const minLen = kind === "NAME" ? 3 : 4;
  if (q.length < minLen) return { kind, matches: [] };

  const rows = await sql<(PatientWithTier & { visit_count: number })[]>`
    select p.id, p.mrn, p.name, p.phone, p.gender, p.age_years, p.address,
           count(v.id) filter (
             where v.opened_at > now() - interval '12 months'
           )::int as visit_count
      from patient p
      left join visit v on v.patient_id = p.id
     where ${
       kind === "MRN"
         ? // Suffix match so a receptionist who omits the prefix still lands
           // on the patient, while a full MRN stays an exact hit.
           sql`lower(p.mrn) = lower(${q}) or lower(p.mrn) like ${
             "%" + q.toLowerCase()
           }`
         : kind === "PHONE"
           ? // Compare digits only: the stored number and the typed one
             // disagree on spaces and dashes far more often than on digits.
             // '[^0-9]' not '\D' — a backslash escape inside a JS template
             // literal is resolved by JS before Postgres ever sees the string.
             sql`regexp_replace(p.phone, '[^0-9]', '', 'g')
                 = regexp_replace(${q}, '[^0-9]', '', 'g')
                 and p.phone <> ''`
           : sql`p.name % ${q} or p.name ilike ${"%" + q + "%"}`
     }
     group by p.id
     order by ${
       kind === "NAME"
         ? sql`similarity(p.name, ${q}) desc,`
         : sql``
     } max(v.opened_at) desc nulls last
     limit 25
  `;

  return {
    kind,
    matches: rows.map((r) => ({ ...r, tier: tierFor(r.visit_count) })),
  };
}

/**
 * The card reception sees once a patient is chosen. Its job is to let them
 * greet a returning patient by their history instead of asking questions the
 * clinic already knows the answer to.
 */
export async function getPatientSummary(
  patientId: number | string,
): Promise<PatientSummary | null> {
  await requireReception();
  /*
    Coerced, not asserted. patient.id is a bigint, which node-postgres hands
    back as a STRING to avoid silent precision loss, so this action is called
    with "1155" rather than 1155. An Number.isInteger() guard on the raw value
    rejects every real call and returns null, which shows up as a summary card
    that silently never appears.
  */
  const id = Number(patientId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const [totals] = await sql<
    {
      visit_count: number;
      first_seen: string | null;
      last_seen: string | null;
    }[]
  >`
    select count(*)::int as visit_count,
           min(visit_date)::text as first_seen,
           max(visit_date)::text as last_seen
      from visit
     where patient_id = ${id}
  `;

  if (!totals) return null;

  /*
    "Usual doctor" is the most-seen doctor in the last year, not all time.
    A patient who saw one doctor twenty times in 2023 and has been with
    someone else all year is a patient of the second doctor; pre-selecting
    the first would send them to the wrong room.

    Ties break toward the most recent, because that is the one reception
    would have guessed anyway.
  */
  const [usual] = await sql<
    { doctor_id: number; doctor_name: string }[]
  >`
    select d.id as doctor_id, d.name as doctor_name
      from visit v
      join doctor d on d.id = v.doctor_id
     where v.patient_id = ${id}
       and v.doctor_id is not null
       and v.opened_at > now() - interval '12 months'
     group by d.id, d.name
     order by count(*) desc, max(v.opened_at) desc
     limit 1
  `;

  const recent = await sql<RecentVisit[]>`
    select v.id as visit_id, v.visit_date::text as visit_date,
           d.name as doctor_name, ts.label as series_label
      from visit v
      left join doctor d on d.id = v.doctor_id
      join token_series ts on ts.id = v.series_id
     where v.patient_id = ${id}
     order by v.visit_date desc, v.id desc
     limit 3
  `;

  return {
    visit_count: totals.visit_count,
    first_seen: totals.first_seen,
    last_seen: totals.last_seen,
    // Normalised to a number here so the client can compare it against the
    // doctor list with === . doctor.id is a bigint and arrives as a string;
    // comparing "1" === 1 is false and would silently skip the pre-select.
    usual_doctor_id: usual ? Number(usual.doctor_id) : null,
    usual_doctor_name: usual?.doctor_name ?? null,
    recent,
  };
}

export type WaitPreview = {
  minutes: number;
  /** Set when this doctor is away, so the screen can explain the number. */
  breakReason: string;
  breakMinutesLeft: number;
  state: "AVAILABLE" | "ON_BREAK" | "FINISHED";
};

/**
 * The wait this patient would be quoted right now.
 *
 * Exists so reception SEES the number before the token is printed rather than
 * discovering it on the slip. Returns the break alongside it: a wait that
 * jumped from 12 to 45 minutes is alarming on its own and obvious once the
 * screen says the doctor is at namaz until 2:15.
 */
export async function previewWait(
  doctorId: number | string,
  isEmergency: boolean,
): Promise<WaitPreview | null> {
  await requireReception();
  const id = Number(doctorId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const [row] = await sql<
    {
      minutes: number;
      reason: string;
      state: string;
      break_left: number;
    }[]
  >`
    select estimate_wait_minutes(${id}, ${isEmergency ? 10 : 0}::smallint)
             as minutes,
           coalesce(ds.reason, '') as reason,
           coalesce(ds.state, 'AVAILABLE') as state,
           greatest(0, coalesce(
             extract(epoch from (ds.expected_return_at - now()))::int, 0))
             as break_left
      from doctor d
      left join doctor_session ds on ds.doctor_id = d.id
     where d.id = ${id}
  `;

  if (!row) return null;
  return {
    minutes: row.minutes,
    breakReason: row.reason,
    breakMinutesLeft: Math.ceil(row.break_left / 60),
    state: row.state as WaitPreview["state"],
  };
}

/**
 * Issues a token. Creates or updates the patient, then delegates the number
 * allocation to issue_token() so the sequence is taken inside the same
 * transaction as the token row.
 */
export async function issueToken(
  input: IssueTokenInput,
): Promise<ActionResult<TokenReceipt>> {
  await requireReception();
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    const first = Object.values(flat.fieldErrors).flat()[0];
    return {
      ok: false,
      error: first ?? "Please check the form.",
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  const v = parsed.data;

  try {
    /*
      Two round trips, not fifteen.

      This used to run the patient upsert, the MRN, issue_token, the series
      lookup, the fee line, ONE INSERT PER LAB, the patient re-read, the visit
      count, the audit row, the doctor lookup, the wait estimate, the wait
      write and the priority write as separate statements inside one
      transaction. Locally that is ~15ms and invisible; against the pooler in
      Mumbai it is 40-80ms EACH — about a second of pure network before any
      work happens, growing with every lab test added.

      Both calls are single statements, so each is its own transaction and
      neither holds one open across a network wait.
    */
    const [{ issue_token_full: r }] = await sql<
      { issue_token_full: RawReceipt }[]
    >`
      select issue_token_full(
        upsert_patient(${v.patientId}, ${v.name}, ${v.phone}, ${v.gender},
                       ${v.age}, ${v.address}),
        ${v.seriesId}, ${v.staffId}, ${v.doctorId},
        ${sql.array(v.serviceIds)}::bigint[], ${v.waitOverride},
        -- Resolved in the same statement rather than a second trip just to
        -- turn a staff id into a name for the audit row.
        coalesce((select name from staff where id = ${v.staffId}), 'Reception')
      )
    `;

    const receipt: TokenReceipt = {
      token_id: r.token_id,
      visit_id: r.visit_id,
      display_no: r.display_no,
      unique_id: r.unique_id,
      seq: r.seq,
      token_date: r.token_date,
      issued_at: r.issued_at,
      patient_name: r.patient_name,
      mrn: r.mrn,
      gender: r.gender,
      age_years: r.age_years,
      series_label: r.series_label,
      is_emergency: r.is_emergency,
      doctor_name: r.doctor_name ?? null,
      doctor_room: r.doctor_room ?? null,
      wait_minutes: r.wait_minutes ?? null,
      fee: r.fee,
      lines: r.lines,
      total: r.total,
      tier: tierFor(r.visit_count) as LoyaltyTier,
    };

    return { ok: true, data: receipt };
  } catch (err) {
    console.error("issueToken failed", err);
    return {
      ok: false,
      error:
        "Could not issue the token. Nothing was saved — please try again.",
    };
  }
}

/** The JSON shape issue_token_full() returns. */
type RawReceipt = {
  token_id: number;
  visit_id: number;
  display_no: string;
  unique_id: string;
  seq: number;
  token_date: string;
  issued_at: string;
  patient_name: string;
  mrn: string;
  gender: "MALE" | "FEMALE" | "OTHER";
  age_years: number | null;
  series_label: string;
  is_emergency: boolean;
  doctor_name: string | null;
  doctor_room: string | null;
  wait_minutes: number | null;
  fee: string;
  lines: ReceiptLine[];
  total: string;
  visit_count: number;
};

