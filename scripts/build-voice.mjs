/*
  Renders the waiting-room announcement voice.

  WHY THIS EXISTS

  The board announces through the browser by default, and on a clinic PC that
  means a Microsoft SAPI voice — David, Mark or Zira, all unmistakably
  synthetic. This script replaces them with a real rendered voice that ships
  with the app.

  WHY WHOLE PHRASES, NOT WORDS

  An earlier version of this rendered ~14 single words ("token", "two",
  "room") and stitched them at call time. It worked, and it never stopped
  sounding assembled. Measuring the pitch of each clip shows why:

      token 279 Hz | two 225 | five 225 | one 222 | seven 275 | room 256

  Every word was synthesised in isolation, so every word carried its own
  intonation contour. Real speech runs ONE contour across a phrase and lets
  it fall at the end. Stitched words can be matched for loudness and spacing
  — both of which that version did — but they cannot be given a shared
  melody, so the result always read as a machine reciting a list.

  So this renders whole PHRASES instead. The announcement has exactly two
  variable parts and they are independent:

      "Token number, two, five, one, seven."   <- one per token number
      "Please proceed to room number one."     <- one per room

  Each is a complete sentence with its own natural intonation, and the board
  plays two of them back to back. One join instead of eight, and that join
  falls at a sentence boundary where a real speaker pauses anyway.

  WHY THIS BEATS AN API

  It needs no key, no network, and no per-call cost, and it works on Vercel
  where a Python runtime is not available: everything is rendered here at
  build time and shipped as MP3.

  Usage:
    node scripts/build-voice.mjs              # default: 300 tokens
    node scripts/build-voice.mjs --max 500    # busier clinic
*/
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

/*
  The voice: a British female, chosen by ear against the alternatives.

  A `-high` model rather than `-medium`. These are rendered once at build
  time and then only ever played back, so the extra synthesis cost is paid
  by the developer and never by the clinic.
*/
const MODEL = flag("voice", "en_GB-cori-high");

/*
  How many token numbers to render.

  The clinic's own history is the guide: this database averages 14 tokens a
  day and has never exceeded 35, and the series resets at midnight. 300
  therefore covers a day roughly ten times busier than any yet seen, and the
  board falls back gracefully past it (see the fallback chain in
  NowServing.tsx) rather than going silent.
*/
const MAX_TOKEN = Number(flag("max", "300"));

/*
  Emergency tokens are rendered over a much smaller range than normal ones.

  They are a separate series that also resets daily, and this clinic's
  history tops out at 5 in a day against 35 normal tokens — an emergency is
  by nature rare. Rendering 300 of them doubled the shipped size for clips
  that would essentially never play; 40 is already several times the worst
  day on record, and anything past it falls back like any other out-of-range
  token.
*/
const MAX_EMERGENCY = Number(flag("emergency", "40"));

/** Rooms to render. Read from the database would couple a build step to a
    live connection; these are stable and cheap to over-cover. */
const MAX_ROOM = Number(flag("rooms", "8"));

/*
  Pace.

  Slower than conversation. This is heard once, across a room, over noise, by
  someone who is not yet listening — the same reason a station announcement
  is slower than the announcer's own speech.
*/
const PACE = Number(flag("pace", "1.15"));

const VOICES = path.join(ROOT, "demo", "voices");
const OUT = path.join(ROOT, "public", "voice");

if (!existsSync(path.join(VOICES, `${MODEL}.onnx`))) {
  console.error(
    `Voice not installed. Run:\n` +
      `  pip install piper-tts\n` +
      `  python -m piper.download_voices ${MODEL} --data-dir demo/voices`,
  );
  process.exit(1);
}

/**
 * Digits, read out one at a time and separated by commas.
 *
 * "22" becomes "two, two" rather than "twenty two". A patient is matching
 * against digits printed on a slip, one character at a time, and a quantity
 * is harder to match than the figures themselves.
 *
 * The commas are load-bearing: they are what make the voice pause between
 * digits, which is the difference between a number that can be caught across
 * a noisy room and one that cannot.
 */
const WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function digits(n) {
  return String(n)
    .split("")
    .map((d) => WORD[Number(d)])
    .join(", ");
}

