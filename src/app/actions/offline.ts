"use server";

import { z } from "zod";
import { sql } from "@/lib/db";
import { requireReception } from "@/lib/auth";
import type { ActionResult } from "@/app/actions/tokens";

/*
  Server side of the offline path.

  Two operations only: acquire a block of numbers while the connection is up,
  and replay a queued write once it returns. Everything that makes this safe
  lives in the database — the lease advances the shared counter, and every
  write is keyed on a client UUID the server upserts on.
*/

export type LeasedBlock = {
  leaseId: number;
  seriesId: number;
  code: string;
  seqFrom: number;
  seqTo: number;
  forDate: string;
};

const leaseSchema = z.object({
  counterId: z.string().trim().min(1).max(40),
  seriesId: z.coerce.number().int().positive(),
  size: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Reserves a block of token numbers for one counter.
 *
 * The block is genuinely reserved: leasing advances the same token_counter
 * the online path draws from, so the server cannot hand these numbers to
 * anyone else. That is what makes an offline token safe to print.
 */
export async function leaseBlock(
  input: z.input<typeof leaseSchema>,
): Promise<ActionResult<LeasedBlock>> {
  /*
    Returned, not thrown.

    The offline sync loop tops up leases on a timer, and that timer runs on
    the sign-in screen too — where there is no session yet, so requireReception
    threw straight out of a server action with nothing to catch it. In dev
    that is a logged 500 and the page still renders; in a production build it
    is an unhandled rejection that takes down the React tree, which is the
    "This page couldn't load" / React #441 screen users were getting on the
    login page.

    A caller with no session is not an error worth crashing for: it is simply
    a caller with nothing to lease.
  */
  try {
    await requireReception();
  } catch {
    return { ok: false, error: "Not signed in." };
  }
  const parsed = leaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid lease request." };
  const v = parsed.data;

  try {
    const [row] = await sql<
      {
        lease_id: number;
        seq_from: number;
        seq_to: number;
        code: string;
        for_date: string;
      }[]
    >`select * from lease_token_block(${v.counterId}, ${v.seriesId}, ${v.size})`;

    return {
      ok: true,
      data: {
        leaseId: row.lease_id,
        seriesId: v.seriesId,
        code: row.code,
        seqFrom: row.seq_from,
        seqTo: row.seq_to,
        forDate:
          typeof row.for_date === "string"
            ? row.for_date
            : new Date(row.for_date).toISOString().slice(0, 10),
      },
    };
  } catch (err) {
    console.error("leaseBlock failed", err);
    return { ok: false, error: "Could not reserve token numbers." };
  }
}

/* ------------------------------------------------------------------ sync */

const syncSchema = z.object({
  clientUuid: z.string().uuid(),
  visitUuid: z.string().uuid(),
  patientUuid: z.string().uuid().nullable(),
  patientId: z.coerce.number().int().positive().nullable(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(20).default(""),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]),
  age: z.coerce.number().int().min(0).max(130).nullable(),
  address: z.string().trim().max(200).default(""),
  seriesId: z.coerce.number().int().positive(),
  doctorId: z.coerce.number().int().positive().nullable(),
  staffId: z.coerce.number().int().positive().nullable(),
  fee: z.coerce.number().min(0),
  serviceIds: z.array(z.coerce.number().int().positive()).default([]),
  seq: z.coerce.number().int().positive(),
  leaseId: z.coerce.number().int().positive().nullable(),
  issuedAt: z.string(),
});

export type SyncTokenInput = z.input<typeof syncSchema>;

/**
 * Replays one token that was issued offline.
 *
 * Safe to call repeatedly with the same clientUuid: issue_token returns the
 * existing row rather than creating a second, which is what lets the client
 * retry a queued write without first asking whether it landed.
 */
export async function syncToken(
  input: SyncTokenInput,
): Promise<ActionResult<{ display_no: string; alreadyPresent: boolean }>> {
  // Same reasoning as leaseBlock: the drain loop runs without a session on
  // the sign-in screen, and a throw from here escapes as an unhandled
  // rejection rather than something the caller can act on.
  try {
    await requireReception();
  } catch {
    return { ok: false, error: "Not signed in." };
  }
  const parsed = syncSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "This queued token could not be read." };
  }
  const v = parsed.data;

  try {
    return await sql.begin(async (tx) => {
      const [before] = await tx<{ id: number }[]>`
        select id from token where client_uuid = ${v.clientUuid}
      `;
      if (before) {
        const [t] = await tx<{ display_no: string }[]>`
          select display_no from token where client_uuid = ${v.clientUuid}
        `;
        return {
          ok: true as const,
          data: { display_no: t.display_no, alreadyPresent: true },
        };
      }

      /*
        Resolve the patient.

        A patient created offline carries a client UUID and has no MRN yet —
        the MRN series is server-owned and must stay gapless, so it is
        assigned here rather than invented on the client.
      */
      let patientId = v.patientId;
      if (!patientId && v.patientUuid) {
        const [existing] = await tx<{ id: number }[]>`
          select id from patient where client_uuid = ${v.patientUuid}
        `;
        patientId = existing?.id ?? null;
      }

      if (!patientId) {
        const [{ next_mrn: mrn }] = await tx<{ next_mrn: string }[]>`
          select next_mrn()
        `;
        const [created] = await tx<{ id: number }[]>`
          insert into patient (mrn, name, phone, gender, age_years, address,
                               client_uuid)
          values (${mrn}, ${v.name}, ${v.phone}, ${v.gender}, ${v.age},
                  ${v.address}, ${v.patientUuid})
          on conflict (client_uuid) where client_uuid is not null
          do update set name = excluded.name
          returning id
        `;
        patientId = created.id;
      }

      const [tok] = await tx<
        { token_id: number; visit_id: number; display_no: string }[]
      >`
        select * from issue_token(${patientId}, ${v.seriesId}, ${v.staffId},
                                  ${v.doctorId}, ${v.seq}, ${v.clientUuid},
                                  ${v.visitUuid}, ${v.issuedAt}::timestamptz,
                                  ${v.leaseId})
      `;

      // Fee derived from the series, not taken from the client (TG-03).
      const [series] = await tx<{ label: string; base_fee: string }[]>`
        select label, base_fee from token_series where id = ${v.seriesId}
      `;

      await tx`
        insert into visit_item (visit_id, service_id, name_snapshot,
                                unit_price_snapshot, qty, status, added_by)
        values (${tok.visit_id}, null, ${series.label + " Fee"},
                ${Number(series.base_fee)}, 1, 'PAID', ${v.staffId})
      `;

      if (v.serviceIds.length > 0) {
        const chosen = await tx<
          { id: number; name: string; price: string }[]
        >`select id, name, price from service
           where id in ${tx(v.serviceIds)} and active`;
        for (const s of chosen) {
          await tx`
            insert into visit_item (visit_id, service_id, name_snapshot,
                                    unit_price_snapshot, qty, status, added_by)
            values (${tok.visit_id}, ${s.id}, ${s.name}, ${s.price}, 1,
                    'PAID', ${v.staffId})
          `;
        }
      }

      const detail = tx.json({
        display_no: tok.display_no,
        offline: true,
        issued_at: v.issuedAt,
      });
      await tx`
        insert into audit_log (actor, action, entity, entity_id, after)
        values ('Reception', 'SYNC_OFFLINE_TOKEN', 'token',
                ${String(tok.token_id)}, ${detail})
      `;

      return {
        ok: true as const,
        data: { display_no: tok.display_no, alreadyPresent: false },
      };
    });
  } catch (err) {
    console.error("syncToken failed", err);
    return { ok: false, error: "Could not sync this token." };
  }
}

/**
 * Is the DATABASE healthy? Reachability is a different question.
 *
 * This used to be `ping()`, and the sync engine treated its failure as
 * "offline". That conflated two faults with opposite remedies: a cut cable,
 * where the offline path should take over, and a database that is refusing
 * connections, where it must not — the offline path needs leased numbers it
 * can only obtain from the server, so pretending to be offline during a
 * database outage leaves reception unable to issue anything at all.
 *
 * Server reachability is now answered by /api/health, which touches nothing.
 * This reports on the database alone, and resolves rather than throwing so
 * the caller can tell "the server said the database is down" apart from "the
 * server never answered".
 */
export async function dbHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await sql`select 1`;
    return { ok: true };
  } catch (err) {
    // The message can carry the connection string; log it, never return it.
    console.error("dbHealth failed", err);
    const code =
      typeof err === "object" && err && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    return {
      ok: false,
      // Named causes only, because these three have different fixes and the
      // person reading the chip is not the person who can fix any of them.
      error:
        code === "28P01"
          ? "The database rejected the server's password."
          : code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT"
            ? "The database did not respond."
            : "The database is unavailable.",
    };
  }
}
