/*
  Calling a patient's turn out loud.

  Three parts, deliberately separable because they fail independently:

    1. A chime. Always works — it is synthesised with WebAudio, so there is
       no asset to 404 and no codec to be missing. This is the part that
       actually turns heads; the visual card does the rest.

    2. Speech, but ONLY when a voice plausibly matching the name's language
       is installed. A clinic PC almost never has an Urdu voice, and an
       English voice reading an Urdu name aloud is worse than silence — it
       mispronounces the one word the patient is listening for.

    3. The visual card, which lives in the board component.

  Browsers block audio until the user has interacted with the page, and the
  waiting-room TV is never touched. That is why the board shows an explicit
  "Enable sound" affordance once, rather than silently failing forever.
*/

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** True once the browser will actually let us make noise. */
export async function unlockAudio(): Promise<boolean> {
  const a = audio();
  if (!a) return false;
  if (a.state === "suspended") {
    try {
      await a.resume();
    } catch {
      return false;
    }
  }
  return a.state === "running";
}

export function audioReady(): boolean {
  return audio()?.state === "running";
}

/**
 * A two-note chime, the interval used by public-address systems everywhere.
 *
 * Synthesised rather than sampled: a sine pair with a soft envelope carries
 * over room noise without being harsh, and it costs no network request on a
 * TV that may be on a slow clinic connection.
 */
export function chime() {
  const a = audio();
  if (!a || a.state !== "running") return;

  const now = a.currentTime;
  // A perfect fourth (G5 -> C6): attention-getting without sounding alarming,
  // which matters in a room where an alarm means something else entirely.
  [784, 1046.5].forEach((freq, i) => {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;

    const t0 = now + i * 0.18;
    // Exponential decay, never to exactly zero — a hard stop clicks.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.75);

    osc.connect(gain).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + 0.8);
  });
}

/*
  The announcement voice.

  Rendered ahead of time, not synthesised in the browser.

  `speechSynthesis` on a clinic PC offers whatever Microsoft ships — David,
  Mark, Zira — all unmistakably synthetic. scripts/build-voice.mjs replaces
  them with a real voice (Piper en_GB-cori-high) rendered at build time and
  shipped as MP3, so the board sounds the same on every machine and needs no
  network, no API key, and no per-call cost.

  WHOLE PHRASES WHERE THEY ARE FIXED, DIGITS WHERE THEY VARY

      "Token number,"  +  "seven," "zero," "five,"  +
      "Please proceed to room number four."

  Two earlier versions failed in opposite directions, and the current shape
  is what is left after both.

  The first stitched EVERY word, "token" and "room" included, and never
  stopped sounding assembled. Measuring the pitch of each clip shows why:

      token 279 Hz | two 225 | five 225 | one 222 | seven 275 | room 256

  Words synthesised alone each carry their own intonation contour, and no
  amount of loudness matching or gap tuning gives them a shared melody.

  The second rendered one clip per WHOLE token number, which sounded better
  but imposed a ceiling — and production ran straight past it. Token 705 was
  called when only 300 had been rendered, so the board fell through to the
  browser's own voice: a male SAPI voice, the exact robotic sound this
  module exists to avoid. Any fixed range would have hit that wall
  eventually, and rendering 1..9999 would cost 181 MB.

  So the fixed parts of the sentence stay whole, and only the digits — the
  part that genuinely varies — are separate. Each digit is rendered with a
  trailing comma, which keeps its pitch raised the way a speaker's stays up
  mid-number, so the figures run together instead of landing as separate
  answers. Fifteen clips cover every token number there will ever be.
*/

const CLIP_BASE = "/voice";

/** Decoded phrase clips, keyed by clip id. Fetched once, then reused. */
const clips = new Map<string, AudioBuffer>();

/*
  Whether the rendered voice is usable at all.

  Probed once when sound is enabled rather than assumed, so the board knows
  which voice it has BEFORE the first patient is called. Discovering at the
  moment of a summons that the clips are missing would cost a failed fetch
  in the pause after the chime, exactly where the delay is audible.
*/
let phraseVoice = false;

export function phraseVoiceReady(): boolean {
  return phraseVoice;
}

/**
 * Fetches and decodes one clip, remembering it for next time.
 *
 * Returns null when the clip does not exist or cannot be decoded, so callers
 * can fall back rather than announce a sentence with a hole in it.
 */
