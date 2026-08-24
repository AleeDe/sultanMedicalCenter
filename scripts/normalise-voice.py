"""
Prepares the announcement clips for seamless stitching.

Two jobs, both about making assembled speech sound spoken rather than
assembled.

TRIMMING

Piper pads every utterance with silence — measured on this voice, ~0.25s
before the word and ~0.15s after. That padding is invisible when a clip is
played alone, but stitching them means the padding STACKS: tail + gap + lead
put nearly half a second of dead air between "two" and "two". The result is a
sequence of isolated words, which is exactly what betrays a stitched
announcement.

Trimming it here rather than at playback keeps the timing decision in one
place: after this, a clip starts on its first sound and ends on its last, so
the board's gap constant means precisely what it says.

A short fade is applied at each new edge. Cutting a waveform at a non-zero
sample produces a click, and a click at the start of every word is a worse
artefact than the padding being removed.

LOUDNESS

Piper also normalises each utterance to peak independently, so a short word
lands quieter than a long phrase even though both touch 0 dBFS. Played back
to back the sentence lurches. RMS is matched instead of peak, because the ear
tracks average energy, not peaks.
"""

import argparse
import array
import math
import sys
import wave
from pathlib import Path

# Target RMS in 16-bit counts. ~ -18 dBFS: loud enough to carry across a
# waiting room, with headroom for the peaks a speech waveform still has.
TARGET_RMS = 4200.0

# Frames below this count as silence for measurement and trimming.
SILENCE = 400

# Never amplify beyond this. A clip needing more gain than this is not quiet,
# it is mostly silence, and pushing it would only raise its noise floor.
MAX_GAIN = 4.0

# Leave this much headroom below full scale.
CEILING = 32000

# Keep this much silence either side of the word. Not zero: speech begins
# with a low-energy onset (the breath before a plosive) that a hard threshold
# cuts into, which makes the word sound clipped at the front.
KEEP_LEAD = 0.030   # seconds
KEEP_TAIL = 0.040   # seconds, slightly longer so words do not sound cut off

# Fade applied at the trimmed edges to avoid a click.
FADE = 0.008        # seconds


def trim(samples: array.array, rate: int) -> array.array:
    """Removes Piper's padding, keeping a short margin and fading the edges."""
    first = next((i for i, x in enumerate(samples) if abs(x) > SILENCE), None)
    if first is None:
        return samples
    last = len(samples) - next(
        i for i, x in enumerate(reversed(samples)) if abs(x) > SILENCE
    )

    start = max(0, first - int(KEEP_LEAD * rate))
    end = min(len(samples), last + int(KEEP_TAIL * rate))
    cut = samples[start:end]

    fade = min(int(FADE * rate), len(cut) // 2)
    for i in range(fade):
        k = i / fade
        cut[i] = int(cut[i] * k)
        cut[-1 - i] = int(cut[-1 - i] * k)
    return cut


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    # A per-clip line is useful for a handful of clips and unreadable for
    # several hundred; the summary at the end is what matters at that scale.
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    out = Path(args.dir)
    files = sorted(f for f in out.glob("*.wav") if not f.name.startswith("_"))
    if not files:
        print("no clips to process", file=sys.stderr)
        return 1

    trimmed = 0.0
    for f in files:
        with wave.open(str(f), "rb") as w:
            params = w.getparams()
            rate = w.getframerate()
            samples = array.array("h")
            samples.frombytes(w.readframes(w.getnframes()))

        before = len(samples) / rate
        samples = trim(samples, rate)
        after = len(samples) / rate

        voiced = [x for x in samples if abs(x) > SILENCE]
        if not voiced:
            print(f"{f.name}: no audio", file=sys.stderr)
            return 1

        rms = math.sqrt(sum(x * x for x in voiced) / len(voiced))
        gain = min(TARGET_RMS / rms, MAX_GAIN)

        # Never let the gain push a peak into the ceiling.
        peak = max(abs(x) for x in samples)
        if peak * gain > CEILING:
            gain = CEILING / peak

        adjusted = array.array(
            "h", (int(max(-CEILING, min(CEILING, round(x * gain)))) for x in samples)
        )

        with wave.open(str(f), "wb") as w:
            w.setparams((params.nchannels, params.sampwidth, rate,
                         len(adjusted), params.comptype, params.compname))
            w.writeframes(adjusted.tobytes())

        if not args.quiet:
            print(f"  {f.stem:10} {before:.2f}s -> {after:.2f}s  gain x{gain:.2f}",
                  file=sys.stderr)
        trimmed += before - after

    print(f"  {len(files)} clips trimmed, {trimmed:.0f}s of padding removed",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
