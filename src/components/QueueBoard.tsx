"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import {
  announceAgain,
  callNext,
  finishConsultation,
  getQueues,
  recallToken,
  setDoctorState,
  skipToken,
  startConsultation,
  type BreakReason,
  type DoctorQueue,
  type QueueRow,
} from "@/app/actions/queue";
import {
  Alert,
  Badge,
  Button,
  Card,
  DoctorAvatar,
  Empty,
  GroupLabel,
} from "@/components/ui";
import {
  IconAmbulance,
  IconCheck,
  IconCross,
} from "@/components/icons";

/*
  The queue screen.

  One component serves both reception and the doctor — the clinic decides who
  presses the button, not the software. Reception sees every doctor; a signed-
  in doctor sees only their own room, with the actions made large enough to
  hit on a tablet without looking.

  The primary action is deliberately singular: "Call next" also finishes
  whoever was in the room. Doctors forget to press Done, and every
  consultation time — and therefore every wait estimate — depends on that
  timestamp.
*/

export function QueueBoard({
  initial,
  doctorId,
  compact,
  reasons = [],
}: {
  initial: DoctorQueue[];
  /** Preset break reasons, from the database so the clinic can add one. */
  reasons?: BreakReason[];
  /** When set, only this doctor's queue is shown (the doctor's own view). */
  doctorId?: number;
  compact?: boolean;
}) {
  const [queues, setQueues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      setQueues(await getQueues(doctorId));
    } catch {
      // A dropped connection should not blank the screen — the last known
      // queue is still the best information available.
    }
  }, [doctorId]);

  // Reception and the doctor act on the same queue from different machines,
  // so a poll is what keeps them from working off a stale list.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  /*
    Every action reports what it did, not just what it failed to do.

    These used to succeed in silence, so the only evidence a press had
    registered was a row quietly moving elsewhere on screen. On a busy desk
    that reads the same as a press that missed — and the natural response is
    to press again, which calls a second patient nobody is ready for.

    The message names the token because that is the part that can be checked
    against the screen and the slip in the patient's hand. "Done" would close
    the loop without confirming the right thing happened.
  */
  const run = (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    done?: string,
  ) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) {
        const msg = res.error ?? "Something went wrong.";
        setError(msg);
        toast.show(msg, "error");
      } else if (done) {
        toast.show(done);
      }
      await refresh();
    });

  /*
    Reception watches four doctors at once, so the panels tile into columns
    rather than stacking: "who is free, where is the backlog" has to be
    answerable in one look, and a 2200px scroll makes that a search task.
    The doctor's own view keeps a single column — one queue, on a tablet,
    where a second column would only shrink the targets.
  */
  const single = doctorId != null || queues.length === 1;

  return (
    <div className="grid gap-4">
      {error && <Alert>{error}</Alert>}

      {queues.length === 0 && (
        <Card>
          <Empty>No active doctors.</Empty>
        </Card>
      )}

      <div
        className={
          single
            ? "grid gap-4"
            : "grid gap-4 lg:grid-cols-2 lg:items-start"
        }
      >
      {queues.map((q) => (
        <DoctorPanel
          key={q.doctorId}
          q={q}
          compact={compact}
          pending={pending}
          /*
            callNext is the one action whose confirmation cannot be written
            in advance: which patient it reaches depends on the queue at the
            moment it runs, so the message is built from what came back.
            An empty queue is a success that did nothing, and saying so is
            more useful than a silent no-op.
          */
          onCall={() =>
            start(async () => {
              setError(null);
              const res = await callNext(q.doctorId);
              if (!res.ok) {
                const msg = res.error ?? "Something went wrong.";
                setError(msg);
                toast.show(msg, "error");
              } else if (res.data) {
                toast.show(`Called ${res.data.display_no} · ${res.data.patient_name}`);
              } else {
                toast.show("Nobody left in the queue");
              }
              await refresh();
            })
          }
          onStart={(id, no) => run(() => startConsultation(id), `Started ${no}`)}
          onAnnounce={(id, no) => run(() => announceAgain(id), `Calling ${no} again`)}
          onFinish={(id, no) => run(() => finishConsultation(id), `Finished ${no}`)}
          onSkip={(id, no) => run(() => skipToken(id), `${no} marked not here`)}
          onRecall={(id, no) => run(() => recallToken(id), `${no} back in queue`)}
          reasons={reasons}
          onState={(state, minutes, reason, isPublic) =>
            run(() =>
              setDoctorState({
                doctorId: q.doctorId,
                state,
                minutes,
                reason: reason ?? "",
                isPublic: isPublic ?? false,
              }),
            )
          }
        />
      ))}
      </div>
    </div>
  );
}

