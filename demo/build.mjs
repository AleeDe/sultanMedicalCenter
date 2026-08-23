/*
  Builds the finished demo video.

    1. picks a real returning patient out of the database
    2. speaks each narration line to a .wav via Windows SAPI
    3. records the walkthrough by driving the real app
    4. lays the narration over the video and burns in subtitles

  Usage:
    node --env-file=.env.local demo/build.mjs            (Urdu voice if present)
    node --env-file=.env.local demo/build.mjs --voice Zira
    node --env-file=.env.local demo/build.mjs --no-voice (subtitles only)

  The app must already be running on http://localhost:3000.
*/
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { assemble, INTRO, OUTRO } from "./edit.mjs";
import { speakAll, quota, SUGGESTED } from "./elevenlabs.mjs";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "demo", "out");
const VOICE_DIR = path.join(OUT, "vo");
const argv = process.argv.slice(2);
const NO_VOICE = argv.includes("--no-voice");
const VOICE_ARG = argv.includes("--voice")
  ? argv[argv.indexOf("--voice") + 1]
  : null;
// ElevenLabs when a key is present (most natural, carries emotion), Piper
// otherwise (offline, free, but flat). --piper forces the offline path.
const USE_ELEVEN =
  !argv.includes("--piper") &&
  !argv.includes("--sapi") &&
  !VOICE_ARG &&
  Boolean(process.env.ELEVENLABS_API_KEY);
const USE_PIPER = !USE_ELEVEN && !argv.includes("--sapi") && !VOICE_ARG;
const PIPER_PACE = argv.includes("--pace")
  ? Number(argv[argv.indexOf("--pace") + 1])
  : 1.25;
const NO_MUSIC = argv.includes("--no-music");
const ELEVEN_MODEL = argv.includes("--model")
  ? argv[argv.indexOf("--model") + 1]
  : "eleven_v3";
const ELEVEN_SPEED = argv.includes("--speed")
  ? Number(argv[argv.indexOf("--speed") + 1])
  : 0.94;

mkdirSync(OUT, { recursive: true });
mkdirSync(VOICE_DIR, { recursive: true });

/* ------------------------------------------------------------ narration */

/*
  The script lives in demo/lines.json, with each line in two forms:

    urdu  — Nastaliq, spoken by Piper's Pakistani Urdu voice
    roman — Roman Urdu, used for the subtitles and for SAPI fallback

  Keeping both matters: feeding Roman Urdu to any TTS is the worst option,
  because the engine applies English letter-to-sound rules and mangles it.
  Subtitles stay Roman so staff who do not read Nastaliq can still follow.
*/
const LINES = JSON.parse(
  readFileSync(path.join(ROOT, "demo", "lines.json"), "utf8"),
);

/* --------------------------------------------------------------- helpers */

function ps(script) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  ).trim();
}

function pickVoice() {
  if (NO_VOICE) return null;
  const raw = ps(
    "Add-Type -AssemblyName System.Speech;" +
      "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |" +
      "%{ $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }",
  );
  const voices = raw.split(/\r?\n/).filter(Boolean).map((l) => {
    const [name, culture] = l.split("|");
    return { name, culture };
  });

  if (VOICE_ARG) {
    const hit = voices.find((v) =>
      v.name.toLowerCase().includes(VOICE_ARG.toLowerCase()),
    );
    if (!hit) {
      console.error(`Voice "${VOICE_ARG}" not found. Installed:`);
      voices.forEach((v) => console.error(`  ${v.name} (${v.culture})`));
      process.exit(1);
    }
    return hit;
  }

  // Prefer Urdu, then Hindi (close enough phonetically for Roman Urdu), then
  // whatever English voice exists.
  return (
    voices.find((v) => /^ur/i.test(v.culture)) ??
    voices.find((v) => /^hi/i.test(v.culture)) ??
    voices[0] ??
    null
  );
}

