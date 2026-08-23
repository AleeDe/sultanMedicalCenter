# Demo video

A ~2 minute client-facing walkthrough, built by driving the real application
in a real browser. Nothing is mocked or staged: the patient looked up on
camera is a real record from the database, and the printed slip shown is the
actual artwork the printer receives.

## What the finished video contains

| | |
|---|---|
| Title card | clinic name, pushed in slowly, cross-fading to the app |
| Walkthrough | the real app, with a synthetic cursor and a slow drift |
| End card | "Tayyar hai", fading up from the last frame |
| Voice | female Pakistani Urdu, Nastaliq script |
| Music | generated ambient bed, ducked under the narration |
| Subtitles | Roman Urdu, burned in |
| Master | −14 LUFS / −2.8 dBTP, the standard for online video |

## One-time setup

The narration uses **Piper** with genuine Pakistani-Urdu voices — offline, no
account, no per-character cost:

```bash
pip install piper-tts
python -m piper.download_voices ur_PK-aegis_female-medium --data-dir demo/voices
python -m piper.download_voices ur_PK-fasih-medium --data-dir demo/voices
```

Two 63 MB ONNX models: `aegis_female` (default) and `fasih` (male, `--male`).
`demo/voices/` is git-ignored.

## Building it

The app must be running first (`npm run dev`), with some history seeded so the
analytics screen is not empty:

```bash
node --env-file=.env.local scripts/seed-demo.mjs 45
node --env-file=.env.local demo/build.mjs --pace 1.25
```

Output lands in `demo/out/`:

| file | what it is |
|---|---|
| `demo.mp4` | the finished video, subtitles burned in |
| `subtitles.srt` | the same captions as a separate file |
| `raw.webm` | the silent screen capture, before narration |
| `vo/` | one narration WAV per scene |

### Options

```bash
demo/build.mjs                  # female Urdu voice, music, cards (default)
demo/build.mjs --male           # male voice (ur_PK-fasih)
demo/build.mjs --pace 1.4       # slower delivery; 1.0 is Piper's own speed
demo/build.mjs --no-music       # narration only
demo/build.mjs --cards          # force the title cards to re-render
demo/build.mjs --reuse          # re-use the last screen capture (much faster)
demo/build.mjs --reuse-voice    # re-use demo/out/vo/*.wav
demo/build.mjs --sapi           # Windows voices reading the Roman text
demo/build.mjs --no-voice       # subtitles only
```

`--reuse --reuse-voice` together rebuild only the edit — seconds rather than
minutes. Use that when tuning music levels, transitions or subtitle styling.

## The edit

`edit.mjs` does the final assembly. Three details there are worth knowing
before changing it:

- **The voice is `asplit` into two streams.** A filter label can only be
  consumed once, and the narration is needed both in the mix and as the
  sidechain key that ducks the music. Feeding one label to both fails with
  "matches no streams".
- **The limiter runs before `loudnorm`, not after.** loudnorm applies its own
  gain, so a limiter placed after it undoes the headroom it just created — an
  earlier pass shipped at +0.3 dBTP, i.e. clipping.
- **Subtitles are burned in last**, after the cross-fades and the colour lift,
  so nothing scales or fades the captions.

## Narration

The script lives in two places, and both must be kept in step:

- `script.md` — human-readable, with scene notes and timings
- `lines.json` — what is actually used, each line in **two** forms

Each entry in `lines.json` carries:

| field | used for |
|---|---|
| `urdu` | Nastaliq, what Piper speaks |
| `roman` | Roman Urdu, the burned-in subtitles and the SAPI fallback |

**Never feed Roman Urdu to a TTS engine.** An English-language voice applies
English letter-to-sound rules to it and the result is mangled. Real Urdu
voices need Nastaliq input, which is why both forms are stored.

### ElevenLabs — the expressive option

Piper is clear but **flat**: an offline `medium` model with no notion of
emphasis, so every sentence lands with the same weight. ElevenLabs v3 reads
*audio tags* and treats ellipses as real pauses, which is what makes narration
sound performed rather than recited.

Set a key and the build switches over automatically:

```bash
# .env.local
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=XrExE9yKIg1WjnnlVkGX   # optional; a default is used
```

```bash
node demo/elevenlabs.mjs --list      # voices on the account + characters left
node --env-file=.env.local demo/build.mjs
```

**The key needs permissions.** A key created without them authenticates but
fails every call with `missing_permissions`. Tick at least **Text to Speech**
and **Voices → Read** when creating it, or the build stops with a 401.

Current voice is **Bella** (`hpp4J3VqNfWAUOO0d1Us`) — professional, bright,
warm. `--list` shows the alternatives; Matilda and Alice also read Urdu
cleanly. Change `ELEVENLABS_VOICE_ID` to switch.

The free tier is **10,000 characters/month** and this script is ~1,200, so
roughly eight full builds fit. Once the voice files exist, `--reuse-voice`
re-runs the edit without spending more.

The `v3` field in `lines.json` carries the performance direction — tags used
here are `[warm]`, `[excited]`, `[curious]`, `[thoughtful]`, and ellipses
become pauses. `--no-tags` speaks the plain `urdu` field instead; `--piper`
forces the offline voice even when a key is present.

If the account rejects `eleven_v3`, fall back with
`--model eleven_multilingual_v2` — tags stop working, but the voice is still
far more natural than Piper.

### Other ways up from Piper

Piper's Urdu voices are `medium`-quality — clearly better than Windows SAPI,
but not broadcast-grade. Besides ElevenLabs:

- **Record it yourself.** Replace `demo/out/vo/01.wav` … `09.wav` with your own
  recordings, then rerun with `--reuse-voice`. By far the most natural result,
  and the reason that flag exists.
- **Use a cloud voice.** Azure `ur-PK-UzmaNeural` / `ur-PK-AsadNeural` are the
  only true *Pakistani* neural voices; Google's `ur-IN-Chirp3-HD-*` are newer
  and more natural but Indian-accented Urdu. At ~2,000 characters per build,
  both sit inside their free tiers. Synthesise the `urdu` field of each line to
  `demo/out/vo/<id>.wav`, then `--reuse-voice`.

## How the timing works

The narration is generated first, and each scene is told how long its line
runs. The recorder then holds every scene for exactly that long, so the
picture tracks the voice as it goes rather than being stretched afterwards.
Any residual drift over 1.5 s is corrected with a small uniform retime, which
is not visible at these speeds.

Captions are split at sentence boundaries and balanced across two rows, so a
line never fills the frame or gets truncated mid-phrase.
