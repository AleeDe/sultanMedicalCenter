"use client";

import { useCallback, useEffect, useState } from "react";
import { getQueues, type DoctorQueue } from "@/app/actions/queue";

/*
  The waiting-room TV.

  Design rules, each from the evidence rather than taste:

   * Show position AND minutes. Position is verifiable — a patient watches it
     count down and sees that nobody jumped them, which answers the fairness
     question that makes waits feel longest. Minutes are actionable.

   * Explain an emergency jump. An unexplained queue jump is the single worst
     thing for perceived fairness; an explained one is accepted. So when an
     emergency is at the front, the board says so.

   * Never show stale numbers as if live. If the data stops arriving the
     board must say it is reconnecting rather than confidently displaying a
     "now serving" that moved on ten minutes ago.
*/

const REFRESH_MS = 5_000;
const STALE_MS = 30_000;

export function DisplayBoard({
  initial,
  clinicName,
}: {
  initial: DoctorQueue[];
  clinicName: string;
}) {
  const [queues, setQueues] = useState(initial);
  const [lastOk, setLastOk] = useState(() => Date.now());
  // A tick counter rather than separate clock/stale state: one setState per
  // second, with both values derived from it below.
  // Holds the current time, refreshed once a second. Reading Date.now()
  // during render is impure — the same render would produce a different
  // result each time — so the clock lives in state instead.
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const q = await getQueues();
      setQueues(q);
      setLastOk(Date.now());
    } catch {
      // Leave the previous data in place; the staleness check below decides
      // when it stops being safe to show.
    }
  }, []);

  useEffect(() => {
    const poll = setInterval(() => void refresh(), REFRESH_MS);
    const watch = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(watch);
    };
  }, [refresh]);

  // Both derived from `now`, so a render is deterministic.
  const stale = now - lastOk > STALE_MS;
  const clock = new Date(now).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const active = queues.filter((q) => q.state !== "FINISHED");

  return (
    <div className="flex min-h-screen flex-col bg-[#0b1524] p-6 text-white">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">{clinicName}</h1>
        <div className="flex items-center gap-4">
          {stale && (
            // Saying so is the honest move: a board confidently showing a
            // number that moved on ten minutes ago is worse than a blank one.
            <span className="rounded-full bg-amber-500/20 px-4 py-1.5 text-lg font-semibold text-amber-300">
              Reconnecting…
            </span>
          )}
          <span className="tnum text-2xl font-semibold text-white/70">
            {clock}
          </span>
        </div>
      </header>

      {/*
        The grid grows to fill the screen and the rows share it evenly, so a
        wall-mounted TV is not showing everything in its top third. Column
        count follows the doctor count rather than a breakpoint: two doctors
        on a 55" screen should be big, not letterboxed beside empty space.
      */}
      <div
        className={`grid flex-1 auto-rows-fr gap-5 transition-opacity ${
          stale ? "opacity-40" : ""
        } ${
          active.length >= 5
            ? "lg:grid-cols-3"
            : active.length === 4
              ? "lg:grid-cols-2"
              : active.length === 3
                ? "lg:grid-cols-3"
                : active.length === 2
                  ? "lg:grid-cols-2"
                  : "lg:grid-cols-1"
        }`}
      >
        {active.map((q) => (
          <Column key={q.doctorId} q={q} />
        ))}
      </div>

      {active.length === 0 && (
        <p className="mt-20 text-center text-3xl text-white/50">
          No clinics running right now
        </p>
      )}

      <p className="mt-8 text-center text-sm text-white/30">
        Updated {new Date(lastOk).toLocaleTimeString("en-GB", { hour12: true })}
      </p>
    </div>
  );
}

