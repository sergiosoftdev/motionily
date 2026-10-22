import { ALL_FORMATS, CanvasSink, Input, UrlSource } from "mediabunny";
import { mediaUrl } from "../../api/client";
import { useEditor } from "../../store";

/**
 * Frames for the timeline's filmstrips, decoded small with WebCodecs (one sink per file) and kept per
 * file second on a power-of-two grid, so a coarser zoom reuses what a finer one decoded. Decoding
 * waits while the preview plays (it needs the decoder), and the newest requests go first.
 */

/** Height (px) frames are decoded at: twice the strip, for sharp HiDPI. */
const THUMB_PX = 80;
/** Finest grid step (s of file) and the coarsest. */
const MIN_STEP = 1 / 8;
const MAX_STEP = 64;
/** Frames decoded per pass, and kept per file. */
const BATCH = 10;
const MAX_FRAMES = 600;
/** Requests remembered per file (the oldest are dropped). */
const MAX_WANTED = 300;
const IDLE_MS = 250;

type Frame = HTMLCanvasElement | OffscreenCanvas;

/** Grid step (s) for tiles `seconds` of file apart: a power of two, so grids nest. */
export const gridStep = (seconds: number) => Math.min(MAX_STEP, Math.max(MIN_STEP, 2 ** Math.ceil(Math.log2(Math.max(seconds, 1e-3)))));
/** Key (ms) of the grid point nearest file second `t`. */
export const gridKey = (t: number, step: number) => Math.round(Math.max(0, Math.round(t / step) * step) * 1000);

class ThumbFile {
  readonly frames = new Map<number, Frame>();
  /** Aspect (w/h) of the decoded frames, once known. */
  aspect: number | null = null;
  private wanted = new Map<number, number>();
  private stamp = 0;
  private running = false;
  private readonly sink: Promise<CanvasSink | null>;
  readonly listeners = new Set<() => void>();

  constructor(src: string) {
    this.sink = (async () => {
      const input = new Input({ source: new UrlSource(mediaUrl(src)), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return null;
      this.aspect = (await track.getDisplayWidth()) / Math.max(1, await track.getDisplayHeight());
      return new CanvasSink(track, { height: THUMB_PX });
    })().catch(() => null);
  }

  request(keys: number[]) {
    this.stamp++;
    for (const k of keys) if (!this.frames.has(k)) this.wanted.set(k, this.stamp);
    while (this.wanted.size > MAX_WANTED) this.wanted.delete(this.wanted.keys().next().value!);
    void this.pump();
  }

  /** The frame at `key`, or the nearest decoded one within a grid step. */
  near(key: number, step: number): Frame | null {
    const exact = this.frames.get(key);
    if (exact) return exact;
    const ms = Math.round(MIN_STEP * 1000);
    for (let d = ms; d <= step * 1000; d += ms) {
      const f = this.frames.get(key - d) ?? this.frames.get(key + d);
      if (f) return f;
    }
    return null;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      const sink = await this.sink;
      if (this.aspect) this.listeners.forEach((f) => f());
      while (sink && this.wanted.size) {
        if (useEditor.getState().playing) {
          await new Promise((r) => setTimeout(r, IDLE_MS));
          continue;
        }
        // Newest requests first (what is on screen now), decoded in file order.
        const batch = [...this.wanted.entries()].sort((a, b) => b[1] - a[1]).slice(0, BATCH).map(([k]) => k);
        batch.forEach((k) => this.wanted.delete(k));
        batch.sort((a, b) => a - b);
        let i = 0;
        for await (const wrapped of sink.canvasesAtTimestamps(batch.map((k) => k / 1000))) {
          const key = batch[i++]!;
          if (wrapped) this.frames.set(key, wrapped.canvas);
        }
        while (this.frames.size > MAX_FRAMES) this.frames.delete(this.frames.keys().next().value!);
        this.listeners.forEach((f) => f());
      }
    } catch {
      this.wanted.clear();
    } finally {
      this.running = false;
    }
  }
}

const files = new Map<string, ThumbFile>();
const posters = new Map<string, HTMLImageElement>();

/** The thumbnail cache of one video file. */
export function thumbFile(src: string): ThumbFile {
  let f = files.get(src);
  if (!f) files.set(src, (f = new ThumbFile(src)));
  return f;
}

/** A footage clip's contact sheet (shown while real frames decode); `onLoad` runs once it can be drawn. */
export function posterImage(url: string, onLoad: () => void): HTMLImageElement | null {
  let img = posters.get(url);
  if (!img) {
    img = new Image();
    img.src = mediaUrl(url);
    posters.set(url, img);
  }
  if (img.complete && img.naturalWidth) return img;
  img.addEventListener("load", onLoad, { once: true });
  return null;
}

/** The contact sheet's layout (apps/api/src/brands/video-asset.ts: 4 × 3 frames, evenly spaced over the file). */
export const SHEET_COLS = 4;
export const SHEET_ROWS = 3;
