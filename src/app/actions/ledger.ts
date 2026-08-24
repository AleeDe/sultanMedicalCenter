"use server";

import { z } from "zod";
import type postgres from "postgres";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { requireReception } from "@/lib/auth";
import { tierFor } from "@/lib/loyalty";
import type { ActionResult } from "@/app/actions/tokens";
import type { LoyaltyTier } from "@/lib/types";

export type LedgerItem = {
  id: number;
  name_snapshot: string;
  unit_price_snapshot: string;
  qty: number;
  discount: string;
  status: "PAID" | "PENDING";
  line_total: string;
  added_at: string;
};

export type VisitLedger = {
  visit_id: number;
  status: "OPEN" | "CLOSED";
  display_no: string;
  unique_id: string;
  issued_at: string;
  series_label: string;
  is_emergency: boolean;
  patient_name: string;
  mrn: string;
  phone: string;
  gender: string;
  age_years: number | null;
  tier: LoyaltyTier;
  items: LedgerItem[];
  total: string;
  paid: string;
  balance: string;
  invoice_no: string | null;
};

export type ServiceRow = {
  id: number;
  code: string;
  name: string;
  category: string;
  price: string;
};

export async function getServices(): Promise<ServiceRow[]> {
  await requireReception();
  return sql<ServiceRow[]>`
    select id, code, name, category, price
      from service where active
     -- Grouped by category, ordered by name. Never by popularity: a list that
     -- reorders itself breaks the operator's memorised positions.
     order by category, name
  `;
}

/** Today's open visits, for the "which patient am I billing?" list. */
export async function getOpenVisits() {
  await requireReception();
  return sql<
    {
      visit_id: number;
      display_no: string;
      patient_name: string;
      mrn: string;
      is_emergency: boolean;
      balance: string;
    }[]
  >`
    select v.id as visit_id, t.display_no, p.name as patient_name, p.mrn,
           ts.is_emergency,
           coalesce(sum(
             case when vi.status = 'PENDING'
                  then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                  else 0 end
           ), 0)::text as balance
      from visit v
      join token t        on t.visit_id = v.id
      join patient p      on p.id = v.patient_id
      join token_series ts on ts.id = v.series_id
      left join visit_item vi on vi.visit_id = v.id
     where v.status = 'OPEN' and v.visit_date = current_date
     group by v.id, t.display_no, p.name, p.mrn, ts.is_emergency, t.issued_at
     order by t.issued_at desc
  `;
}

/** Finds a visit by token number (NORM-00042 or the full unique id). */
export async function findVisit(query: string): Promise<VisitLedger | null> {
  await requireReception();
  const q = query.trim().toUpperCase();
  if (!q) return null;

  const [row] = await sql<{ visit_id: number }[]>`
    select v.id as visit_id
      from visit v
      join token t on t.visit_id = v.id
     where upper(t.display_no) = ${q} or upper(t.unique_id) = ${q}
     order by t.issued_at desc
     limit 1
  `;

  return row ? loadLedger(sql, row.visit_id) : null;
}

export async function getLedger(visitId: number): Promise<VisitLedger | null> {
  await requireReception();
  return loadLedger(sql, visitId);
}

type Db = typeof sql | postgres.TransactionSql<Record<string, never>>;

