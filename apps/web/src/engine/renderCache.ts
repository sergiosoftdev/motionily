/**
 * Background render cache for heavy stretches (After Effects' RAM preview, Resolve's render cache): the
 * frames playback could not draw in time are noted; while the editor sits paused they are rendered ahead
 * into bitmaps (preview size), and the next playback shows those instead of rendering them again. Any
 * edit of the scene empties it.
 */

/** A frame counts as late when it took this many display frames. */
const LATE_FRAMES = 1.6;
/** Seconds marked heavy around a late frame (a heavy beat lasts a while). */
const HEAVY_AROUND = 0.5;
/** Memory the cached bitmaps may take (about 2 s of a vertical preview on a Retina screen). */
const BUDGET_BYTES = 160 * 1024 * 1024;
/** Longest side (px) frames are cached at: the preview is seldom bigger on screen. */
const MAX_SIDE = 1080;

export class RenderCache {
  /** Bitmaps by frame index, for one scene version. */
  private frames = new Map<number, ImageBitmap>();
  private bytes = 0;
  private version = -1;
  /** Frame indices marked heavy (late during playback), to render ahead. */
  private heavy = new Set<number>();

  /** The scene changed: nothing cached is valid any more (the heavy marks stay: the beats are still heavy). */
  invalidate(version: number) {
    if (version === this.version) return;
    this.version = version;
    for (const b of this.frames.values()) b.close();
    this.frames.clear();
    this.bytes = 0;
  }

  /** A frame drawn `elapsedMs` after the previous one, `intervalMs` being one display frame: mark it if late. */
  note(t: number, fps: number, elapsedMs: number, intervalMs: number) {
    if (elapsedMs < LATE_FRAMES * intervalMs) return;
    const a = Math.floor((t - HEAVY_AROUND) * fps);
    const b = Math.ceil((t + HEAVY_AROUND) * fps);
    for (let i = Math.max(0, a); i <= b; i++) this.heavy.add(i);
  }

  /** The cached bitmap of the frame at `t`, if any. */
  get(t: number, fps: number): ImageBitmap | undefined {
    return this.frames.get(Math.floor(t * fps + 1e-6));
  }

  /** Heavy frames not cached yet, nearest to `from` first (ahead of it before behind). */
  pending(from: number, fps: number): number[] {
    const at = Math.floor(from * fps);
    return [...this.heavy].filter((i) => !this.frames.has(i)).sort((x, y) => (x >= at ? x - at : 1e9 + at - x) - (y >= at ? y - at : 1e9 + at - y));
  }

  /** Keep a rendered frame (false when the budget is spent). */
  put(index: number, bitmap: ImageBitmap, version: number): boolean {
    if (version !== this.version || this.frames.has(index)) {
      bitmap.close();
      return version === this.version;
    }
    const size = bitmap.width * bitmap.height * 4;
    if (this.bytes + size > BUDGET_BYTES) {
      bitmap.close();
      return false;
    }
    this.frames.set(index, bitmap);
    this.bytes += size;
    return true;
  }

  /** Cached stretches as `[from, to]` seconds (for the timeline). */
  ranges(fps: number): [number, number][] {
    const idx = [...this.frames.keys()].sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (const i of idx) {
      const last = out.at(-1);
      if (last && Math.abs(last[1] - i / fps) < 1e-6) last[1] = (i + 1) / fps;
      else out.push([i / fps, (i + 1) / fps]);
    }
    return out;
  }

  /** Size frames are cached at for a canvas `w`×`h`. */
  static size(w: number, h: number): [number, number] {
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  }

  /** Forget everything (another video opened). */
  clear() {
    for (const b of this.frames.values()) b.close();
    this.frames.clear();
    this.bytes = 0;
    this.heavy.clear();
  }
}