function speak(voice, text, outFile) {
  const esc = (s) => s.replace(/'/g, "''");
  ps(
    "Add-Type -AssemblyName System.Speech;" +
      "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
      `$s.SelectVoice('${esc(voice.name)}');` +
      "$s.Rate=-1;" +
      `$s.SetOutputToWaveFile('${esc(outFile)}');` +
      `$s.Speak('${esc(text)}');` +
      "$s.Dispose()",
  );
}

function durationOf(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration",
     "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return parseFloat(out.trim());
}

/** ffmpeg writes its diagnostics to stderr; surface them instead of a buffer. */
function ffmpeg(args) {
  // cwd = OUT so the subtitle file can be referenced by bare name.
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", cwd: OUT });
  if (r.status !== 0) {
    const tail = (r.stderr ?? "").split(/\r?\n/).filter(Boolean).slice(-25);
    console.error("\nffmpeg failed:\n" + tail.join("\n") + "\n");
    process.exit(1);
  }
}

function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const f = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${f}`;
}

/**
 * Splits one narration line into readable subtitle cues.
 *
 * Long lines become several cues shown in sequence rather than one wall of
 * text: a caption that fills three rows is not read, it is skipped.
 */
function cues(text, maxChars = 76) {
  const sentences = text.match(/[^.?!]+[.?!]*/g) ?? [text];
  const out = [];
  let buf = "";
  for (const s of sentences) {
    const piece = s.trim();
    if (!piece) continue;
    if ((buf + " " + piece).trim().length > maxChars && buf) {
      out.push(buf.trim());
      buf = piece;
    } else {
      buf = (buf + " " + piece).trim();
    }
  }
  if (buf) out.push(buf.trim());

  // A short trailing fragment reads better absorbed into the previous cue
  // than flashing up on its own for half a second.
  if (out.length > 1 && out[out.length - 1].length < 22) {
    const tail = out.pop();
    out[out.length - 1] = `${out[out.length - 1]} ${tail}`;
  }
  return out.map(wrapTwoRows);
}

/**
 * Balances a cue across two rows of roughly equal length.
 *
 * An earlier version wrapped greedily and then truncated to two rows, which
 * silently threw away the rest of the sentence — captions came out reading
 * "Ek / click," with the remainder gone. Splitting at the midpoint keeps the
 * whole cue and cannot drop words.
 */
function wrapTwoRows(text, width = 52) {
  if (text.length <= width) return text;

  const words = text.split(" ");
  const half = text.length / 2;
  let best = 1;
  let bestDelta = Infinity;

  // Try every word boundary; keep the one closest to an even split.
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(" ").length;
    const delta = Math.abs(left - half);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }

  return words.slice(0, best).join(" ") + "\n" + words.slice(best).join(" ");
}

/* ------------------------------------------------------------------ run */

// 1 — a real returning patient, so the lookup on camera is genuine
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
let phone;
let clinicName = "Shifa Medical Centre";
try {
  const [row] = await sql`
    select p.phone
      from patient p
      join visit v on v.patient_id = p.id
     where p.phone <> ''
     group by p.id, p.phone
     having count(v.id) >= 2
     order by max(v.opened_at) desc
     limit 1
  `;
  phone = row?.phone;

  // The cards carry the clinic's own name, so the demo reads as theirs.
  const [c] = await sql`select name from clinic_setting where id = 1`;
  if (c?.name) clinicName = c.name;
} finally {
  await sql.end();
}

if (!phone) {
  console.error(
    "No returning patient found. Seed some history first:\n" +
      "  node --env-file=.env.local scripts/seed-demo.mjs 45",
  );
  process.exit(1);
}
console.log(`returning patient for the lookup scene: ${phone}`);

// 2 — narration
const clips = [];
let voiceLabel = "none (subtitles only)";

if (NO_VOICE) {
  // Subtitles still need timings, so estimate them from line length.
  for (const line of LINES) {
    clips.push({
      ...line,
      file: null,
      dur: Math.max(2.4, line.roman.split(" ").length / 2.6),
    });
  }
} else if (existsSync(path.join(VOICE_DIR, "01.wav")) && argv.includes("--reuse-voice")) {
  // Hand-recorded narration dropped into demo/out/vo/ — the best-sounding
  // option, and the reason this path exists.
  voiceLabel = "existing files in demo/out/vo";
  for (const line of LINES) {
    const file = path.join(VOICE_DIR, `${line.id}.wav`);
    if (!existsSync(file)) {
      console.error(`--reuse-voice: missing ${file}`);
      process.exit(1);
    }
    clips.push({ ...line, file, dur: durationOf(file) });
  }
} else if (USE_ELEVEN) {
  /*
    ElevenLabs v3 — the only path that carries emotion. lines.json's `v3`
    field adds audio tags ([warm], [excited]) and ellipses, which v3 reads as
    performance direction rather than literal text.
  */
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? SUGGESTED[0].id;
  const q = await quota();
  if (q) {
    console.log(`ElevenLabs: ${q.used} / ${q.limit} characters used`);
  }
  console.log(`voice: ElevenLabs ${voiceId}`);

  rmSync(VOICE_DIR, { recursive: true, force: true });
  mkdirSync(VOICE_DIR, { recursive: true });

  const mp3Dir = path.join(OUT, "vo-mp3");
  rmSync(mp3Dir, { recursive: true, force: true });
  try {
    await speakAll({
      linesFile: path.join(ROOT, "demo", "lines.json"),
      outDir: mp3Dir,
      voiceId,
      field: argv.includes("--no-tags") ? "urdu" : "v3",
      opts: { model: ELEVEN_MODEL, speed: ELEVEN_SPEED },
    });
  } catch (e) {
    console.error(`\n${e.message}\n`);
    console.error("Fall back to the offline voice with:  --piper\n");
    process.exit(1);
  }

  // Normalise to the WAV the rest of the pipeline expects.
  voiceLabel = `ElevenLabs ${ELEVEN_MODEL}`;
  for (const line of LINES) {
    const wav = path.join(VOICE_DIR, `${line.id}.wav`);
    ffmpeg([
      "-y", "-i", path.join(mp3Dir, `${line.id}.mp3`),
      "-ar", "48000", "-ac", "2", wav,
    ]);
    clips.push({ ...line, file: wav, dur: durationOf(wav) });
  }
} else if (USE_PIPER) {
  /*
    Piper with the Pakistani Urdu voice — a real ur_PK model, not an English
    voice approximating Roman Urdu, and the reason lines.json carries a
    Nastaliq field. Runs offline on CPU, no account, no per-character cost.
  */
  // Female Pakistani Urdu by default — warmer for a clinic setting, and the
  // convention for product narration. --male swaps to fasih.
  const model = argv.includes("--male")
    ? "ur_PK-fasih-medium"
    : "ur_PK-aegis_female-medium";
  const dataDir = path.join(ROOT, "demo", "voices");
  if (!existsSync(path.join(dataDir, `${model}.onnx`))) {
    console.error(
      `Urdu voice not installed. Run:\n` +
        `  pip install piper-tts\n` +
        `  python -m piper.download_voices ${model} --data-dir demo/voices`,
    );
    process.exit(1);
  }

  console.log(`voice: Piper ${model} (Urdu, Pakistan)`);
  rmSync(VOICE_DIR, { recursive: true, force: true });
  mkdirSync(VOICE_DIR, { recursive: true });

  const r = spawnSync(
    "python",
    ["demo/speak.py", "--model", model, "--data-dir", dataDir,
     "--lines", path.join(ROOT, "demo", "lines.json"),
     "--out-dir", VOICE_DIR, "--length-scale", String(PIPER_PACE)],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || "piper failed");
    process.exit(1);
  }
  process.stderr.write(r.stderr ?? "");

  voiceLabel = `Piper ${model}`;
  for (const line of LINES) {
    const file = path.join(VOICE_DIR, `${line.id}.wav`);
    clips.push({ ...line, file, dur: durationOf(file) });
  }
} else {
  // Windows SAPI fallback. Reads the ROMAN text, because SAPI's English
  // voices cannot pronounce Nastaliq at all.
  const voice = pickVoice();
  if (!voice) {
    console.error("no speech voice available; use --no-voice");
    process.exit(1);
  }
  console.log(`voice: ${voice.name} (${voice.culture})`);
  if (!/^ur|^hi/i.test(voice.culture)) {
    console.log(
      "  note: an English voice reading Roman Urdu — understandable but\n" +
        "  clearly accented. Prefer the default Piper path for real Urdu.",
    );
  }
  voiceLabel = voice.name;
  for (const line of LINES) {
    const file = path.join(VOICE_DIR, `${line.id}.wav`);
    rmSync(file, { force: true });
    speak(voice, line.roman, file);
    if (!existsSync(file) || statSync(file).size < 1000) {
      console.error(`narration failed for line ${line.id}`);
      process.exit(1);
    }
    clips.push({ ...line, file, dur: durationOf(file) });
    process.stdout.write(".");
  }
  console.log("");
}

const speech = clips.reduce((s, c) => s + c.dur, 0);
console.log(`narration: ${speech.toFixed(1)}s across ${clips.length} lines`);

// 3 — screen recording, paced to the narration it will carry. Each scene is
// told how long its line runs, so the picture tracks the voice as it goes
// rather than being stretched to fit afterwards.
const raw = path.join(OUT, "raw.webm");

// --reuse skips the screen capture and re-muxes the existing take. Useful
// when only the narration or subtitles are being adjusted, which is most of
// the time — a full recording takes two minutes of wall clock.
if (argv.includes("--reuse") && existsSync(raw)) {
  console.log("reusing the existing recording (--reuse)");
} else {
  console.log("recording the walkthrough (a browser window will open)…");
  const rec = spawnSync("node", ["demo/record.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      DEMO_PHONE: phone,
      DEMO_SCENES: JSON.stringify(clips.map((c) => c.dur)),
    },
  });
  if (rec.status !== 0) process.exit(rec.status ?? 1);
}
const videoDur = durationOf(raw);
console.log(`video: ${videoDur.toFixed(1)}s`);

/*
  4 — line up narration with the picture.

  The recording never lands on exactly the scripted length. Rather than cut
  narration or leave silence, the VIDEO is retimed to the narration: speech
  carries the meaning, so it is the fixed track and the picture stretches to
  fit. Slowing a screencast slightly reads as calm; speeding up narration
  reads as rushed.

  Each line then occupies its scene in proportion to its own length.
*/
// The recorder already held each scene for the length of its narration, so
// the two tracks line up as-is. A scene that overran its slot pushes later
// ones a little late; correcting that with a small uniform stretch keeps the
// last line from being clipped without visibly changing the pace.
let t = 0;
const timed = clips.map((c) => {
  const start = t;
  t += c.dur;
  return { ...c, start, end: t };
});

const drift = videoDur - speech;
const speedFactor = Math.abs(drift) > 1.5 ? videoDur / (speech + 0.6) : 1;
const target = speedFactor === 1 ? videoDur : speech + 0.6;

console.log(
  speedFactor === 1
    ? `video ${videoDur.toFixed(1)}s vs narration ${speech.toFixed(1)}s — in sync`
    : `correcting ${drift > 0 ? "+" : ""}${drift.toFixed(1)}s drift ` +
      `(${videoDur.toFixed(1)}s -> ${target.toFixed(1)}s)`,
);

// Subtitles: each narration line becomes one or more cues, split across its
// own span in proportion to length, so the caption changes as the voice does
// instead of one block sitting on screen for fifteen seconds.
const entries = [];
for (const c of timed) {
  // Captions are Roman Urdu even when the voice speaks Nastaliq: most
  // reception staff read Roman comfortably, Nastaliq less so.
  const parts = cues(c.roman);
  const span = c.end - c.start;
  const totalChars = parts.reduce((s, p) => s + p.length, 0) || 1;
  let at = c.start;
  for (const part of parts) {
    const dur = span * (part.length / totalChars);
    entries.push({
      start: at,
      end: Math.max(at + dur - 0.08, at + 0.7),
      text: part,
    });
    at += dur;
  }
}

// Subtitles are burned in after the title card is spliced on, so every cue
// shifts by the amount the card adds to the running time.
const SUB_OFFSET = INTRO - 0.7; // INTRO minus the cross-fade overlap

const srt = entries
  .map((e, i) =>
    [
      i + 1,
      `${srtTime(e.start + SUB_OFFSET)} --> ${srtTime(e.end + SUB_OFFSET)}`,
      e.text,
      "",
    ].join("\n"),
  )
  .join("\n");
const srtFile = path.join(OUT, "subtitles.srt");
writeFileSync(srtFile, srt, "utf8");
console.log(`subtitles: ${entries.length} cues`);

// audio track: each clip padded out to its slot
const finalMp4 = path.join(OUT, "demo.mp4");
rmSync(finalMp4, { force: true });

/*
  Subtitle style.

  Two failed passes are worth recording: 17pt covered a third of the frame,
  11pt was unreadable and broke short phrases across two rows. 14pt with a
  wider wrap keeps each cue on one or two lines in the bottom strip, clear of
  the UI being demonstrated.

  libass sizes relative to a 384px-tall reference, so PlayResY is pinned to
  the real frame height to make FontSize mean actual pixels.
*/
const subStyle =
  "FontName=Segoe UI Semibold,FontSize=15,PrimaryColour=&H00FFFFFF," +
  "OutlineColour=&HB4000000,BorderStyle=3,Outline=4,Shadow=0," +
  "Alignment=2,MarginV=22";
// ffmpeg's filter parser treats ":" as an option separator and "\" as an
// escape, so a Windows absolute path cannot be passed literally. ffmpeg is
// run with its working directory set to OUT, which lets us pass a bare name.
const srtName = path.basename(srtFile);

const hasAudio = clips.some((c) => c.file);

/* ------------------------------------------------- 5. title cards + music */

const introCard = path.join(OUT, "card-intro.png");
const outroCard = path.join(OUT, "card-outro.png");
if (!existsSync(introCard) || !existsSync(outroCard) || argv.includes("--cards")) {
  console.log("rendering title cards…");
  const c = spawnSync("node", ["demo/cards.mjs"], {
    stdio: "inherit",
    env: { ...process.env, DEMO_CLINIC: clinicName },
  });
  if (c.status !== 0) process.exit(c.status ?? 1);
}

// Cards bracket the walkthrough, so the bed has to cover all of it.
const runtime = INTRO + target + OUTRO;
const musicFile = path.join(OUT, "music.wav");
if (!NO_MUSIC) {
  const m = spawnSync("node", ["demo/music.mjs", runtime.toFixed(1), musicFile], {
    encoding: "utf8",
  });
  if (m.status !== 0) {
    console.error(m.stderr || "music generation failed");
    process.exit(1);
  }
}

/* --------------------------------------------- 6. one narration track */

// The per-scene clips are laid onto a single timeline first, so the editor
// only has to deal with one voice input and can sidechain the music off it.
const voiceTrack = path.join(OUT, "narration.wav");
if (hasAudio) {
  const args = ["-y"];
  timed.forEach((c) => args.push("-i", c.file));
  const delays = timed
    .map(
      (c, i) =>
        `[${i}:a]adelay=${Math.round(c.start * 1000)}|${Math.round(c.start * 1000)}[a${i}]`,
    )
    .join(";");
  const mixIn = timed.map((_, i) => `[a${i}]`).join("");
  args.push(
    "-filter_complex",
    `${delays};${mixIn}amix=inputs=${timed.length}:normalize=0:dropout_transition=0[m];` +
      `[m]apad,atrim=0:${target.toFixed(3)},` +
      `aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[out]`,
    "-map", "[out]", voiceTrack,
  );
  ffmpeg(args);
}

/* ------------------------------------------------------- 7. final edit */

console.log("editing…");
const finalDur = assemble({
  raw,
  voice: hasAudio ? voiceTrack : null,
  music: NO_MUSIC ? null : musicFile,
  intro: introCard,
  outro: outroCard,
  srtName,
  subStyle,
  bodyDur: videoDur,
  speed: speedFactor,
  out: finalMp4,
  cwd: OUT,
});

const size = (statSync(finalMp4).size / 1e6).toFixed(1);
console.log(
  `\nDone.\n` +
    `  video     ${finalMp4}  (${size} MB, ${finalDur.toFixed(0)}s)\n` +
    `  subtitles ${srtFile}\n` +
    `  voice     ${voiceLabel}\n` +
    `  music     ${NO_MUSIC ? "none" : "generated ambient bed"}\n`,
);