/*
  The lines to render.

  Two families, deliberately kept independent so the count stays small: any
  token can be followed by any room, and rendering them separately means
  300 + 8 clips instead of 300 x 8 = 2,400.
*/
const lines = [];

for (let n = 1; n <= MAX_TOKEN; n++) {
  // A full stop, not a comma: this half is a complete sentence, so the pitch
  // falls at the end the way a speaker's would.
  lines.push({ id: `t${n}`, text: `Token number, ${digits(n)}.` });
}

for (let n = 1; n <= MAX_EMERGENCY; n++) {
  // Emergency tokens lead with the flag, which explains to everyone else why
  // this call jumped the queue.
  lines.push({ id: `e${n}`, text: `Emergency. Token number, ${digits(n)}.` });
}

for (let r = 1; r <= MAX_ROOM; r++) {
  lines.push({ id: `r${r}`, text: `Please proceed to room number ${WORD[r] ?? r}.` });
}

// Spoken when a token has no room assigned — rare, but it must not be silent.
lines.push({ id: "r0", text: "Please proceed to the reception desk." });

console.log(
  `voice: Piper ${MODEL}   pace=${PACE}\n` +
    `lines: ${lines.length}  (${MAX_TOKEN} tokens x2, ${MAX_ROOM} rooms)`,
);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// speak.py reads a JSON file rather than stdin: on Windows a piped stream is
// decoded with the ANSI codepage, which mangles non-ASCII text. Kept for
// consistency with the demo build, which hit exactly that.
const linesFile = path.join(OUT, "_lines.json");
writeFileSync(linesFile, JSON.stringify(lines, null, 2), "utf-8");

const r = spawnSync(
  "python",
  [
    path.join(ROOT, "demo", "speak.py"),
    "--model", MODEL,
    "--data-dir", VOICES,
    "--lines", linesFile,
    "--field", "text",
    "--out-dir", OUT,
    "--length-scale", String(PACE),
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (r.status !== 0) {
  console.error(r.stdout || "piper failed");
  process.exit(1);
}

rmSync(linesFile, { force: true });

/*
  Trim and level-match, then compress.

  Piper pads each utterance with silence and normalises it to peak
  independently; both would be audible once two phrases are played back to
  back. See normalise-voice.py.
*/
const norm = spawnSync(
  "python",
  [path.join(ROOT, "scripts", "normalise-voice.py"), "--dir", OUT, "--quiet"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (norm.status !== 0) {
  console.error(norm.stdout || "normalise failed");
  process.exit(1);
}

/*
  WAV to MP3.

  These are speech at 22 kHz, which compresses about 7:1 at 48 kbps with no
  audible loss over a waiting-room speaker. It is the difference between
  ~28 MB of WAV in the repository and ~4 MB of MP3.
*/
console.log("encoding mp3...");
let encoded = 0;
for (const f of readdirSync(OUT)) {
  if (!f.endsWith(".wav")) continue;
  const wav = path.join(OUT, f);
  const mp3 = wav.replace(/\.wav$/, ".mp3");
  const e = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", wav,
     "-codec:a", "libmp3lame", "-b:a", "48k", "-ar", "22050", "-ac", "1", mp3],
    { encoding: "utf8" },
  );
  if (e.status !== 0) {
    console.error(`ffmpeg failed on ${f}:\n${e.stderr}`);
    process.exit(1);
  }
  rmSync(wav);
  encoded++;
}

// Every line must have produced real audio; a silent clip would leave a hole
// in an announcement that nobody would notice until a patient missed a turn.
let total = 0;
for (const line of lines) {
  const f = path.join(OUT, `${line.id}.mp3`);
  if (!existsSync(f)) {
    console.error(`missing clip: ${line.id}`);
    process.exit(1);
  }
  const size = statSync(f).size;
  if (size < 1200) {
    console.error(`clip is silent: ${line.id} (${size} bytes)`);
    process.exit(1);
  }
  total += size;
}

console.log(
  `${encoded} clips -> public/voice  (${(total / 1024 / 1024).toFixed(1)} MB)`,
);
