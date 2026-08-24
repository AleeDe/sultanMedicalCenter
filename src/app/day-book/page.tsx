import { sql } from "@/lib/db";
import { guardReceptionPage } from "@/lib/auth";

export const dynamic = "force-dynamic";

type SeriesRow = { label: string; is_emergency: boolean; issued: number };
type CategoryRow = { category: string; items: number; collected: string };
type TokenRow = {
  display_no: string;
  patient_name: string;
  mrn: string;
  is_emergency: boolean;
  issued_at: string;
  status: string;
  total: string;
  paid: string;
};

export default async function DayBookPage() {
  await guardReceptionPage("/day-book");
  // All figures are for today in the clinic timezone, matching the day the
  // token series itself resets on.
  const [bySeries, byCategory, tokens, [totals]] = await Promise.all([
    sql<SeriesRow[]>`
      select ts.label, ts.is_emergency, count(t.id)::int as issued
        from token t
        join token_series ts on ts.id = t.series_id
       where t.token_date = current_date
       group by ts.label, ts.is_emergency, ts.sort_order
       order by ts.sort_order
    `,
    sql<CategoryRow[]>`
      select coalesce(s.category, 'CONSULT') as category,
             count(vi.id)::int as items,
             coalesce(sum(
               case when vi.status = 'PAID'
                    then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                    else 0 end), 0)::text as collected
        from visit_item vi
        join visit v on v.id = vi.visit_id
        left join service s on s.id = vi.service_id
       where v.visit_date = current_date
       group by coalesce(s.category, 'CONSULT')
       order by 1
    `,
    sql<TokenRow[]>`
      select t.display_no, p.name as patient_name, p.mrn, ts.is_emergency,
             t.issued_at, v.status,
             coalesce(sum(greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)), 0)::text as total,
             coalesce(sum(case when vi.status = 'PAID'
                          then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                          else 0 end), 0)::text as paid
        from token t
        join visit v         on v.id = t.visit_id
        join patient p       on p.id = v.patient_id
        join token_series ts on ts.id = t.series_id
        left join visit_item vi on vi.visit_id = v.id
       where t.token_date = current_date
       group by t.display_no, p.name, p.mrn, ts.is_emergency, t.issued_at, v.status
       order by t.issued_at desc
    `,
    sql<{ collected: string; outstanding: string; tokens: number }[]>`
      select
        coalesce(sum(case when vi.status = 'PAID'
                     then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                     else 0 end), 0)::text as collected,
        coalesce(sum(case when vi.status = 'PENDING'
                     then greatest(vi.unit_price_snapshot * vi.qty - vi.discount, 0)
                     else 0 end), 0)::text as outstanding,
        (select count(*)::int from token where token_date = current_date) as tokens
        from visit_item vi
        join visit v on v.id = vi.visit_id
       where v.visit_date = current_date
    `,
  ]);

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="mx-auto max-w-4xl px-5 py-5">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-[22px] font-bold tracking-tight">Day Book</h1>
        <p className="text-sm text-muted">{today}</p>
      </div>

      {/* The three numbers that matter at closing time. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Tokens issued" value={String(totals?.tokens ?? 0)} />
        <Stat
          label="Cash collected"
          value={`Rs. ${Number(totals?.collected ?? 0).toFixed(0)}`}
          tone="normal"
        />
        <Stat
          label="Still outstanding"
          value={`Rs. ${Number(totals?.outstanding ?? 0).toFixed(0)}`}
          tone={Number(totals?.outstanding ?? 0) > 0 ? "emergency" : undefined}
        />
      </div>

      <Section title="Tokens by type">
        {bySeries.length === 0 ? (
          <Empty>No tokens issued yet today.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {bySeries.map((r) => (
              <li
                key={r.label}
                className="flex items-center justify-between px-4 py-3"
              >
                <span className="flex items-center gap-2 font-medium">
                  {r.is_emergency && <span aria-hidden>⚠</span>}
                  {r.label}
                </span>
                <span className="font-semibold">{r.issued}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Collections by category">
        {byCategory.length === 0 ? (
          <Empty>Nothing billed yet today.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {byCategory.map((r) => (
              <li
                key={r.category}
                className="flex items-center justify-between px-4 py-3"
              >
                <span>
                  <span className="font-medium">{titleCase(r.category)}</span>
                  <span className="ml-2 text-sm text-muted">
                    {r.items} item{r.items === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="font-semibold">
                  Rs. {Number(r.collected).toFixed(0)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Today's tokens">
        {tokens.length === 0 ? (
          <Empty>No tokens issued yet today.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {tokens.map((t) => {
              const due = Number(t.total) - Number(t.paid);
              return (
                <li
                  key={t.display_no}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <span
                    className={`tnum shrink-0 rounded-[8px] px-2.5 py-1.5 font-mono text-sm font-bold ${
                      t.is_emergency
                        ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                        : "bg-[var(--accent-soft)] text-[var(--accent)]"
                    }`}
                  >
                    {t.display_no}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {t.patient_name}
                    </span>
                    <span className="tnum text-xs text-muted">
                      {t.mrn} ·{" "}
                      {new Date(t.issued_at).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: true,
                      })}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tnum block font-bold">
                      Rs. {Number(t.total).toFixed(0)}
                    </span>
                    {due > 0 && (
                      <span className="tnum text-xs font-semibold text-[var(--danger)]">
                        Rs. {due.toFixed(0)} due
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "normal" | "emergency";
}) {
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--line)] bg-surface p-4 shadow-[var(--shadow)]">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p
        className={`tnum mt-1 text-[30px] font-bold leading-none tracking-tight ${
          tone === "normal"
            ? "text-[var(--ok)]"
            : tone === "emergency"
              ? "text-[var(--danger)]"
              : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
        {title}
      </h2>
      <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-surface shadow-[var(--shadow)]">
        {children}
      </div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-12 text-center text-sm text-muted">{children}</p>;
}

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
