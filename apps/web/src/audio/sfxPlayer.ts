import { mediaUrl } from "../api/client";
import { audioBus } from "./bus";
import { decodeAudio } from "./decode";

/**
 * A sound effect on the timeline (mirrors SfxCue in crates/scene): `from` seconds into the file, for `len`
 * seconds (the whole file when absent).
 */
export type SfxCue = { id: string; sound: string; src: string; at: number; gain?: number; from?: number; len?: number };

/** Ramps where a cue starts inside a file or stops before its end, so it never clicks. */
const CUE_FADE_IN = 0.005;
const CUE_FADE_OUT = 0.04;

/**
 * Schedule `cue` on `ctx` at context time `when`, `into` seconds into the cue (a playhead past its start).
 * Shared by the preview and the export so both sound the same (into `out`: the mix bus). Null when the cue is already over.
 */
export function playCue(ctx: BaseAudioContext, buf: AudioBuffer, cue: SfxCue, when: number, into = 0, out: AudioNode = ctx.destination): AudioBufferSourceNode | null {
  const from = cue.from ?? 0;
  const len = Math.min(cue.len ?? Infinity, buf.duration - from);
  if (len <= 0 || into >= len) return null;
  const level = cue.gain ?? 1;
  const g = ctx.createGain();
  if (from > 0 && into === 0) {
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + CUE_FADE_IN);
  } else g.gain.setValueAtTime(level, when);
  if (cue.len !== undefined) {
    const end = when + len - into;
    g.gain.setValueAtTime(level, Math.max(when + CUE_FADE_IN, end - Math.min(CUE_FADE_OUT, len / 3)));
    g.gain.linearRampToValueAtTime(0, end);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(g).connect(out);
  src.start(when, from + into, len - into);
  return src;
}

/** Plays one sound effect on its own (a click on a cue, the Sounds screen); the timeline's play with the mix. */
class SfxPlayer {
  private context() {
    return audioBus.context();
  }

  load(src: string) {
    return decodeAudio(mediaUrl(src));
  }

  /** Preview one cue, or a whole library sound (timeline click, Sounds screen). */
  async preview(cue: Pick<SfxCue, "src" | "gain" | "from" | "len">) {
    const buf = await this.load(cue.src);
    if (!buf) return;
    const ctx = this.context();
    playCue(ctx, buf, { id: "", sound: "", at: 0, ...cue }, ctx.currentTime, 0, audioBus.master);
  }
}

export const sfxPlayer = new SfxPlayer();
