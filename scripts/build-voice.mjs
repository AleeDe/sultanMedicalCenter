/*
  Renders the waiting-room announcement voice.

  WHY THIS EXISTS

  The board announces through the browser by default, and on a clinic PC that
  means a Microsoft SAPI voice — David, Mark or Zira, all unmistakably
  synthetic. This script replaces them with a real rendered voice that ships
  with the app.

  WHAT IS RENDERED

  Fifteen clips, assembled at call time into:

      "Token number,"  +  "seven," "zero," "five,"  +
      "Please proceed to room number four."

  An earlier version rendered one clip per WHOLE token number, which sounded
  slightly better but imposed a ceiling — and production ran straight past
  it. Token 705 was called when only 300 had been rendered, so the board fell
  through to the browser's own voice: a male SAPI voice, the exact robotic
  sound this script exists to replace. Any fixed range would have hit that
  wall eventually, and covering 1..9999 would cost 181 MB and six hours.

  An even earlier version stitched every WORD separately, including "token"
  and "room", and never stopped sounding assembled. Measuring pitch showed
  why:

      token 279 Hz | two 225 | five 225 | one 222 | seven 275 | room 256

  Words synthesised in isolation each carry their own intonation contour, and
  no spacing or loudness matching gives them a shared melody. So the fixed
  parts of the sentence stay whole — only the digits, which genuinely vary,
  are separate, and each is rendered with a trailing comma so its pitch stays
  raised and they run together as one figure.

  WHY THIS BEATS AN API

  It needs no key, no network, and no per-call cost, and it works on Vercel
  where a Python runtime is not available: everything is rendered here at
  build time and shipped as MP3.

  Usage:
    node scripts/build-voice.mjs
    node scripts/build-voice.mjs --voice en_US-amy-medium
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
 * Digit names.
 *
 * A token is read one digit at a time — "705" is "seven, zero, five", not
 * "seven hundred and five". The patient is matching figures printed on a
 * slip, one character at a time, and a quantity is harder to match than the
 * figures themselves.
 */
const WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/* The lines to render. */
const lines = [];

/*
  The lead-in and the ten digits, rendered separately.

  This is what removes the ceiling. Rendering one clip per whole token number
  meant a fixed range, and production had already run past it: token 705 was
  called when only 300 had been rendered, so the board fell through to the
  browser's own voice — a male SAPI voice reading the number, which is
  exactly the robotic sound this whole exercise set out to remove.

  Any range would have hit the same wall eventually; covering 1..9999 would
  cost 181 MB and six hours of rendering. Fifteen clips cover every number
  there will ever be.

  Each digit is rendered WITH A TRAILING COMMA. That is the load-bearing
  detail: a comma keeps the pitch up, the way a speaker's voice stays raised
  mid-number, so the digits run together as one figure. A digit synthesised
  alone gets the falling, finished contour of an answer to a question — play
  four of those in a row and they sound like four separate numbers, which is
  what made an earlier word-by-word version sound like a machine reading a
  list.
*/
lines.push({ id: "tok", text: "Token number," });

// Emergency tokens lead with the flag, which explains to everyone else why
// this call jumped the queue.
lines.push({ id: "emg", text: "Emergency. Token number," });

WORD.forEach((w, i) => {
  lines.push({ id: `d${i}`, text: `${w},` });
});

for (let r = 1; r <= MAX_ROOM; r++) {
  lines.push({ id: `r${r}`, text: `Please proceed to room number ${WORD[r] ?? r}.` });
}

lines.push({ id: "r0", text: "Please proceed to the reception desk." });

console.log(
  `voice: Piper ${MODEL}   pace=${PACE}\n` +
    `lines: ${lines.length}  (lead-ins, 10 digits, ${MAX_ROOM} rooms)`,
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
