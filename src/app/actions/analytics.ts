"use server";

import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export type Kpi = {
  tokens: number;
  patients: number;
  newPatients: number;
  revenue: string;
  outstanding: string;
  avgBill: string;
  emergencyShare: number;
};

export type Point = { label: string; value: number };
export type NamedRow = { name: string; count: number; amount: string };

export type Analytics = {
  days: number;
  kpi: Kpi;
  prev: Kpi;
  revenueByDay: Point[];
  tokensByHour: Point[];
  byCategory: NamedRow[];
  byDoctor: NamedRow[];
  bySeries: NamedRow[];
  topServices: NamedRow[];
  topPatients: { name: string; mrn: string; visits: number; amount: string }[];
  byStaff: NamedRow[];
};

/**
 * Everything the owner needs to answer "how is the clinic doing?".
 *
 * All figures are computed in SQL over a rolling window and compared with the
 * immediately preceding window of equal length, so each number arrives with
 * the context needed to read it — a revenue figure alone says nothing.
 */
export async function getAnalytics(days = 30): Promise<Analytics> {
  await requireAdmin();
  const span = Math.min(Math.max(days, 1), 365);

  const [
    kpi,
    prev,
    revenueByDay,
    tokensByHour,
    byCategory,
    byDoctor,
    bySeries,
    topServices,
    topPatients,
    byStaff,
  ] = await Promise.all([
    kpiFor(span, 0),
    kpiFor(span, span),

    sql<Point[]>`
      select to_char(d.day, 'DD Mon') as label,
             coalesce(sum(
               case when vi.status = 'PAID'
                    then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                    else 0 end), 0)::float as value
        from generate_series(current_date - (${span - 1}::int), current_date,
                             interval '1 day') as d(day)
        left join visit v      on v.visit_date = d.day::date
        left join visit_item vi on vi.visit_id = v.id
       group by d.day
       order by d.day
    `,

    // Staffing signal: when does the counter actually get busy?
    sql<Point[]>`
      select lpad(extract(hour from t.issued_at)::text, 2, '0') || ':00' as label,
             count(*)::float as value
        from token t
       where t.token_date > current_date - (${span}::int)
       group by 1
       order by 1
    `,

    sql<NamedRow[]>`
      select coalesce(s.category, 'CONSULT') as name,
             count(vi.id)::int as count,
             coalesce(sum(
               case when vi.status = 'PAID'
                    then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                    else 0 end), 0)::text as amount
        from visit_item vi
        join visit v on v.id = vi.visit_id
        left join service s on s.id = vi.service_id
       where v.visit_date > current_date - (${span}::int)
       group by 1
       order by sum(greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)) desc
    `,

    sql<NamedRow[]>`
      select d.name,
             count(distinct v.id)::int as count,
             coalesce(sum(
               case when vi.status = 'PAID'
                    then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                    else 0 end), 0)::text as amount
        from visit v
        join doctor d on d.id = v.doctor_id
        left join visit_item vi on vi.visit_id = v.id
       where v.visit_date > current_date - (${span}::int)
       group by d.name
       order by count(distinct v.id) desc
    `,

    sql<NamedRow[]>`
      select ts.label as name,
             count(distinct t.id)::int as count,
             coalesce(sum(
               case when vi.status = 'PAID'
                    then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                    else 0 end), 0)::text as amount
        from token t
        join token_series ts on ts.id = t.series_id
        left join visit_item vi on vi.visit_id = t.visit_id
       where t.token_date > current_date - (${span}::int)
       group by ts.label, ts.sort_order
       -- Ordered by value, matching the bar the UI draws beside each row.
       order by 3 desc
    `,

    sql<NamedRow[]>`
      select vi.name_snapshot as name,
             count(*)::int as count,
             coalesce(sum(
               case when vi.status = 'PAID'
                    then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                    else 0 end), 0)::text as amount
        from visit_item vi
        join visit v on v.id = vi.visit_id
       where v.visit_date > current_date - (${span}::int)
         and vi.service_id is not null
       group by vi.name_snapshot
       order by count(*) desc
       limit 8
    `,

    sql<{ name: string; mrn: string; visits: number; amount: string }[]>`
      select p.name, p.mrn, count(distinct v.id)::int as visits,
             coalesce(sum(
               case when vi.status = 'PAID'
                    then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                    else 0 end), 0)::text as amount
        from patient p
        join visit v on v.patient_id = p.id
        left join visit_item vi on vi.visit_id = v.id
       where v.visit_date > current_date - (${span}::int)
       group by p.id, p.name, p.mrn
       order by count(distinct v.id) desc, 4 desc
       limit 8
    `,

    // Cash accountability under a shared login: who took the money.
    sql<NamedRow[]>`
      select coalesce(st.name, 'Unattributed') as name,
             count(vi.id)::int as count,
             coalesce(sum(
               case when vi.status = 'PAID'
                    then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                    else 0 end), 0)::text as amount
        from visit_item vi
        join visit v on v.id = vi.visit_id
        left join staff st on st.id = vi.added_by
       where v.visit_date > current_date - (${span}::int)
       group by 1
       order by 3 desc
    `,
  ]);

  return {
    days: span,
    kpi,
    prev,
    revenueByDay,
    tokensByHour,
    byCategory,
    byDoctor,
    bySeries,
    topServices,
    topPatients,
    byStaff,
  };
}

/** KPIs for a window ending `offset` days before today. */
async function kpiFor(span: number, offset: number): Promise<Kpi> {
  const [row] = await sql<
    {
      tokens: number;
      patients: number;
      new_patients: number;
      revenue: string;
      outstanding: string;
      emergency: number;
    }[]
  >`
    with win as (
      select (current_date - (${span + offset}::int)) as from_d,
             (current_date - (${offset}::int))        as to_d
    ),
    v as (
      select v.id, v.patient_id, v.series_id
        from visit v, win
       where v.visit_date > win.from_d and v.visit_date <= win.to_d
    )
    select
      (select count(*)::int from token t, win
        where t.token_date > win.from_d and t.token_date <= win.to_d) as tokens,
      (select count(distinct patient_id)::int from v)                 as patients,
      (select count(*)::int from patient p, win
        where p.created_at::date > win.from_d
          and p.created_at::date <= win.to_d)                         as new_patients,
      (select coalesce(sum(
                case when vi.status = 'PAID'
                     then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                     else 0 end), 0)::text
         from visit_item vi where vi.visit_id in (select id from v))  as revenue,
      (select coalesce(sum(
                case when vi.status = 'PENDING'
                     then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                     else 0 end), 0)::text
         from visit_item vi where vi.visit_id in (select id from v))  as outstanding,
      (select count(*)::int from v
         join token_series ts on ts.id = v.series_id
        where ts.is_emergency)                                        as emergency
  `;

  const revenue = Number(row?.revenue ?? 0);
  const tokens = row?.tokens ?? 0;

  return {
    tokens,
    patients: row?.patients ?? 0,
    newPatients: row?.new_patients ?? 0,
    revenue: revenue.toFixed(2),
    outstanding: Number(row?.outstanding ?? 0).toFixed(2),
    avgBill: tokens > 0 ? (revenue / tokens).toFixed(2) : "0.00",
    emergencyShare:
      tokens > 0 ? Math.round(((row?.emergency ?? 0) / tokens) * 100) : 0,
  };
}