async function clip(id: string): Promise<AudioBuffer | null> {
  const cached = clips.get(id);
  if (cached) return cached;

  const a = audio();
  if (!a) return null;

  try {
    const res = await fetch(`${CLIP_BASE}/${id}.mp3`);
    if (!res.ok) return null;
    const buf = await a.decodeAudioData(await res.arrayBuffer());

    // The whole vocabulary is ~20 clips, so this never evicts in practice;
    // the bound is here so a future addition cannot turn the cache into a
    // slow leak on a board that runs for weeks.
    if (clips.size >= 100) {
      const oldest = clips.keys().next().value;
      if (oldest !== undefined) clips.delete(oldest);
    }
    clips.set(id, buf);
    return buf;
  } catch {
    return null;
  }
}

/**
 * Confirms the rendered voice is present and decodable.
 *
 * Decodes a real clip rather than merely checking it 404s: audio the browser
 * cannot decode is not usable audio, and finding that out here is far better
 * than finding it out mid-announcement.
 */
export async function loadVoice(): Promise<boolean> {
  phraseVoice = (await clip("tok")) !== null && (await clip("r1")) !== null;
  return phraseVoice;
}

/**
 * Re-checks the rendered voice after it was found missing.
 *
 * The probe runs once, on the gesture that unlocks audio, and a board is
 * then left alone for weeks. Without this, a single failure at that moment —
 * a slow first load, or a deploy landing mid-session so the clips being
 * asked for briefly do not exist — would pin the board to the browser's
 * synthetic voice for the rest of the day even after everything recovered.
 *
 * Cheap to retry: the clips are ~20 small files, and once one decodes the
 * rest come from cache.
 */
export async function retryVoice(): Promise<boolean> {
  if (phraseVoice) return true;
  // Drop any negative result so the fetch is actually attempted again.
  clips.delete("tok");
  clips.delete("r1");
  return loadVoice();
}

/**
 * The clips to play for a call, in order.
 *
 * Mirrors the announcement's priorities: the token number leads because it
 * is what the patient holds in their hand and matches, the room follows
 * because it is the instruction.
 *
 * The patient's NAME is deliberately absent. A waiting room is a public
 * space and the name is the identifying part, while the token number picks
 * out exactly one person without announcing who they are to everyone. The
 * board shows the name in full for whoever needs to check it.
 */
export function clipIds(displayNo: string, room: string | null): string[] | null {
  const m = /^(.*?)[-\s]?([0-9]+)$/.exec(displayNo);
  if (!m) return null;

  // Leading zeros are not spoken: nobody says "zero zero zero seven, zero,
  // five" for token 00705.
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n < 1) return null;

  // An emergency token leads with the flag, which explains to everyone else
  // why this call jumped the queue.
  const seq = [/^ER/i.test(displayNo) ? "emg" : "tok"];

  for (const d of String(n)) seq.push(`d${d}`);

  // "Room 3" -> r3. A token with no room is sent to reception rather than
  // left with an announcement that says nothing about where to go.
  const roomDigits = room ? /(\d+)/.exec(room)?.[1] : null;
  seq.push(`r${roomDigits ?? 0}`);

  return seq;
}

/**
 * Plays the announcement.
 *
 * Returns how many SECONDS it will take, or 0 when it could not play — a
 * token number past the rendered range, or clips that failed to load — so
 * the caller can fall back to browser speech rather than leave the call
 * silent.
 *
 * The duration matters because announcements are queued: when two doctors
 * call at once the board must wait for one to finish before starting the
 * next, and playback is scheduled ahead on the audio clock rather than
 * awaited, so there is no completion event to listen for.
 */
export async function speakAnnouncement(
  displayNo: string,
  room: string | null,
): Promise<number> {
  const a = audio();
  if (!a || a.state !== "running") return 0;

  const ids = clipIds(displayNo, room);
  if (!ids) return 0;

  const buffers = await Promise.all(ids.map(clip));

  // Every clip must be present. A missing one would leave a hole in the
  // middle of a number — "seven, ..., five" — which is worse than announcing
  // in a plainer voice, because the patient cannot tell a digit was lost.
  if (buffers.some((b) => !b)) return 0;

  /*
    Scheduled on the audio clock rather than with timers.

    Each clip must begin a fixed moment after the last one ends, and
    setTimeout drifts by several milliseconds per call — across a
    five-clip announcement that is audible as an unsteady rhythm.

    The gaps are real pauses because every clip is trimmed to its first and
    last sound (see scripts/normalise-voice.py); they are not stacked on top
    of Piper's own padding the way untrimmed clips' would be.
  */
  // Between consecutive digits: tight, so they read as one number rather
  // than a list of separate figures.
  const DIGIT_GAP = 0.06;
  // After "Token number," — a beat before the figures start.
  const LEAD_GAP = 0.16;
  // Before the room instruction, where a speaker would draw breath.
  const BREATH = 0.3;

  const start = a.currentTime + 0.06;
  let at = start;

  ids.forEach((id, i) => {
    const buf = buffers[i];
    if (!buf) return;
    const src = a.createBufferSource();
    src.buffer = buf;
    src.connect(a.destination);
    src.start(at);

    // The gap that FOLLOWS this clip depends on what comes next, which is
    // why it is chosen from the next id rather than this one.
    const next = ids[i + 1];
    let gap = 0;
    if (next === undefined) gap = 0;
    else if (next.startsWith("r")) gap = BREATH;
    else if (id === "tok" || id === "emg") gap = LEAD_GAP;
    else gap = DIGIT_GAP;

    at += buf.duration + gap;
  });

  return at - start;
}

