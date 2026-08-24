"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  announcementText,
  chime,
  loadVoice,
  phraseVoiceReady,
  speak,
  speakAnnouncement,
  unlockAudio,
  voiceAvailable,
} from "@/lib/announce";
import { IconBell, IconSpeaker, IconSpeakerOff } from "@/components/icons";

export type Called = {
  key: string;
  /** Epoch ms of the summons, used to ignore calls that predate this board. */
  calledAt: number;
  displayNo: string;
  patientName: string;
  room: string | null;
  doctorName: string;
};

/*
  The moment a patient's turn comes.

  This is modelled on the bank counter the clinic already understands: a
  chime, then the number and the name, large enough to read from the back
  wall. Jakob's Law — people bring expectations from every other queue they
  have stood in, and meeting them costs nothing.

  Token number leads, name confirms. A patient is holding a slip with digits
  on it; the digits are what they match. The name resolves the ambiguity when
  two people hear a similar number, and it is what makes someone who has
  stopped watching the screen look up.
*/

const HOLD_MS = 12_000;

/*
  How old a call can be and still be worth announcing when the board first
  loads. Comfortably longer than the poll interval, far shorter than a
  consultation.
*/
const STALE_CALL_MS = 60_000;

export function AnnouncementOverlay({
  called,
  speechLang,
}: {
  /** Every outstanding call, oldest first. */
  called: Called[];
  /** e.g. "ur-PK". Speech is skipped entirely if no such voice exists. */
  speechLang: string;
}) {
  const [shown, setShown] = useState<Called | null>(null);

  /*
    Announcements are a QUEUE, played one at a time.

    Four doctors share one board and it polls every five seconds, so two of
    them calling inside the same window is routine. Announcing them
    concurrently would overlap two voices reading two different numbers —
    the one situation guaranteed to leave every patient unsure what was
    said — so each waits for the one before it to finish.
  */
  const pending = useRef<Called[]>([]);
  const announced = useRef<Set<string>>(new Set());
  const busy = useRef(false);
  // Set once the board has seen its first poll, so the stale-call rule below
  // applies only to calls that were already outstanding at startup.
  const started = useRef(false);

  useEffect(() => {
    const first = !started.current;
    started.current = true;

    for (const c of called) {
      // Only ever announce a given call once. The key carries recall_count,
      // so a deliberate re-call is a different key and does announce again.
      if (announced.current.has(c.key)) continue;

      /*
        A board that has just been switched on must not shout calls that were
        already outstanding — those summonses happened minutes ago and the
        patients are long since in the room.

        Judged on each call's AGE rather than simply "is this the first poll",
        because the first call a board observes is very often a real, live
        one: staff open this screen at the start of a clinic and the very next
        thing that happens is a patient being called.
      */
      if (first && Date.now() - c.calledAt > STALE_CALL_MS) {
        announced.current.add(c.key);
        continue;
      }

      announced.current.add(c.key);
      pending.current.push(c);
    }

    /*
      Bound the memory of what has been announced.

      A board runs for weeks without a reload, and without this the set would
      grow by one entry per patient forever. Trimming the oldest half is
      safe: those calls are long finished, and re-adding one would at worst
      re-announce a patient who left hours ago — which cannot happen anyway,
      because the row has left the CALLED state by then.
    */
    if (announced.current.size > 500) {
      const keep = [...announced.current].slice(-250);
      announced.current = new Set(keep);
    }

    if (busy.current) return;

    /*
      Drains the queue, one announcement at a time.

      Deliberately not tied to the effect's cleanup. An announcement is an
      event, not state to be reconciled: once the chime has sounded, the
      voice that follows it must happen. An earlier version cancelled the
      pending speech on the next poll — the chime survived, being
      synchronous, and the voice never did.
    */
    const drain = async () => {
      busy.current = true;
      while (pending.current.length > 0) {
        const next = pending.current.shift();
        if (!next) break;

        setShown(next);
        chime();

        // After the chime, so the two do not overlap.
        await new Promise((r) => setTimeout(r, 1100));

        /*
          The rendered voice first, browser speech only as a fallback.

          speakAnnouncement() declines when the token number is past the
          range the build rendered, which is a real possibility on an
          unusually busy day. A synthetic voice is much worse, and still far
          better than a patient never hearing their turn called.
        */
        let spokenFor = 0;
        if (phraseVoiceReady()) {
          spokenFor = await speakAnnouncement(next.displayNo, next.room);
        }
        if (!spokenFor && voiceAvailable(speechLang)) {
          speak(
            announcementText(next.displayNo, next.doctorName, next.room),
            speechLang,
          );
          // No duration is available from speechSynthesis without waiting on
          // its events, and this is only the fallback path; a fixed pause is
          // enough to keep two fallback announcements from colliding.
          spokenFor = 4;
        }

        // Wait out the announcement itself, then leave a clear beat before
        // the next patient's chime so the two calls do not run together.
        await new Promise((r) => setTimeout(r, spokenFor * 1000 + 900));
      }
      busy.current = false;
    };

    void drain();
  }, [called, speechLang]);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), HOLD_MS);
    return () => clearTimeout(t);
  }, [shown]);

  if (!shown) return null;

  return (
    <div
      // aria-live rather than a dialog: this steals no focus and traps
      // nothing. The board is unattended; a modal would be a trap with
      // nobody there to dismiss it.
      role="status"
      aria-live="assertive"
      className="animate-fade fixed inset-0 z-50 flex items-center justify-center
        bg-[#04070d]/92 p-8 backdrop-blur-md"
    >
      <div className="animate-ring w-full max-w-5xl rounded-[32px] border border-white/15
        bg-gradient-to-b from-white/[0.12] to-white/[0.04] p-12 text-center shadow-2xl">
        <p className="flex items-center justify-center gap-3 text-2xl font-semibold
          uppercase tracking-[0.35em] text-[var(--accent-2)]">
          <IconBell className="h-7 w-7" />
          Now serving
        </p>

        {/* The digits, at the largest size the screen allows. */}
        <p className="tnum mt-6 text-[clamp(5rem,18vw,13rem)] font-black leading-[0.9]
          tracking-[-0.04em] text-white">
          {shown.displayNo}
        </p>

        <p className="mt-6 text-[clamp(2rem,5vw,3.5rem)] font-bold leading-tight text-white/95">
          {shown.patientName}
        </p>

        <p className="mt-5 text-[clamp(1.25rem,2.5vw,2rem)] font-semibold text-white/70">
          {shown.doctorName}
          {shown.room && (
            <>
              {" · "}
              <span className="rounded-2xl bg-[var(--accent)] px-5 py-1.5 text-white">
                {shown.room}
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The one-time "turn sound on" control.
 *
 * Browsers refuse to play audio until someone has interacted with the page,
 * and a wall-mounted TV is never touched. Rather than failing silently
 * forever, the board asks once — staff tap it when they set the screen up,
 * and it disappears for good.
 */
/*
  Audio readiness and voice availability are both external systems: the
  AudioContext is unlocked by a gesture, and the voice list arrives
  asynchronously from the speech engine. Both are therefore subscribed to
  rather than copied into state inside an effect.
*/
const voiceStore = {
  subscribe(onChange: () => void) {
    if (typeof speechSynthesis === "undefined") return () => {};
    speechSynthesis.addEventListener("voiceschanged", onChange);
    return () => speechSynthesis.removeEventListener("voiceschanged", onChange);
  },
};

export function SoundGate({ speechLang }: { speechLang: string }) {
  /*
    Audio starts locked on every load and can only be unlocked by the button
    below — there is no external event to subscribe to, and no way for it to
    become ready behind our back. Plain state driven by the click is both
    correct and hydration-safe, where reading audioReady() during render
    would not be.
  */
  const [ready, setReady] = useState(false);
  // Whether the rendered voice loaded, so the label can tell staff setting up
  // a screen which voice they actually got.
  const [rendered, setRendered] = useState(false);

  const hasVoice = useSyncExternalStore(
    voiceStore.subscribe,
    () => voiceAvailable(speechLang),
    // The server has no speech engine; assume a voice exists so the initial
    // markup matches the common case and does not flash the wrong label.
    () => true,
  );

  if (ready) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5
          text-base font-semibold text-white/60"
        title={
          rendered
            ? "Chime and spoken announcements are on"
            : hasVoice
              ? "Chime is on, using this machine's built-in voice. The recorded announcements did not load."
              : `Chime is on. No ${speechLang} voice is installed on this machine, so names are shown but not spoken.`
        }
      >
        <IconSpeaker className="h-5 w-5" />
        {rendered || hasVoice ? "Sound on" : "Chime only"}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={async () => {
        if (await unlockAudio()) {
          setReady(true);
          chime(); // Confirms it worked, in the only way that matters.
          /*
            Load the voice NOW, not at the first call. This gesture is the
            only moment we are guaranteed, and fetching clips while a patient
            is being summoned would delay the one announcement that matters.
          */
          setRendered(await loadVoice());
        }
      }}
      className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2
        text-base font-bold text-white shadow-lg transition hover:brightness-110"
    >
      <IconSpeakerOff className="h-5 w-5" />
      Tap to enable sound
    </button>
  );
}
