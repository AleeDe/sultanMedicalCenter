"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  announcementText,
  chime,
  speak,
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
  called: Called | null;
  /** e.g. "ur-PK". Speech is skipped entirely if no such voice exists. */
  speechLang: string;
}) {
  const [shown, setShown] = useState<Called | null>(null);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!called) return;
    // Only fire on a genuine change of who is being called. The board polls
    // every five seconds and would otherwise re-announce the same patient.
    if (lastKey.current === called.key) return;

    const first = lastKey.current === null;
    lastKey.current = called.key;

    /*
      A board that has just been switched on must not shout the call that was
      already outstanding — that summons happened minutes ago and the patient
      is long since in the room.

      Judged on the call's AGE rather than simply "is this the first one we
      have seen", because the first call a board observes is very often a
      real, live one: staff open this screen at the start of a clinic and the
      very next thing that happens is a patient being called.
    */
    if (first && Date.now() - called.calledAt > STALE_CALL_MS) return;

    setShown(called);
    chime();
    if (voiceAvailable(speechLang)) {
      // After the chime, so the two do not overlap.
      const t = setTimeout(
        () =>
          speak(
            announcementText(called.displayNo, called.doctorName, called.room),
            speechLang,
          ),
        1100,
      );
      return () => clearTimeout(t);
    }
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
          hasVoice
            ? "Chime and voice announcement are on"
            : `Chime is on. No ${speechLang} voice is installed on this machine, so names are shown but not spoken.`
        }
      >
        <IconSpeaker className="h-5 w-5" />
        {hasVoice ? "Sound on" : "Chime only"}
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
