/*
  Final edit pass.

  Takes the raw screen capture, the narration, the generated music and the
  title cards, and assembles the finished film:

    * a title card that pushes in gently, cross-fading into the walkthrough
    * a slow Ken Burns drift across the walkthrough, so a static screen
      recording does not feel frozen
    * an end card that fades up from it
    * narration mixed over a music bed that ducks whenever the voice speaks
    * subtitles burned in last, so they sit above every effect

  Called by build.mjs; the arguments are deliberately explicit so the step
  can be rerun on its own while tuning.
*/
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const INTRO = 3.6;
export const OUTRO = 3.2;
const XFADE = 0.7; // card <-> footage cross-fade

/**
 * @param {object} o
 * @param {string} o.raw        screen capture (webm)
 * @param {string} o.voice      mixed narration track (wav), or null
 * @param {string} o.music      music bed (wav), or null
 * @param {string} o.intro      intro card png
 * @param {string} o.outro      outro card png
 * @param {string} o.srtName    subtitle filename, relative to cwd
 * @param {string} o.subStyle   libass force_style string
 * @param {number} o.bodyDur    walkthrough length in seconds
 * @param {number} o.speed      retime factor for the walkthrough (1 = none)
 * @param {string} o.out        output mp4
 * @param {string} o.cwd        working directory for ffmpeg
 */
