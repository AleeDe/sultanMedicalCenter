"use client";

import { useCallback, useEffect, useState } from "react";
import { getQueues, type DoctorQueue } from "@/app/actions/queue";
import {
  AnnouncementOverlay,
  SoundGate,
  type Called,
} from "@/components/NowServing";

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

   * Call the turn out loud. A patient who has looked away misses a purely
     visual change entirely — which is why every bank counter chimes. See
     NowServing.tsx for the chime/voice policy.

  This screen is always dark regardless of the device theme: it hangs in a
  dim waiting area, where a white 55" panel is glare rather than information.
*/

const REFRESH_MS = 5_000;
const STALE_MS = 30_000;

export function DisplayBoard({
  initial,
  clinicName,
  speechLang = "ur-PK",
}: {
  initial: DoctorQueue[];
  clinicName: string;
  /** Voice used for the spoken call, when one is installed on the machine. */
  speechLang?: string;
}) {
  const [queues, setQueues] = useState(initial);
  const [lastOk, setLastOk] = useState(() => Date.now());
  // A tick counter rather than separate clock/stale state: one setState per
  // second, with both values derived from it below.
  // Holds the current time, refreshed once a second. Reading Date.now()
  // during render is impure — the same render would produce a different
  // result each time — so the clock lives in state instead.
  /*
    Null until the first client tick. The clock cannot be server-rendered:
    the server formats one second and the browser hydrates on another, and
    React treats that as a genuine mismatch — which then drowns out the real
    ones in the console. Rendering nothing for one tick is invisible on a
    board that repaints every second anyway.
  */
  const [now, setNow] = useState<number | null>(null);

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
    // On the next tick rather than synchronously, so the clock is not blank
    // for a whole second while still leaving the server render clock-free.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const poll = setInterval(() => void refresh(), REFRESH_MS);
    const watch = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      clearInterval(watch);
    };
  }, [refresh]);

  // Both derived from `now`, so a render is deterministic.
  const stale = now !== null && now - lastOk > STALE_MS;
  const clock =
    now === null
      ? null
      : new Date(now).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });

  const active = queues.filter((q) => q.state !== "FINISHED");

  /*
    Who to announce.

    The first CALLED patient across every doctor — called, not in
    consultation: the announcement is what gets them out of their seat, so it
    must fire when they are summoned, not when they arrive.

    The key includes recall_count so that re-calling the same patient (they
    did not hear it the first time) announces again, while the five-second
    poll re-rendering the same state does not.
  */
  const called: Called | null = latestCalled(active);

  return (
    <div
      // Forced dark: this is a wall panel in a dim room, never the counter.
      data-theme="dark"
      className="relative flex min-h-screen flex-col overflow-hidden bg-[#070d16] p-6 text-white"
    >
      {/*
        Two soft colour washes behind the content. Purely atmospheric, and
        deliberately at very low opacity — anything stronger would compete
        with the token numbers, which are the only thing on this screen that
        anyone actually needs to read.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 -top-40 h-[36rem] w-[36rem] rounded-full
          bg-[var(--accent)] opacity-[0.13] blur-[130px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-52 -right-40 h-[34rem] w-[34rem] rounded-full
          bg-[#3ddc97] opacity-[0.08] blur-[130px]"
      />

      <AnnouncementOverlay called={called} speechLang={speechLang} />

      <header className="relative mb-7 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-4xl font-black tracking-tight">{clinicName}</h1>
        <div className="flex items-center gap-4">
          <SoundGate speechLang={speechLang} />
          {stale && (
            // Saying so is the honest move: a board confidently showing a
            // number that moved on ten minutes ago is worse than a blank one.
            <span className="rounded-full bg-amber-500/20 px-4 py-1.5 text-lg font-semibold text-amber-300">
              Reconnecting…
            </span>
          )}
          {clock && (
            <span className="tnum rounded-2xl bg-white/[0.07] px-4 py-1.5 text-2xl font-bold text-white/75">
              {clock}
            </span>
          )}
        </div>
      </header>

      {/*
        The grid grows to fill the screen and the rows share it evenly, so a
        wall-mounted TV is not showing everything in its top third. Column
        count follows the doctor count rather than a breakpoint: two doctors
        on a 55" screen should be big, not letterboxed beside empty space.
      */}
      <div
        className={`relative grid flex-1 auto-rows-fr gap-5 transition-opacity ${
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
        <p className="relative mt-20 text-center text-3xl text-white/50">
          No clinics running right now
        </p>
      )}

      {/* Client-only for the same reason as the clock above. */}
      <p className="relative mt-8 text-center text-sm text-white/25">
        {now === null
          ? " "
          : `Updated ${new Date(lastOk).toLocaleTimeString("en-GB", { hour12: true })}`}
      </p>
    </div>
  );
}

/**
 * The patient who was most recently summoned, across every doctor.
 *
 * Deliberately the LATEST by called_at rather than the first row of
 * `called`. More than one token can sit in CALLED at once — call_next()
 * does not require the previous patient to have been started — and that
 * list is ordered by queue position, so its first element is the OLDEST
 * outstanding call. Announcing that one would replay a call from minutes
 * ago and, because the row never changes, would then go silent for every
 * subsequent patient.
 *
 * A plain function rather than a memo: `active` is rebuilt on every render
 * anyway, so a dependency on it could never hit the cache. What actually
 * prevents re-announcing is the stable `key`, which the overlay compares.
 */
function latestCalled(active: DoctorQueue[]): Called | null {
  let best: Called | null = null;
  let bestAt = -Infinity;

  for (const q of active) {
    for (const c of q.called) {
      // A row with no called_at should never win over a timestamped one,
      // but must still be announceable when it is all there is.
      const at = c.called_at ? Date.parse(c.called_at) : 0;
      if (at < bestAt) continue;
      bestAt = at;
      best = {
        // recall_count is part of the identity so that re-calling the same
        // patient (they did not hear it) announces again, while the
        // five-second poll re-rendering the same state does not.
        key: `${c.token_id}:${c.recall_count}`,
        calledAt: at || Date.now(),
        displayNo: c.display_no,
        patientName: c.patient_name,
        room: q.room || null,
        doctorName: q.doctorName,
      };
    }
  }
  return best;
}

function Column({ q }: { q: DoctorQueue }) {
  const now = q.current;
  const next = q.called[0] ?? q.waiting[0] ?? null;
  const rest = (q.called.length > 0 ? q.waiting : q.waiting.slice(1)).slice(0, 4);
  const emergencyFirst = q.waiting[0]?.is_emergency || q.called[0]?.is_emergency;

  return (
    <section
      className="flex flex-col rounded-[26px] border border-white/10
        bg-gradient-to-b from-white/[0.09] to-white/[0.03] p-6 shadow-xl backdrop-blur-sm"
    >
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="truncate text-2xl font-bold">{q.doctorName}</h2>
        {q.room && (
          <span className="shrink-0 rounded-xl bg-[var(--accent)] px-4 py-1.5 text-lg font-black">
            {q.room}
          </span>
        )}
      </div>

      {/* Why the queue is not moving, said plainly. An unexplained wait feels
          far longer than an explained one. */}
      {q.state === "ON_BREAK" && (
        <p className="mb-4 rounded-2xl bg-amber-500/20 px-4 py-3 text-lg font-semibold text-amber-200">
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
        <p className="mb-4 rounded-2xl bg-red-500/20 px-4 py-3 text-lg font-semibold text-red-200">
          Emergency case being seen — normal queue resumes shortly
        </p>
      )}

      <p className="text-sm font-semibold uppercase tracking-[0.25em] text-white/45">
        Now serving
      </p>
      <p className="tnum my-1 leading-none">
        <BigToken value={now?.display_no ?? next?.display_no ?? null} />
      </p>

      {/* The name under the number: this is what a patient who mis-hears the
          digits uses to be certain it is them. */}
      {(now ?? next) && (
        <p className="mt-2 truncate text-2xl font-semibold text-white/75">
          {now?.patient_name ?? next?.patient_name}
        </p>
      )}

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
