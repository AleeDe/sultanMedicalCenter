/*
  Generates a soft ambient bed for the demo.

  Synthesised with ffmpeg rather than sourced, so there is no licence to
  track and it can be regenerated to any length. The aim is something that
  sits well under a voice and is not noticed: a slow chord that breathes,
  no melody to compete with the narration, no percussion to date it.

  Usage: node demo/music.mjs <seconds> <outfile>
*/
import { spawnSync } from "node:child_process";

const seconds = Number(process.argv[2] ?? 90);
const out = process.argv[3] ?? "demo/out/music.wav";

/*
  An A-flat major 9 voicing, spread wide. Low root for weight, the third and
  fifth for warmth, ninth on top for a modern, unresolved feel that does not
  demand attention.

  Each partial is detuned a few cents and given its own slow tremolo, so the
  chord shimmers instead of sitting still — a perfectly static sine stack
  reads as a test tone.
*/
/*
  A single held chord turned out to be the problem with the first pass: it was
  inoffensive but inert, and a bed with no movement gives a film no lift.

  So the harmony now MOVES — two alternating voicings, Abmaj9 and Fm9, each
  fading in as the other fades out. They share three notes, so the change is
  a colour shift rather than a chord change, but it gives the piece a slow
  rise and fall underneath the narration.

  ffmpeg's tremolo bottoms out at 0.1 Hz, so the rates sit just above that
  floor and are mutually prime enough not to pulse in lockstep.
*/
const CHORD_A = [
  { hz: 103.83, gain: 0.30, trem: 0.11 }, // Ab2  root
  { hz: 155.56, gain: 0.20, trem: 0.17 }, // Eb3  fifth
  { hz: 207.65, gain: 0.16, trem: 0.13 }, // Ab3  octave
  { hz: 261.63, gain: 0.13, trem: 0.19 }, // C4   third
  { hz: 311.13, gain: 0.10, trem: 0.15 }, // Eb4  fifth
  { hz: 466.16, gain: 0.07, trem: 0.23 }, // Bb4  ninth
];

const CHORD_B = [
  { hz: 87.31, gain: 0.30, trem: 0.12 }, // F2   root
  { hz: 155.56, gain: 0.18, trem: 0.16 }, // Eb3  seventh  (shared)
  { hz: 207.65, gain: 0.15, trem: 0.14 }, // Ab3  third    (shared)
  { hz: 261.63, gain: 0.12, trem: 0.21 }, // C4   fifth    (shared)
  { hz: 349.23, gain: 0.09, trem: 0.18 }, // F4   octave
  { hz: 466.16, gain: 0.06, trem: 0.25 }, // Bb4  eleventh
];

const PARTIALS = [...CHORD_A, ...CHORD_B];
// One full A→B→A cycle per this many seconds.
const CYCLE = 24;

const inputs = [];
const filters = [];

PARTIALS.forEach((p, i) => {
  const inB = i >= CHORD_A.length;
  inputs.push(
    "-f", "lavfi",
    "-t", String(seconds),
    "-i", `sine=frequency=${p.hz}:sample_rate=48000`,
  );

  /*
    Each chord is gated by a slow cosine that peaks while the other is at its
    trough, so the two voicings breathe in and out of each other. Written as
    a volume expression because ffmpeg has no crossfade that repeats.

    0.5+0.5*cos(...) stays in [0,1]; chord B is offset by half a cycle.
  */
  const phase = inB ? "+PI" : "";
  const swell = `(0.15+0.85*(0.5+0.5*cos(2*PI*t/${CYCLE}${phase})))`;

  filters.push(
    `[${i}:a]tremolo=f=${p.trem}:d=0.28,` +
      `volume='${p.gain}*${swell}':eval=frame[p${i}]`,
  );
});

const mixIn = PARTIALS.map((_, i) => `[p${i}]`).join("");

const chain =
  `${filters.join(";")};` +
  `${mixIn}amix=inputs=${PARTIALS.length}:normalize=0[chord];` +
  // Roll off the top so it never competes with speech consonants, and the
  // very bottom so it does not muddy small laptop speakers.
  `[chord]highpass=f=70,lowpass=f=2600,` +
  // Long fades top and tail — an ambient bed that starts abruptly is jarring.
  `afade=t=in:st=0:d=2.5,afade=t=out:st=${(seconds - 3).toFixed(2)}:d=3,` +
  `volume=0.5,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[out]`;

const r = spawnSync(
  "ffmpeg",
  ["-y", ...inputs, "-filter_complex", chain, "-map", "[out]", out],
  { encoding: "utf8" },
);

if (r.status !== 0) {
  console.error((r.stderr ?? "").split("\n").slice(-15).join("\n"));
  process.exit(1);
}
console.log(`music: ${out} (${seconds}s)`);
