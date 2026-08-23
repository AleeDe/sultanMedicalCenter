/*
  ElevenLabs narration.

  Piper is clear but flat — it is a `medium` offline model with no notion of
  emphasis, so every sentence lands with the same weight. This path uses
  ElevenLabs v3, which reads audio tags like [warm] and [excited] and honours
  ellipses as real pauses, which is what makes narration sound performed
  rather than recited.

  Needs ELEVENLABS_API_KEY. The free tier is 10k characters/month and this
  script is ~1,200, so a handful of rebuilds per month fit inside it — hence
  --reuse-voice, so the edit can be re-tuned without re-spending characters.

  Usage (via build.mjs --eleven), or standalone:
    node demo/elevenlabs.mjs --list
    node demo/elevenlabs.mjs --out demo/out/vo
*/
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.elevenlabs.io/v1";
const KEY = process.env.ELEVENLABS_API_KEY;

/** Voices worth trying first for Urdu narration, best guess in order. */
export const SUGGESTED = [
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", note: "warm female narrator" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", note: "soft female, news read" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", note: "expressive female" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", note: "calm female" },
];

function must(cond, msg) {
  if (!cond) {
    console.error(msg);
    process.exit(1);
  }
}

/** Lists the voices on the account, so a real voice_id can be chosen. */
export async function listVoices() {
  must(KEY, "ELEVENLABS_API_KEY is not set.");
  const r = await fetch(`${API}/voices`, { headers: { "xi-api-key": KEY } });
  if (!r.ok) throw new Error(`voices: ${r.status} ${await r.text()}`);
  const { voices } = await r.json();
  return voices.map((v) => ({
    id: v.voice_id,
    name: v.name,
    labels: v.labels ?? {},
  }));
}

/** Remaining characters on the plan — worth knowing before a run. */
export async function quota() {
  must(KEY, "ELEVENLABS_API_KEY is not set.");
  const r = await fetch(`${API}/user/subscription`, {
    headers: { "xi-api-key": KEY },
  });
  if (!r.ok) return null;
  const s = await r.json();
  return { used: s.character_count, limit: s.character_limit };
}

/**
 * Synthesises one line to MP3.
 *
 * stability 0.4 is the "creative" end: v3 responds to the audio tags and
 * varies its delivery. Higher values are steadier but flatten exactly the
 * expressiveness this path exists to get.
 */
export async function speak(text, voiceId, outFile, opts = {}) {
  must(KEY, "ELEVENLABS_API_KEY is not set.");

  const body = {
    text,
    model_id: opts.model ?? "eleven_v3",
    voice_settings: {
      stability: opts.stability ?? 0.4,
      similarity_boost: 0.8,
      style: opts.style ?? 0.45,
      use_speaker_boost: true,
      speed: opts.speed ?? 0.94, // a touch under natural, for narration
    },
  };

  const r = await fetch(
    `${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!r.ok) {
    const detail = await r.text();
    // The commonest failures are worth translating, since the raw JSON is
    // not obvious to someone setting this up for the first time.
    if (r.status === 401) throw new Error("ElevenLabs rejected the API key.");
    if (r.status === 422 && /model/.test(detail)) {
      throw new Error(
        "eleven_v3 was refused for this account. Try --model eleven_multilingual_v2.",
      );
    }
    if (r.status === 429) {
      throw new Error("Out of characters on this ElevenLabs plan.");
    }
    throw new Error(`ElevenLabs ${r.status}: ${detail.slice(0, 300)}`);
  }

  writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
  return outFile;
}

/** Synthesises every line in lines.json into outDir. */
export async function speakAll({ linesFile, outDir, voiceId, field = "v3", opts = {} }) {
  const lines = JSON.parse(readFileSync(linesFile, "utf8"));
  mkdirSync(outDir, { recursive: true });

  const files = [];
  for (const line of lines) {
    const text = line[field] ?? line.urdu;
    const out = path.join(outDir, `${line.id}.mp3`);
    await speak(text, voiceId, out, opts);
    process.stderr.write(`  ${line.id}\n`);
    files.push(out);
  }
  return files;
}

/* ------------------------------------------------------------ standalone */

// pathToFileURL, not string surgery: on Windows the drive letter and
// separators make a hand-built file:// URL fail to match, and the CLI block
// then silently never runs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const argv = process.argv.slice(2);

  if (argv.includes("--list")) {
    const q = await quota();
    if (q) console.log(`characters: ${q.used} / ${q.limit} used\n`);
    for (const v of await listVoices()) {
      const l = [v.labels.gender, v.labels.accent, v.labels.description]
        .filter(Boolean)
        .join(", ");
      console.log(`  ${v.id}  ${v.name.padEnd(18)} ${l}`);
    }
    process.exit(0);
  }

  const voiceId =
    (argv.includes("--voice") && argv[argv.indexOf("--voice") + 1]) ||
    process.env.ELEVENLABS_VOICE_ID ||
    SUGGESTED[0].id;
  const outDir =
    (argv.includes("--out") && argv[argv.indexOf("--out") + 1]) || "demo/out/vo";

  const q = await quota();
  if (q) console.log(`characters used: ${q.used} / ${q.limit}`);
  console.log(`voice: ${voiceId}`);

  await speakAll({
    linesFile: "demo/lines.json",
    outDir,
    voiceId,
    field: argv.includes("--roman") ? "roman" : "v3",
  });
  console.log("done");
}