export function assemble(o) {
  const body = o.bodyDur / (o.speed || 1);
  // Cards overlap the footage by XFADE, so each adds a little less than its
  // nominal length to the running time.
  const total = INTRO + body + OUTRO - XFADE * 2;

  const args = ["-y"];
  // 0: intro still   1: footage   2: outro still
  args.push("-loop", "1", "-t", (INTRO + 1).toFixed(2), "-i", o.intro);
  args.push("-i", o.raw);
  args.push("-loop", "1", "-t", (OUTRO + 1).toFixed(2), "-i", o.outro);

  let audioIdx = 3;
  const voiceIdx = o.voice ? audioIdx++ : null;
  const musicIdx = o.music ? audioIdx++ : null;
  if (o.voice) args.push("-i", o.voice);
  if (o.music) args.push("-i", o.music);

  const f = [];

  /* ---------------------------------------------------------- video */

  // Title card: a slow push-in. Scaling up then cropping avoids the shimmer
  // that zoompan alone produces on text.
  f.push(
    `[0:v]scale=1584:-1,` +
      `zoompan=z='min(1.10,1.0+0.0016*on)':d=${Math.round((INTRO + 1) * 25)}` +
      `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1440x900:fps=25,` +
      `trim=0:${(INTRO + XFADE).toFixed(2)},setpts=PTS-STARTPTS,format=yuv420p[intro]`,
  );

  // Walkthrough: retimed if needed, then a very slow drift. The zoom is
  // small — enough to keep the frame alive, not enough to notice.
  const retime = o.speed && o.speed !== 1 ? `setpts=${(1 / o.speed).toFixed(6)}*PTS,` : "";
  f.push(
    `[1:v]${retime}fps=25,scale=1512:-1,` +
      `zoompan=z='min(1.05,1.0+0.00018*on)':d=1` +
      `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1440x900:fps=25,` +
      `format=yuv420p[bodyv]`,
  );

  // End card: hold still; the motion here comes from the fade itself.
  f.push(
    `[2:v]scale=1440:900,trim=0:${(OUTRO + XFADE).toFixed(2)},` +
      `setpts=PTS-STARTPTS,fps=25,format=yuv420p[outro]`,
  );

  f.push(
    `[intro][bodyv]xfade=transition=fade:duration=${XFADE}` +
      `:offset=${(INTRO - XFADE).toFixed(2)}[v1]`,
  );
  f.push(
    `[v1][outro]xfade=transition=fade:duration=${XFADE}` +
      `:offset=${(INTRO + body - XFADE * 2).toFixed(2)}[v2]`,
  );

  /*
    Colour grade, then subtitles last so nothing scales or fades the captions.

    The grade does two jobs: lifts a light UI that photographs washed out, and
    adds a very slight vignette. The vignette is the trick that makes a screen
    recording read as "filmed" rather than "captured" — it draws the eye to
    the centre without being noticeable on its own.
  */
  f.push(
    `[v2]eq=contrast=1.06:saturation=1.10:brightness=0.010:gamma=1.02,` +
      `vignette=angle=PI/6,` +
      `unsharp=5:5:0.4:5:5:0.0,` +
      `subtitles=${o.srtName}:force_style='${o.subStyle}'[vout]`,
  );

  /* ---------------------------------------------------------- audio */

  if (o.voice || o.music) {
    const parts = [];

    if (o.voice) {
      // Narration starts as the title card clears.
      //
      // Split in two: a filter label may only be consumed once, and the voice
      // is needed both in the final mix AND as the sidechain key that ducks
      // the music. Feeding [vo] to both is the error "matches no streams".
      f.push(
        `[${voiceIdx}:a]adelay=${Math.round((INTRO - XFADE) * 1000)}|${Math.round((INTRO - XFADE) * 1000)},` +
          `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `highpass=f=90,` +
          // Even out the delivery, then lift it clear of the bed.
          `acompressor=threshold=0.09:ratio=3:attack=12:release=220:makeup=2,` +
          `volume=1.5,asplit=2[vo][vokey]`,
      );
      parts.push("[vo]");
    }

    if (o.music) {
      f.push(
        `[${musicIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS[bed]`,
      );
      if (o.voice) {
        // Sidechain duck: the bed steps back under the voice and returns in
        // the gaps, which is what makes narration sit "on top" rather than
        // fighting the music.
        // Ratio 4 rather than 9: the bed should step back under the voice,
        // not vanish. An earlier pass ducked it to -47 dB, which made the
        // music pointless — audible only in the gaps, absent everywhere else.
        f.push(
          `[bed][vokey]sidechaincompress=threshold=0.06:ratio=4:attack=15:release=420` +
            `:makeup=1,volume=1.8[bedduck]`,
        );
        parts.push("[bedduck]");
      } else {
        parts.push("[bed]");
      }
    }

    f.push(
      `${parts.join("")}amix=inputs=${parts.length}:normalize=0:dropout_transition=0[mixed]`,
    );
    /*
      Master to broadcast levels.

      An earlier pass came out at -11.5 LUFS with a +0.3 dBTP true peak —
      louder than YouTube's -14 LUFS target (so it would be turned down on
      upload anyway) and clipping on playback. loudnorm targets -14 LUFS with
      1 dB of true-peak headroom, which is the standard for online video;
      the limiter afterwards is a safety net, not the main gain stage.
    */
    // Limiter BEFORE loudnorm. Running it afterwards pushed the true peak
    // back up to 0.0 dBTP — loudnorm applies its own gain, so anything after
    // it undoes the headroom it just created.
    f.push(
      `[mixed]alimiter=limit=0.9:attack=5:release=60,` +
        `loudnorm=I=-14:TP=-1.5:LRA=11,` +
        `apad,atrim=0:${total.toFixed(2)},` +
        `afade=t=in:st=0:d=0.5,` +
        `afade=t=out:st=${(total - 1.4).toFixed(2)}:d=1.4[aout]`,
    );
  }

  args.push("-filter_complex", f.join(";"));
  args.push("-map", "[vout]");
  if (o.voice || o.music) args.push("-map", "[aout]");

  args.push(
    "-t", total.toFixed(2),
    "-c:v", "libx264", "-preset", "slow", "-crf", "19",
    "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
    "-r", "25", "-g", "50",
  );
  if (o.voice || o.music) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
  args.push("-movflags", "+faststart", o.out);

  const r = spawnSync("ffmpeg", args, { encoding: "utf8", cwd: o.cwd });
  if (r.status !== 0) {
    console.error(
      "\nffmpeg (edit) failed:\n" +
        (r.stderr ?? "").split(/\r?\n/).filter(Boolean).slice(-25).join("\n"),
    );
    process.exit(1);
  }
  if (!existsSync(path.join(o.cwd, path.basename(o.out)))) {
    console.error("edit produced no file");
    process.exit(1);
  }
  return total;
}