/*
  Speech.

  We only speak when a voice for the requested language actually exists.
  `speechSynthesis` will happily accept lang="ur-PK", find nothing, and read
  the text with the default English voice — which is the failure mode this
  guard exists to prevent.
*/
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const tag = lang.toLowerCase();
  const primary = tag.split("-")[0];

  return (
    // Exact match first: ur-PK before ur-IN.
    voices.find((v) => v.lang.toLowerCase() === tag) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(primary + "-")) ??
    voices.find((v) => v.lang.toLowerCase() === primary) ??
    /*
      Then Hindi, which is the useful fallback rather than an arbitrary one.
      Windows ships no Urdu voice at all, but Hindi shares most of the
      phoneme inventory, so a Pakistani name comes out far closer than an
      English voice manages.
    */
    voices.find((v) => v.lang.toLowerCase().startsWith("hi")) ??
    /*
      Finally any voice at all.

      This used to return null here, and the board then said nothing. That
      was the wrong trade for a waiting room: the announcement exists to make
      someone who has stopped watching the screen look up, and an imperfectly
      pronounced call still does that — silence does not. The token number is
      digits, which every voice reads correctly, and the screen carries the
      name in full for anyone who needs to check it.
    */
    voices.find((v) => v.default) ??
    voices[0] ??
    null
  );
}

export function voiceAvailable(lang: string): boolean {
  return pickVoice(lang) !== null;
}

/**
 * Speaks the call, if a matching voice exists. Returns false when it
 * declined, so the caller can fall back to the chime alone.
 */
export function speak(text: string, lang: string): boolean {
  const voice = pickVoice(lang);
  if (!voice || typeof speechSynthesis === "undefined") return false;

  // Never queue announcements: if two patients are called in quick
  // succession, the second is the true state of the room and the first is
  // already wrong.
  speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  // Slower than default: this is heard once, across a room, by someone who
  // may not be listening yet.
  u.rate = 0.85;
  u.pitch = 1;
  u.volume = 1;
  speechSynthesis.speak(u);
  return true;
}

/**
 * Reads a token number the way a person would say it.
 *
 * "NORM-042" spoken literally becomes "norm dash zero four two", which is
 * both wrong and hard to match against a printed slip. Digits are spaced so
 * they are read individually, and a leading zero is dropped.
 */
export function spokenToken(displayNo: string): string {
  const m = /^(.*?)[-\s]?([0-9]+)$/.exec(displayNo);
  if (!m) return displayNo;
  const [, , digits] = m;
  return String(Number(digits)).split("").join(" ");
}

/**
 * The spoken announcement line.
 *
 * The token number ONLY — deliberately never the patient's name. A waiting
 * room is a public space and the name is the identifying part; the digits
 * are what the patient matches against the slip in their hand, and they
 * identify the right person without telling the whole room who that is.
 *
 * The name still appears on the screen card, where it is read by the one
 * person looking for it rather than broadcast to everyone.
 */
export function announcementText(
  displayNo: string,
  doctorName: string | null,
  room: string | null,
): string {
  /*
    Ordered the way it is actually used, not the way the data is shaped.

    The token number leads because that is what a patient holds in their hand
    and matches; it is also digits, which every voice reads correctly. Where
    to go comes next, because that is the instruction. The doctor's name is
    last and optional — useful confirmation, but nobody stands up because of
    it.

    The patient's NAME is deliberately absent. A waiting room is a public
    space and the name is the identifying part, while the token number picks
    out exactly one person without announcing who they are to everyone. The
    screen shows the name in full for anyone who needs to check.
  */
  const parts = [`Token ${spokenToken(displayNo)}`];
  if (room) parts.push(`please proceed to ${room}`);
  if (doctorName) parts.push(doctorName.replace(/^Dr\.?\s*/i, "Doctor "));
  return parts.join(", ") + ".";
}
