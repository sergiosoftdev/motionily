import { mediaUrl } from "../api/client";

/** A sound effect on the timeline (mirrors SfxCue in crates/scene). */
export type SfxCue = { id: string; sound: string; src: string; at: number; gain?: number };

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
      if (offset >= buf.duration) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = cue.gain ?? 1;
      src.connect(g).connect(ctx.destination);
      src.start(t0 + Math.max(0, -offset), Math.max(0, offset));
      this.playing.push(src);
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

  /** Preview one sound (timeline click). */
  async preview(src: string, gain = 1) {
    const buf = await this.load(src);
    if (!buf) return;
    const ctx = this.context();
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    s.connect(g).connect(ctx.destination);
    s.start();
  }
}

export const sfxPlayer = new SfxPlayer();