async function loadLedger(db: Db, visitId: number): Promise<VisitLedger | null> {
  const [head] = await db<
    (Omit<VisitLedger, "items" | "total" | "paid" | "balance" | "tier"> & {
      patient_id: number;
    })[]
  >`
    select v.id as visit_id, v.status, t.display_no, t.unique_id, t.issued_at,
           ts.label as series_label, ts.is_emergency,
           p.id as patient_id, p.name as patient_name, p.mrn, p.phone,
           p.gender, p.age_years,
           (select invoice_no from invoice
             where visit_id = v.id and voided_at is null
             order by issued_at desc limit 1) as invoice_no
      from visit v
      join token t         on t.visit_id = v.id
      join token_series ts on ts.id = v.series_id
      join patient p       on p.id = v.patient_id
     where v.id = ${visitId}
     limit 1
  `;

  if (!head) return null;

  const items = await db<LedgerItem[]>`
    select id, name_snapshot, unit_price_snapshot, qty, discount, status,
           greatest(unit_price_snapshot * qty - discount, 0)::text as line_total,
           added_at
      from visit_item
     where visit_id = ${visitId}
     order by added_at
  `;

  const [{ count }] = await db<{ count: number }[]>`
    select count(*)::int as count from visit
     where patient_id = ${head.patient_id}
       and opened_at > now() - interval '12 months'
  `;

  const total = items.reduce((s, i) => s + Number(i.line_total), 0);
  const paid = items
    .filter((i) => i.status === "PAID")
    .reduce((s, i) => s + Number(i.line_total), 0);

  return {
    ...head,
    items,
    tier: tierFor(count),
    total: total.toFixed(2),
    paid: paid.toFixed(2),
    balance: (total - paid).toFixed(2),
  };
}

const addSchema = z.object({
  visitId: z.coerce.number().int().positive(),
  serviceId: z.coerce.number().int().positive().nullable(),
  name: z.string().trim().min(1).max(120),
  price: z.coerce.number().min(0),
  qty: z.coerce.number().int().min(1).max(99),
  discount: z.coerce.number().min(0),
  payNow: z.boolean(),
  staffId: z.coerce.number().int().positive().nullable(),
});

/**
 * Appends a line to the running visit ledger.
 *
 * Price and name are SNAPSHOTTED here, never referenced live from the
 * catalogue: raising the X-ray price next month must not silently rewrite
 * this month's bills.
 */
export async function addItem(
  input: z.input<typeof addSchema>,
): Promise<ActionResult<VisitLedger>> {
  await requireReception();
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Please check the item details." };
  }
  const v = parsed.data;

  if (v.discount > v.price * v.qty) {
    return { ok: false, error: "Discount cannot exceed the line total." };
  }

  try {
    const ledger = await sql.begin(async (tx) => {
      const [open] = await tx<{ status: string }[]>`
        select status from visit where id = ${v.visitId} for update
      `;
      if (!open) throw new Error("Visit not found");
      if (open.status === "CLOSED") {
        throw new Error("This visit is already settled and closed.");
      }

      await tx`
        insert into visit_item (visit_id, service_id, name_snapshot,
                                unit_price_snapshot, qty, discount, status,
                                added_by)
        values (${v.visitId}, ${v.serviceId}, ${v.name}, ${v.price}, ${v.qty},
                ${v.discount}, ${v.payNow ? "PAID" : "PENDING"}, ${v.staffId})
      `;

      const actor = await actorName(tx, v.staffId);
      const detail = tx.json({
        item: v.name,
        price: v.price,
        qty: v.qty,
        discount: v.discount,
        paid: v.payNow,
      });
      await tx`
        insert into audit_log (actor, action, entity, entity_id, after)
        values (${actor}, 'ADD_ITEM', 'visit', ${String(v.visitId)}, ${detail})
      `;

      return loadLedger(tx, v.visitId);
    });

    revalidatePath("/billing");
    return ledger
      ? { ok: true, data: ledger }
      : { ok: false, error: "Visit not found." };
  } catch (err) {
    return { ok: false, error: message(err, "Could not add the item.") };
  }
}

export async function markItemPaid(
  itemId: number,
  visitId: number,
  staffId: number | null,
): Promise<ActionResult<VisitLedger>> {
  await requireReception();
  try {
    const ledger = await sql.begin(async (tx) => {
      await tx`
        update visit_item set status = 'PAID'
         where id = ${itemId} and visit_id = ${visitId}
      `;
      const actor = await actorName(tx, staffId);
      await tx`
        insert into audit_log (actor, action, entity, entity_id)
        values (${actor}, 'MARK_PAID', 'visit_item', ${String(itemId)})
      `;
      return loadLedger(tx, visitId);
    });

    revalidatePath("/billing");
    return ledger
      ? { ok: true, data: ledger }
      : { ok: false, error: "Visit not found." };
  } catch (err) {
    return { ok: false, error: message(err, "Could not update the item.") };
  }
}

