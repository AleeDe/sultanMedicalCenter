"use client";

import { useState, useTransition } from "react";
import {
  getAnalytics,
  type Analytics as Data,
  type NamedRow,
  type Point,
} from "@/app/actions/analytics";
import { Badge, Card, Empty } from "@/components/ui";

/*
  Owner's dashboard.

  Every headline number is shown against the equivalent preceding window,
  because a bare figure ("Rs. 84,000") cannot be acted on — the question is
  always "compared with what?".

  Charts are hand-rolled SVG. A charting library would add weight for four
  small plots, and these need no interaction beyond a tooltip title.
*/

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

export function AnalyticsScreen({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial);
  const [pending, start] = useTransition();

  const k = data.kpi;
  const p = data.prev;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Compared with the previous {data.days} days
        </p>
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => start(async () => setData(await getAnalytics(r.days)))}
              aria-pressed={data.days === r.days}
              disabled={pending}
              className={`h-9 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${
                data.days === r.days
                  ? "bg-[var(--accent)] text-[var(--accent-ink)] shadow-[var(--shadow)]"
                  : "bg-sunken text-[var(--ink-2)] hover:bg-[var(--surface)] hover:text-[var(--accent)] hover:shadow-[var(--shadow)]"
              }`}
              style={{ minHeight: 36 }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className={pending ? "opacity-50 transition-opacity" : ""}>
        {/* headline numbers */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi1 label="Revenue collected" value={`Rs. ${fmt(k.revenue)}`}
                delta={pct(Number(k.revenue), Number(p.revenue))} tone="ok" />
          <Kpi1 label="Tokens issued" value={String(k.tokens)}
                delta={pct(k.tokens, p.tokens)} />
          <Kpi1 label="Average per token" value={`Rs. ${fmt(k.avgBill)}`}
                delta={pct(Number(k.avgBill), Number(p.avgBill))} />
          <Kpi1
            label="Outstanding"
            value={`Rs. ${fmt(k.outstanding)}`}
            delta={pct(Number(k.outstanding), Number(p.outstanding))}
            tone={Number(k.outstanding) > 0 ? "danger" : undefined}
            invert
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Kpi1 label="Patients seen" value={String(k.patients)}
                delta={pct(k.patients, p.patients)} small />
          <Kpi1 label="New patients" value={String(k.newPatients)}
                delta={pct(k.newPatients, p.newPatients)} small />
          <Kpi1 label="Emergency share" value={`${k.emergencyShare}%`}
                delta={k.emergencyShare - p.emergencyShare} suffix="pp" small />
        </div>

        {/* revenue trend */}
        <Section title="Revenue by day" className="mt-5">
          {data.revenueByDay.every((d) => d.value === 0) ? (
            <Empty>No revenue recorded in this period.</Empty>
          ) : (
            <div className="p-4">
              <LineChart points={data.revenueByDay} />
            </div>
          )}
        </Section>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Section title="Busiest hours">
            {data.tokensByHour.length === 0 ? (
              <Empty>No tokens issued yet.</Empty>
            ) : (
              <div className="p-4">
                <BarChart points={data.tokensByHour} unit="tokens" />
                <p className="mt-2 text-xs text-muted">
                  When the counter is busiest — useful for rostering.
                </p>
              </div>
            )}
          </Section>

          <Section title="Revenue by category">
            <RankList rows={data.byCategory} empty="Nothing billed yet." />
          </Section>

          <Section title="By doctor">
            <RankList
              rows={data.byDoctor}
              empty="No doctor recorded on any visit yet."
              countLabel="visits"
              by="count"
            />
          </Section>

          <Section title="By visit type">
            <RankList rows={data.bySeries} empty="No tokens yet." countLabel="tokens" />
          </Section>

          <Section title="Most-ordered tests">
            <RankList
              rows={data.topServices}
              empty="No tests ordered yet."
              by="count"
            />
          </Section>

          <Section title="Collected by counter staff">
            <RankList
              rows={data.byStaff}
              empty="Nothing collected yet."
              countLabel="items"
            />
          </Section>
        </div>

        <Section title="Most frequent patients" className="mt-5">
          {data.topPatients.length === 0 ? (
            <Empty>No visits in this period.</Empty>
          ) : (
            <ul>
              {data.topPatients.map((t) => (
                <li
                  key={t.mrn}
                  className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-2.5 last:border-0"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {t.name}
                    </span>
                    <span className="tnum text-xs text-muted">{t.mrn}</span>
                  </span>
                  <Badge tone="accent">{t.visits} visits</Badge>
                  <span className="tnum w-24 shrink-0 text-right text-sm font-bold">
                    Rs. {fmt(t.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- pieces */

function Kpi1({
  label,
  value,
  delta,
  tone,
  suffix,
  small,
  invert,
}: {
  label: string;
  value: string;
  delta: number | null;
  tone?: "ok" | "danger";
  suffix?: string;
  small?: boolean;
  /** For metrics where up is bad, e.g. outstanding money. */
  invert?: boolean;
}) {
  const good = delta == null ? null : invert ? delta <= 0 : delta >= 0;

  /*
    Direction and judgement are two different facts and are shown separately.
    The arrow always means "which way did it move"; the colour always means
    "is that good or bad". On an inverted metric like outstanding money they
    genuinely disagree — money owed went UP, which is BAD — and collapsing
    them into one signal is how a dashboard ends up quietly lying.
  */
  return (
    <Card className="p-4">
      <p className="text-label font-medium text-muted">{label}</p>
      <p
        className={`tnum mt-1 font-bold leading-none tracking-[-0.02em] ${
          small ? "text-[1.375rem]" : "text-[1.625rem]"
        } ${tone === "ok" ? "text-[var(--ok)]" : tone === "danger" ? "text-[var(--danger)]" : ""}`}
      >
        {value}
      </p>
      {delta != null && (
        <p className="mt-1.5 flex items-baseline gap-1 text-micro">
          <span
            className={`tnum font-semibold ${
              good ? "text-[var(--ok)]" : "text-[var(--danger)]"
            }`}
          >
            <span aria-hidden>{delta > 0 ? "▲" : delta < 0 ? "▼" : "="}</span>{" "}
            {Math.abs(delta).toFixed(suffix ? 0 : 1)}
            {suffix ?? "%"}
          </span>
          <span className="font-normal text-muted">vs previous</span>
          {/* Screen readers get the judgement in words, not in a colour. */}
          <span className="sr-only">
            {good ? " — better than the previous period" : " — worse than the previous period"}
          </span>
        </p>
      )}
    </Card>
  );
}

function Section({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
        {title}
      </h2>
      <Card className="overflow-hidden">{children}</Card>
    </section>
  );
}

function RankList({
  rows,
  empty,
  countLabel = "items",
  by = "amount",
}: {
  rows: NamedRow[];
  empty: string;
  countLabel?: string;
  /** Which column the bar should represent — must match how rows are ordered. */
  by?: "amount" | "count";
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  const val = (r: NamedRow) => (by === "count" ? r.count : Number(r.amount));
  const max = Math.max(...rows.map(val), 1);

  return (
    <ul>
      {rows.map((r) => (
        <li
          key={r.name}
          className="relative border-b border-[var(--line)] px-4 py-2.5 last:border-0"
        >
          {/* The bar is the comparison; the number is the detail. It must
              track the same column the list is sorted by, or the longest bar
              lands on a middle row and the ranking reads as broken. */}
          <span
            className="absolute inset-y-0 left-0 bg-[var(--accent-soft)]"
            style={{ width: `${(val(r) / max) * 100}%` }}
            aria-hidden
          />
          <span className="relative flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {label(r.name)}
            </span>
            <span className="tnum shrink-0 text-xs text-muted">
              {r.count} {countLabel}
            </span>
            <span className="tnum w-24 shrink-0 text-right text-sm font-bold">
              Rs. {fmt(r.amount)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function LineChart({ points }: { points: Point[] }) {
  const w = 720;
  const h = 180;
  const pad = { l: 4, r: 4, t: 10, b: 18 };
  const max = Math.max(...points.map((p) => p.value), 1);
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const x = (i: number) =>
    pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const area = `${line} L${x(points.length - 1)},${pad.t + ih} L${x(0)},${pad.t + ih} Z`;
  const peak = points.reduce((a, b) => (b.value > a.value ? b : a), points[0]);

  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-[180px] w-full"
        role="img"
        aria-label={`Revenue by day, peak ${peak?.label}`}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={pad.l}
            x2={w - pad.r}
            y1={pad.t + ih * f}
            y2={pad.t + ih * f}
            stroke="var(--line)"
            strokeDasharray="3 4"
          />
        ))}
        <path d={area} fill="var(--accent-soft)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2.5}
              strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r={p.value === peak.value ? 4 : 0}
                  fill="var(--accent)">
            <title>{`${p.label}: Rs. ${p.value.toFixed(0)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>{points[0]?.label}</span>
        <span className="font-semibold">
          Peak {peak?.label} · Rs. {fmt(String(peak?.value ?? 0))}
        </span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function BarChart({ points, unit }: { points: Point[]; unit: string }) {
  const max = Math.max(...points.map((p) => p.value), 1);
  return (
    <div className="flex h-[150px] items-end gap-1">
      {points.map((p) => (
        <div key={p.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div
            className="w-full rounded-t-[3px] bg-[var(--accent)] transition-all"
            style={{ height: `${Math.max((p.value / max) * 118, 3)}px` }}
            title={`${p.label} — ${p.value} ${unit}`}
          />
          <span className="tnum truncate text-[10px] text-muted">
            {p.label.replace(":00", "")}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- utils */

function pct(now: number, before: number): number | null {
  if (before === 0) return now === 0 ? 0 : null;
  return ((now - before) / before) * 100;
}

function fmt(v: string | number) {
  const n = Number(v);
  return n.toLocaleString("en-PK", { maximumFractionDigits: 0 });
}

/**
 * Row labels arrive from two different places: SQL enum categories that are
 * SHOUTED ("RADIOLOGY"), and human-entered names that are already correctly
 * cased ("Dr. Ahmed Raza", "X-Ray Chest"). Lower-casing everything mangled the
 * latter, so only all-caps values are re-cased.
 */
function label(s: string) {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
