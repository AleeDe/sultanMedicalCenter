"use client";

import { useState, useTransition, useEffect } from "react";
import { getWaitAccuracy, type WaitAccuracyRow } from "@/app/actions/queue";
import { Card, Empty } from "./ui";

/*
  Was the wait we printed on the slip honest?

  The headline is deliberately NOT average error. It is the share of patients
  who waited longer than they were told, because that is the single failure
  the estimate is arranged to avoid — an over-estimate costs nothing, an
  under-estimate is what patients react worst to.

  Target is roughly 10%, not 0%. Driving it to zero means quoting absurd
  waits to everyone, which destroys the estimate's usefulness in the other
  direction.
*/

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

export function WaitAccuracy() {
  const [rows, setRows] = useState<WaitAccuracyRow[] | null>(null);
  const [days, setDays] = useState(30);
  const [pending, start] = useTransition();

  useEffect(() => {
    start(async () => setRows(await getWaitAccuracy(days)));
  }, [days]);

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          What we printed on the slip, against what actually happened
        </p>
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              aria-pressed={days === r.days}
              disabled={pending}
              className={`h-9 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${
                days === r.days
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

      <p className="rounded-[var(--r-sm)] border border-[var(--line)] bg-sunken px-4 py-3 text-sm text-[var(--ink-2)]">
        The number that matters is <strong>Ran over</strong> — how often a
        patient waited longer than the slip promised. Around <strong>10%</strong>{" "}
        is healthy. Much higher and the estimate is under-promising, which is
        the error patients react worst to. Near zero means the quotes are so
        padded they have stopped being useful.
      </p>

      <div className={pending ? "opacity-50 transition-opacity" : ""}>
        <Card className="overflow-hidden">
          {rows === null ? (
            <Empty>Loading…</Empty>
          ) : rows.length === 0 ? (
            <Empty>
              Not enough finished consultations yet. A doctor needs at least
              five patients called and seen before the numbers mean anything.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-[0.05em] text-muted">
                    <th className="px-4 py-2.5 font-semibold">Doctor</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Seen</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Quoted</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Actual</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Ran over</th>
                    <th className="px-4 py-2.5 text-right font-semibold">
                      Suggested x
                    </th>
                    <th className="px-4 py-2.5 text-right font-semibold">
                      Overridden
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const over = Number(r.over_ran_pct);
                    // Green only in the healthy band. Over-padding is also a
                    // problem, so a very low number is not celebrated either.
                    const tone =
                      over > 25
                        ? "text-[#b42318]"
                        : over >= 3
                          ? "text-[#067647]"
                          : "text-[var(--ink-2)]";
                    return (
                      <tr
                        key={r.doctor_id}
                        className="border-b border-[var(--line)] last:border-0"
                      >
                        <td className="px-4 py-3 font-semibold">
                          {r.doctor_name}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted">
                          {r.n}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {r.median_quoted} min
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {r.median_actual} min
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-bold tabular-nums ${tone}`}
                        >
                          {r.over_ran_pct}%
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted">
                          {r.suggested_mult}
                        </td>
                        {/*
                          Muted unless it is high enough to matter: an
                          occasional override is normal, a quarter of them is
                          reception routinely disagreeing with the estimate.
                        */}
                        <td
                          className={`px-4 py-3 text-right tabular-nums ${
                            Number(r.override_pct) >= 20
                              ? "font-bold text-[var(--gold)]"
                              : "text-muted"
                          }`}
                        >
                          {r.override_pct}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {rows !== null && rows.length > 0 && (
        <p className="rounded-[var(--r-sm)] border border-[var(--line)] bg-sunken px-4 py-3 text-sm text-[var(--ink-2)]">
          <strong>Suggested x</strong> is what the over-promise multiplier
          would have had to be for nine out of ten of these patients to stay
          inside their quote. It currently ships at <strong>1.4</strong>, set
          in <code>estimate_wait_minutes()</code>. Changing it is a deliberate
          decision, not something the app does on its own — a multiplier that
          drifts by itself makes every printed slip unaccountable.
        </p>
      )}
    </section>
  );
}