export async function removeItem(
  itemId: number,
  visitId: number,
  staffId: number | null,
): Promise<ActionResult<VisitLedger>> {
  await requireReception();
  try {
    const ledger = await sql.begin(async (tx) => {
      const [row] = await tx<
        { name_snapshot: string; unit_price_snapshot: string }[]
      >`
        select name_snapshot, unit_price_snapshot from visit_item
         where id = ${itemId} and visit_id = ${visitId}
      `;
      await tx`delete from visit_item where id = ${itemId} and visit_id = ${visitId}`;

      // Removals are the classic cash-leakage path, so they are always
      // recorded with what was removed — not merely that something was.
      const actor = await actorName(tx, staffId);
      const before = tx.json(row ?? {});
      await tx`
        insert into audit_log (actor, action, entity, entity_id, before)
        values (${actor}, 'REMOVE_ITEM', 'visit_item', ${String(itemId)},
                ${before})
      `;
      return loadLedger(tx, visitId);
    });

    revalidatePath("/billing");
    return ledger
      ? { ok: true, data: ledger }
      : { ok: false, error: "Visit not found." };
  } catch (err) {
    return { ok: false, error: message(err, "Could not remove the item.") };
  }
}

/**
 * Final settlement: marks everything paid, allocates a gapless invoice number
 * from the ANNUAL series (deliberately separate from the daily token series),
 * and closes the visit.
 */
export async function settleVisit(
  visitId: number,
  staffId: number | null,
): Promise<ActionResult<VisitLedger>> {
  await requireReception();
  try {
    const ledger = await sql.begin(async (tx) => {
      const [visit] = await tx<{ status: string }[]>`
        select status from visit where id = ${visitId} for update
      `;
      if (!visit) throw new Error("Visit not found");
      if (visit.status === "CLOSED") {
        throw new Error("This visit is already settled.");
      }

      await tx`
        update visit_item set status = 'PAID'
         where visit_id = ${visitId} and status = 'PENDING'
      `;

      const current = await loadLedger(tx, visitId);
      if (!current) throw new Error("Visit not found");

      const year = new Date().getFullYear();
      const [{ next_invoice_seq: seq }] = await tx<
        { next_invoice_seq: number }[]
      >`select next_invoice_seq(${year}::smallint)`;

      const invoiceNo = `INV-${year}-${String(seq).padStart(6, "0")}`;

      await tx`
        insert into invoice (visit_id, invoice_no, year, seq, total, paid,
                             balance, issued_by)
        values (${visitId}, ${invoiceNo}, ${year}, ${seq}, ${current.total},
                ${current.total}, 0, ${staffId})
      `;

      await tx`
        update visit set status = 'CLOSED', closed_at = now()
         where id = ${visitId}
      `;

      const actor = await actorName(tx, staffId);
      const detail = tx.json({ invoice_no: invoiceNo, total: current.total });
      await tx`
        insert into audit_log (actor, action, entity, entity_id, after)
        values (${actor}, 'SETTLE_VISIT', 'visit', ${String(visitId)}, ${detail})
      `;

      return loadLedger(tx, visitId);
    });

    revalidatePath("/billing");
    return ledger
      ? { ok: true, data: ledger }
      : { ok: false, error: "Visit not found." };
  } catch (err) {
    return { ok: false, error: message(err, "Could not settle the visit.") };
  }
}

function message(err: unknown, fallback: string) {
  const m = err instanceof Error ? err.message : "";
  // Surface our own guard messages; hide driver internals from the counter.
  return m && !m.includes("relation") && !m.includes("syntax") ? m : fallback;
}

async function actorName(
  tx: postgres.TransactionSql<Record<string, never>>,
  staffId: number | null,
): Promise<string> {
  if (!staffId) return "Reception";
  const [row] = await tx<{ name: string }[]>`
    select name from staff where id = ${staffId}
  `;
  return row?.name ?? "Reception";
}