function Column({ q }: { q: DoctorQueue }) {
  const now = q.current;
  const next = q.called[0] ?? q.waiting[0] ?? null;
  const rest = (q.called.length > 0 ? q.waiting : q.waiting.slice(1)).slice(0, 4);
  const emergencyFirst = q.waiting[0]?.is_emergency || q.called[0]?.is_emergency;

  return (
    <section className="rounded-2xl bg-white/[0.06] p-5">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h2 className="truncate text-xl font-bold">{q.doctorName}</h2>
        {q.room && (
          <span className="shrink-0 rounded-lg bg-white/10 px-3 py-1 text-lg font-bold">
            {q.room}
          </span>
        )}
      </div>

      {/* Why the queue is not moving, said plainly. An unexplained wait feels
          far longer than an explained one. */}
      {q.state === "ON_BREAK" && (
        <p className="mb-4 rounded-xl bg-amber-500/20 px-4 py-3 text-lg font-semibold text-amber-200">
          Doctor on a short break
          {q.expectedReturnAt && (
            <>
              {" · back "}
              {new Date(q.expectedReturnAt).toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
              })}
            </>
          )}
        </p>
      )}

      {emergencyFirst && (
        <p className="mb-4 rounded-xl bg-red-500/20 px-4 py-3 text-lg font-semibold text-red-200">
          Emergency case being seen — normal queue resumes shortly
        </p>
      )}

      <p className="text-sm uppercase tracking-[0.2em] text-white/50">
        Now serving
      </p>
      <p className="tnum my-1 leading-none">
        <BigToken value={now?.display_no ?? next?.display_no ?? null} />
      </p>

      {next && now && (
        <p className="mt-4 text-lg text-white/70">
          Next: <span className="tnum font-bold text-white">{next.display_no}</span>
        </p>
      )}

      {rest.length > 0 && (
        <ul className="mt-4 grid gap-2 border-t border-white/10 pt-4">
          {rest.map((r) => (
            <li key={r.token_id} className="flex items-baseline justify-between gap-3">
              {/* Same weighting as the headline: the digits are what a
                  patient matches against their slip. */}
              <span className="tnum text-xl font-bold text-white/80">
                <SmallToken value={r.display_no} />
              </span>
              {/* A range, not a single figure: false precision invites
                  patients to time you, and the upper bound is the real
                  commitment. */}
              <span className="text-lg text-white/50">
                {r.eta_minutes}–{r.eta_minutes + 10} min
              </span>
            </li>
          ))}
        </ul>
      )}

      {q.waiting.length === 0 && !now && (
        <p className="mt-4 text-lg text-white/40">No one waiting</p>
      )}
    </section>
  );
}

/*
  The token number, weighted the way it is actually read.

  A patient at the back of the room is matching the DIGITS on their slip.
  "NORM-" is context they already know — every token on the board carries it —
  so giving it equal size and weight makes it compete with the only part that
  distinguishes one patient from another.

  Rendering it smaller and dimmer roughly doubles the effective size of the
  digits within the same line height. Recognition is the task here, not
  reading, and recognition works on the differing part.
*/
function BigToken({ value }: { value: string | null }) {
  if (!value) return <span className="text-6xl font-black text-white/30">—</span>;

  const m = /^(.*?[-\s])?([0-9]+)$/.exec(value);
  if (!m) return <span className="text-6xl font-black">{value}</span>;

  const [, prefix, digits] = m;
  return (
    <span className="inline-flex items-baseline">
      {prefix && (
        <span className="text-3xl font-semibold tracking-tight text-white/45">
          {prefix.replace(/[-\s]$/, "")}
        </span>
      )}
      {prefix && <span className="w-2" aria-hidden />}
      <span className="text-7xl font-black tracking-[-0.03em]">{digits}</span>
    </span>
  );
}

/** The queue list's token, weighted like the headline but at list size. */
function SmallToken({ value }: { value: string }) {
  const m = /^(.*?[-\s])?([0-9]+)$/.exec(value);
  if (!m) return <>{value}</>;
  const [, prefix, digits] = m;
  return (
    <>
      {prefix && (
        <span className="font-semibold text-white/40">{prefix}</span>
      )}
      {digits}
    </>
  );
}
