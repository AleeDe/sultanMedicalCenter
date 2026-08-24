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

  WHOLE PHRASES, NOT WORDS

  An earlier version of this stitched ~14 single-word clips ("token", "two",
  "room") into a sentence. It never stopped sounding assembled, and the
  reason is not something gap tuning can reach — measuring the pitch of each
  clip shows it plainly:

      token 279 Hz | two 225 | five 225 | one 222 | seven 275 | room 256

  Each word was synthesised alone, so each carried its own intonation
  contour. Real speech runs ONE contour across a phrase and lets it fall at
  the end; isolated words can be matched for loudness and spacing — both of
  which that version did — but they cannot be given a shared melody.

  So the announcement is two whole phrases instead:

      "Token number, two, five, one, seven."     <- one clip per token
      "Please proceed to room number one."       <- one clip per room

  Each is a complete sentence with its own natural fall, and they are
  independent, so 300 tokens and 8 rooms cost 308 clips rather than 2,400.
  One join, at a sentence boundary where a speaker would pause anyway.
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
 * Returns null when the clip does not exist — which is a normal condition,
 * not an error: the build renders a fixed number of token numbers, and a
 * clinic busier than that will ask for one past the end.
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

    // Bounded: a board left running for weeks would otherwise hold every
    // announcement of every day.
    if (clips.size >= 400) {
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
  phraseVoice = (await clip("t1")) !== null && (await clip("r1")) !== null;
  return phraseVoice;
}

/**
 * The two clip ids for a call.
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
export function clipIds(
  displayNo: string,
  room: string | null,
): { token: string; tokenAlt: string | null; room: string } | null {
  const m = /^(.*?)[-\s]?([0-9]+)$/.exec(displayNo);
  if (!m) return null;

  // Leading zeros are not spoken: nobody says "zero zero zero two two".
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n < 1) return null;

  /*
    An emergency token gets the variant that leads with the flag, which
    explains to everyone else why this call jumped the queue.

    The plain variant is offered as a second choice rather than treating a
    missing emergency clip as failure: emergency clips are rendered over a
    much smaller range (they are rare), so a high emergency number would
    otherwise drop all the way to the synthetic browser voice when the
    correct number is sitting right there, only without the flag word.
  */
  const emergency = /^ER/i.test(displayNo);
  const token = `${emergency ? "e" : "t"}${n}`;
  const tokenAlt = emergency ? `t${n}` : null;

  // "Room 3" -> r3. A token with no room falls back to the reception line
  // rather than to silence.
  const digits = room ? /(\d+)/.exec(room)?.[1] : null;
  return { token, tokenAlt, room: `r${digits ?? 0}` };
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

  const [firstChoice, roomClip] = await Promise.all([
    clip(ids.token),
    clip(ids.room),
  ]);
  let tokenClip = firstChoice;

  // An emergency number past the rendered emergency range still announces,
  // using the plain token clip. Losing the word "Emergency" is a far smaller
  // loss than dropping to a synthetic voice, or to nothing.
  if (!tokenClip && ids.tokenAlt) tokenClip = await clip(ids.tokenAlt);

  // The token half is the part that cannot be improvised. Without it there
  // is no announcement worth making, so fall back rather than play half.
  if (!tokenClip) return 0;

  /*
    Scheduled on the audio clock rather than with a timer.

    The second phrase must begin a fixed moment after the first ends, and
    setTimeout drifts by several milliseconds — audible here as a join that
    wobbles from one call to the next.

    The gap is a real pause because both clips are trimmed to their first and
    last sound (see scripts/normalise-voice.py); it is not stacked on top of
    Piper's own padding the way an untrimmed clip's would be.
  */
  const GAP = 0.25;

  const start = a.currentTime + 0.06;
  let at = start;
  for (const buf of [tokenClip, roomClip]) {
    if (!buf) continue;
    const src = a.createBufferSource();
    src.buffer = buf;
    src.connect(a.destination);
    src.start(at);
    at += buf.duration + GAP;
  }

  // How long the whole thing runs, less the trailing gap that was added
  // after the final clip.
  return at - GAP - start;
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