function DoctorPanel({
  q,
  compact,
  pending,
  onCall,
  onStart,
  onAnnounce,
  onFinish,
  onSkip,
  onRecall,
  onState,
  reasons,
}: {
  q: DoctorQueue;
  compact?: boolean;
  pending: boolean;
  onCall: () => void;
  onStart: (id: number, displayNo: string) => void;
  onAnnounce: (id: number, displayNo: string) => void;
  onFinish: (id: number, displayNo: string) => void;
  onSkip: (id: number, displayNo: string) => void;
  onRecall: (id: number, displayNo: string) => void;
  onState: (
    s: "AVAILABLE" | "ON_BREAK" | "FINISHED",
    m: number | null,
    reason?: string,
    isPublic?: boolean,
  ) => void;
  reasons: BreakReason[];
}) {
  const onBreak = q.state === "ON_BREAK";
  const nobodyLeft = q.waiting.length === 0 && q.called.length === 0;

  return (
    <Card className="overflow-hidden">
      {/* Who, where, and how they are doing today */}
      <div className="border-b border-[var(--line)] p-4">
        {/*
          Reception is looking at four of these side by side, so each panel
          has to name its own doctor. The doctor's own screen already carries
          that name in its header — repeating it here would spend the top of
          a tablet screen restating what the person holding it knows, and
          push the queue itself further down.
        */}
        {!compact && (
          <div className="mb-3 flex items-center gap-3">
            <DoctorAvatar name={q.doctorName} />
            <div className="min-w-0 flex-1">
              {/*
                The name identifies the whole panel, so it wraps rather than
                truncating — "Dr. Ahme…" on a queue screen with four doctors is
                a genuine ambiguity, not a cosmetic one.
              */}
              <p className="text-head font-bold leading-tight">{q.doctorName}</p>
              <p className="truncate text-label text-muted">
                {q.speciality}
                {q.room ? ` · ${q.room}` : ""}
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{q.seenToday} seen</Badge>
          <Badge tone="neutral">~{q.typicalMinutes} min each</Badge>
          {onBreak ? (
            <Badge tone="danger">
              On break
              {q.breakReason ? ` · ${q.breakReason}` : ""}
              {q.expectedReturnAt
                ? ` · back ${new Date(q.expectedReturnAt).toLocaleTimeString(
                    "en-GB",
                    { hour: "2-digit", minute: "2-digit", hour12: true },
                  )}`
                : ""}
            </Badge>
          ) : q.state === "FINISHED" ? (
            <Badge tone="neutral">Finished for today</Badge>
          ) : (
            <Badge tone="ok">Available</Badge>
          )}
        </div>
      </div>

      {/* In the room now */}
      <div className="border-b border-[var(--line)] bg-sunken p-4">
        {q.current ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="tnum rounded-[10px] bg-[var(--ok-soft)] px-3 py-2 font-mono text-lg font-bold text-[var(--ok)]">
              {q.current.display_no}
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words font-semibold">{q.current.patient_name}</p>
              <p className="text-sm text-muted">
                In consultation
                {q.current.started_at && (
                  <> · {elapsed(q.current.started_at)}</>
                )}
              </p>
            </div>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => onFinish(q.current!.token_id, q.current!.display_no)}
            >
              <IconCheck className="h-[18px] w-[18px]" />
              Done
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted">Nobody in the room.</p>
        )}
      </div>

      {/* Called but not yet started */}
      {q.called.length > 0 && (
        <div className="border-b border-[var(--line)] p-4">
          <GroupLabel>Called — waiting to come in</GroupLabel>
          <ul className="grid gap-2">
            {q.called.map((r) => (
              <li
                key={r.token_id}
                className="rounded-[var(--r-sm)] border border-[var(--line)] p-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <TokenChip row={r} />
                  <span className="min-w-0 flex-1 break-words font-medium">
                    {r.patient_name}
                  </span>
                </div>
                {/* Buttons drop to their own row on a phone so neither is
                    squeezed below a comfortable target width. */}
                <div className="mt-2 flex gap-2 sm:mt-0 sm:hidden">
                  <Button
                    variant="primary"
                    className="flex-1"
                    disabled={pending}
                    onClick={() => onStart(r.token_id, r.display_no)}
                  >
                    Start
                  </Button>
                  {/*
                    Between "Start" and "Not here" deliberately: it is the
                    step a doctor should reach for BEFORE giving up on
                    someone, and putting it in that path makes it the
                    obvious next thing to try rather than a feature to
                    remember.
                  */}
                  <Button
                    className="flex-1"
                    disabled={pending}
                    onClick={() => onAnnounce(r.token_id, r.display_no)}
                    title="Announce this number on the waiting-room screen again"
                  >
                    Call again
                  </Button>
                  <Button
                    variant="danger"
                    className="flex-1"
                    disabled={pending}
                    onClick={() => onSkip(r.token_id, r.display_no)}
                    title="Patient did not appear — they can be recalled"
                  >
                    Not here
                  </Button>
                </div>
                <div className="hidden sm:mt-2 sm:flex sm:justify-end sm:gap-2">
                  <Button
                    variant="primary"
                    disabled={pending}
                    onClick={() => onStart(r.token_id, r.display_no)}
                  >
                    Start
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => onAnnounce(r.token_id, r.display_no)}
                    title="Announce this number on the waiting-room screen again"
                  >
                    Call again
                  </Button>
                  <Button
                    variant="danger"
                    disabled={pending}
                    onClick={() => onSkip(r.token_id, r.display_no)}
                    title="Patient did not appear — they can be recalled"
                  >
                    Not here
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        The primary action.

        On the doctor's phone this sticks to the bottom of the viewport rather
        than scrolling away with the card. Fitts's Law in its literal form:
        the target is anchored to the edge the thumb already rests on, so it
        stays cheap to hit no matter how long the queue below it grows. The
        desk keeps it inline — a mouse pays no such distance penalty, and a
        floating bar over a four-doctor grid would be ambiguous about which
        doctor it belonged to.
      */}
      <div
        className={`border-b border-[var(--line)] p-4 ${
          compact
            ? "sticky bottom-0 z-10 border-t bg-[var(--surface)]/95 pb-safe backdrop-blur-md"
            : ""
        }`}
      >
        <Button
          variant="primary"
          size={compact ? "xl" : "lg"}
          className={`w-full ${compact ? "shadow-[var(--glow)]" : ""}`}
          disabled={pending || nobodyLeft}
          onClick={onCall}
        >
          {nobodyLeft ? "Queue is empty" : "Call next patient"}
        </Button>
        {!nobodyLeft && q.current && (
          <p className="mt-2 text-center text-xs text-muted">
            This also marks {q.current.display_no} as done
          </p>
        )}
      </div>

      {/* Waiting */}
      <div className="p-4">
        <GroupLabel hint={`${q.waiting.length} waiting`}>Queue</GroupLabel>
        {q.waiting.length === 0 ? (
          <p className="py-3 text-center text-body text-muted">Nobody waiting.</p>
        ) : (
          <ul className="grid gap-1.5">
            {q.waiting.map((r) => (
              <li
                key={r.token_id}
                className={`flex flex-wrap items-center gap-2.5 rounded-[var(--r-sm)] border p-2.5 ${
                  r.is_emergency
                    ? "border-[var(--danger)] bg-[var(--danger-soft)]"
                    : "border-[var(--line)]"
                }`}
              >
                <span className="tnum w-7 shrink-0 text-center text-sm font-bold text-muted">
                  {r.queue_pos}
                </span>
                <TokenChip row={r} />
                {/*
                  Wraps rather than truncates. This is the name reception
                  reads out and the doctor matches against the person walking
                  in, and "Muhammad Abdul…" is a genuine ambiguity in a clinic
                  where several patients share a first name — not a cosmetic
                  one. A second line costs a few pixels; calling the wrong
                  patient costs a consultation.
                */}
                <span className="min-w-0 flex-1 break-words">
                  {r.patient_name}
                </span>
                <Badge tone={r.eta_minutes > 30 ? "gold" : "neutral"}>
                  ~{r.eta_minutes} min
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Skipped — recoverable, and kept visible so they are not forgotten */}
      {q.skipped.length > 0 && (
        <div className="border-t border-[var(--line)] p-4">
          <GroupLabel>Did not appear</GroupLabel>
          <ul className="grid gap-1.5">
            {q.skipped.map((r) => (
              <li
                key={r.token_id}
                className="flex flex-wrap items-center gap-2.5 rounded-[var(--r-sm)] bg-sunken p-2.5"
              >
                <TokenChip row={r} />
                <span className="min-w-0 flex-1 break-words text-sm">
                  {r.patient_name}
                </span>
                <span className="text-xs text-muted">
                  {r.status === "NO_SHOW" ? "No show" : "Stepped out"}
                </span>
                <Button
                  disabled={pending}
                  onClick={() => onRecall(r.token_id, r.display_no)}
                  className="h-9 px-3 text-xs"
                  style={{ minHeight: 36 }}
                >
                  Back in queue
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Availability.

        Going on a break is a once-or-twice-a-day action sitting on a screen
        whose whole job is calling the next patient, so it stays folded away —
        four panels each showing three idle Break buttons is pure noise, and
        noise is what makes the important control hard to find.

        Coming BACK is not folded away: a doctor whose queue is frozen needs
        that button immediately, and it is the one state where the panel is
        actively misleading until pressed.
      */}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] bg-sunken px-3 py-2">
        {onBreak ? (
          <Button
            variant="ok"
            disabled={pending}
            onClick={() => onState("AVAILABLE", null)}
            className="h-9 px-3 text-xs"
            style={{ minHeight: 36 }}
          >
            I&apos;m back
          </Button>
        ) : (
          <details className="group w-full">
            <summary
              className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-[var(--r-sm)]
                px-2 py-1.5 text-micro font-semibold text-muted transition-colors
                hover:bg-[var(--hover)] hover:text-[var(--accent)]"
            >
              Availability
              <span
                aria-hidden
                className="transition-transform duration-[var(--dur-fast)] group-open:rotate-90"
              >
                ›
              </span>
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
            {/*
              Reason-first, because the reason is what the waiting room needs
              and the duration follows from it — a namaz break is 15 minutes,
              a surgery is an hour. Asking for the minutes alone made every
              break look identical on the board.
            */}
            {reasons.map((r) => (
              <Button
                key={r.id}
                disabled={pending}
                onClick={() =>
                  onState("ON_BREAK", r.minutes ?? 15, r.label, r.is_public)
                }
                className="h-9 px-3 text-xs"
                style={{ minHeight: 36 }}
                title={
                  r.is_public
                    ? `Shown on the waiting-room board · back in ${r.minutes ?? 15} min`
                    : `Staff only, not shown to patients · back in ${r.minutes ?? 15} min`
                }
              >
                {r.label}
                <span className="tnum opacity-70"> {r.minutes ?? 15}m</span>
              </Button>
            ))}
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => onState("FINISHED", null)}
              className="ml-auto h-9 px-3 text-xs"
              style={{ minHeight: 36 }}
            >
              <IconCross className="h-3.5 w-3.5" />
              Finished for today
            </Button>
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

function TokenChip({ row }: { row: QueueRow }) {
  return (
    <span
      className={`tnum inline-flex shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 font-mono text-sm font-bold ${
        row.is_emergency
          ? "bg-[var(--danger-soft)] text-[var(--danger)]"
          : "bg-[var(--accent-soft)] text-[var(--accent)]"
      }`}
    >
      {row.is_emergency && <IconAmbulance className="h-4 w-4" />}
      {row.display_no}
    </span>
  );
}

function elapsed(since: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000));
  return mins < 1 ? "just started" : `${mins} min so far`;
}
