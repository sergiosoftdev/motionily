import { mediaUrl } from "../api/client";

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
 * Shared by the preview and the export so both sound the same. Null when the cue is already over.
 */
export function playCue(ctx: BaseAudioContext, buf: AudioBuffer, cue: SfxCue, when: number, into = 0): AudioBufferSourceNode | null {
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
  src.connect(g).connect(ctx.destination);
  src.start(when, from + into, len - into);
  return src;
}

/**
 * Plays the scene's sound effects in sync with the preview. Buffers are decoded once and
 * scheduled with WebAudio from the playhead, so timing is sample-accurate.
 */
class SfxPlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private playing: AudioBufferSourceNode[] = [];

  private context() {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  load(src: string) {
    let b = this.buffers.get(src);
    if (!b) {
      b = fetch(mediaUrl(src))
        .then((r) => r.arrayBuffer())
        .then((a) => this.context().decodeAudioData(a))
        .catch(() => null);
      this.buffers.set(src, b);
    }
    return b;
  }

  /** Start every cue from `from` seconds (cues already sounding join mid-way). */
  async start(from: number, cues: SfxCue[]) {
    this.stop();
    const ctx = this.context();
    const t0 = ctx.currentTime + 0.03;
    for (const cue of cues) {
      const buf = await this.load(cue.src);
      if (!buf) continue;
      const offset = from - cue.at;
      const src = playCue(ctx, buf, cue, t0 + Math.max(0, -offset), Math.max(0, offset));
      if (src) this.playing.push(src);
    }
  }

  stop() {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {
        // Already ended.
      }
    }
    this.playing = [];
  }

  /** Preview one cue, or a whole library sound (timeline click, Sounds screen). */
  async preview(cue: Pick<SfxCue, "src" | "gain" | "from" | "len">) {
    const buf = await this.load(cue.src);
    if (!buf) return;
    const ctx = this.context();
    playCue(ctx, buf, { id: "", sound: "", at: 0, ...cue }, ctx.currentTime);
  }
}

export const sfxPlayer = new SfxPlayer();
