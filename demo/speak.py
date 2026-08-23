"""
Synthesises Urdu narration with Piper.

Piper is used directly through its Python API rather than the CLI, because
piping Nastaliq text through a Windows shell mangles the encoding — the text
arrives empty and Piper writes a zero-byte WAV.

Reads a JSON list of {id, text} on stdin, writes <id>.wav into --out-dir.

  python demo/speak.py --model ur_PK-fasih-medium --data-dir demo/voices \
                       --out-dir demo/out/vo  < lines.json
"""

import argparse
import json
import sys
import wave
from pathlib import Path

from piper import PiperVoice


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    # Read from a file, not stdin: Windows decodes the pipe with the ANSI
    # codepage, which turns Nastaliq into lone surrogates and makes espeak
    # raise UnicodeEncodeError.
    ap.add_argument("--lines", required=True, help="JSON file of {id, text}")
    ap.add_argument("--field", default="urdu", help="which text field to speak")
    # Piper's default pace is brisk for narration over a screencast.
    ap.add_argument("--length-scale", type=float, default=1.08)
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    model = data_dir / f"{args.model}.onnx"
    if not model.exists():
        print(f"model not found: {model}", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    raw = json.loads(Path(args.lines).read_text(encoding="utf-8"))
    lines = [{"id": r["id"], "text": r[args.field]} for r in raw]
    voice = PiperVoice.load(str(model))

    from piper import SynthesisConfig

    cfg = SynthesisConfig(length_scale=args.length_scale)

    for item in lines:
        path = out_dir / f"{item['id']}.wav"

        # Collect the audio first and write the WAV header ourselves.
        # synthesize_wav() leaves a zero-byte file with "# channels not
        # specified" if anything about the stream surprises it, whereas
        # synthesize() reliably yields chunks carrying their own format.
        chunks = list(voice.synthesize(item["text"], syn_config=cfg))
        if not chunks:
            print(f"line {item['id']} produced no audio", file=sys.stderr)
            return 1

        first = chunks[0]
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(first.sample_channels)
            wav.setsampwidth(first.sample_width)
            wav.setframerate(first.sample_rate)
            for c in chunks:
                wav.writeframes(c.audio_int16_bytes)

        size = path.stat().st_size
        if size < 2000:
            print(f"line {item['id']} produced no audio", file=sys.stderr)
            return 1
        secs = size / (first.sample_rate * first.sample_width * first.sample_channels)
        print(f"  {item['id']}  {secs:.1f}s", file=sys.stderr)

    print(json.dumps({"ok": True, "count": len(lines)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
