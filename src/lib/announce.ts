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
    voices.find((v) => v.lang.toLowerCase() === tag) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(primary + "-")) ??
    voices.find((v) => v.lang.toLowerCase() === primary) ??
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
  room: string | null,
): string {
  const parts = [`Token ${spokenToken(displayNo)}`];
  if (room) parts.push(`please proceed to ${room}`);
  return parts.join(", ") + ".";
}
