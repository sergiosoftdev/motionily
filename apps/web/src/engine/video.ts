/**
 * Video layers in the browser: decodes clips with WebCodecs (mediabunny) and uploads the exact
 * frame each render needs into the engine (`videoFrames(t)` → `setVideoFrameFrom(key, VideoFrame)`:
 * the decoder's frame goes to the GPU as it is, on WebGPU; on WebGL2 it is drawn into a canvas first).
 *
 * - Exact path (`prepare`): export, render_frames, review. Awaits the frame whose timestamp is the
 *   last one ≤ the clip's file time, so any frame renders the same in any order.
 * - Live path (`show`): preview playback and scrubbing. Never blocks the animation frame: it draws
 *   the closest decoded frame now and refines to the exact one in the background.
 */
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type VideoSample } from "mediabunny";
import { setMediaDuration, type Engine } from "./pkg/engine_wasm.js";
import type { AudioFx } from "@motionily/protocol";
import { perf } from "./perf";

/** A frame is the one shown at t when its timestamp ≤ t + this (frame times are not exact floats). */
const FRAME_EPSILON = 1e-3;
/** Requests further ahead than this restart decoding at the target instead of decoding through. */
const MAX_DECODE_AHEAD = 2;
/** Long side (px) frames are decoded to: enough for a 1080p export, bounded upload cost. */
const MAX_SIDE = 1920;
/** Clip sound plays between these rates (slower is a freeze: silent). */
const MIN_RATE = 0.0625;
const MAX_RATE = 16;

/** Layer `type` of video clips in the scene JSON. */
export const VIDEO_LAYER = "video";
/** Sound clips on the timeline (scene `audio` layers): played and mixed like a video clip's sound, never drawn. */
export const AUDIO_LAYER = "audio";

export const VideoStatus = { Loading: "loading", Ready: "ready", Failed: "failed" } as const;
export type VideoStatus = (typeof VideoStatus)[keyof typeof VideoStatus];

export type FrameNeed = { key: string; src: string; time: number };
export type ClipState = { id: string; src: string; time: number; rate: number; volume: number; pan: number };
/**
 * One stretch of a clip's sound for the export mix: from video second `at`, play `seconds` of the
 * file from `offset`, starting at `volume` and ramping through `levels` ([video second, level]) when
 * the clip's volume is keyframed; `pan` (−1..1) and `pans` the same for where it sits.
 */
export type ClipSound = { src: string; at: number; offset: number; seconds: number; rate: number; volume: number; levels: [number, number][]; pan: number; pans: [number, number][]; fx?: AudioFx };

/** Whether a video layer's `volume` (a number, keyframes or an expression) is ever above 0. */
export function hasSound(volume: unknown): boolean {
  if (typeof volume === "number") return volume > 0;
  if (Array.isArray(volume)) return volume.some((k) => typeof (k as { v?: unknown })?.v === "number" && (k as { v: number }).v > 0);
  return typeof volume === "string";
}

/** Engines that take decoder frames straight to the GPU (WebGPU), by engine. */
const direct = new WeakMap<Engine, boolean>();
function takesFrames(engine: Engine) {
  let on = direct.get(engine);
  // `__motionilyCanvasFrames` (set before the editor loads) keeps the canvas path, to compare both in benchmarks.
  if (on === undefined) direct.set(engine, (on = /WebGpu/i.test(engine.adapterInfo()) && !(globalThis as { __motionilyCanvasFrames?: boolean }).__motionilyCanvasFrames));
  return on;
}

/** One opened video file and its sequential decoder. */
class VideoFile {
  status: VideoStatus = VideoStatus.Loading;
  error = "";
  duration = 0;
  /** The WebGL2 path's frame (an OffscreenCanvas in the playback worker, which only takes VideoFrames). */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas = typeof document === "undefined" ? new OffscreenCanvas(2, 2) : document.createElement("canvas");
  private readonly g = this.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private sink: VideoSampleSink | null = null;
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  /** Frame on screen at the decoder position, and the one after it (`undefined` = not read yet, `null` = end). */
  private cur: VideoSample | null = null;
  private next: VideoSample | null | undefined = undefined;
  /** Decoder calls run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    readonly src: string,
    url: string,
  ) {
    this.ready = this.open(url).catch((e: unknown) => {
      this.status = VideoStatus.Failed;
      this.error = e instanceof Error ? e.message : String(e);
    });
  }

  private async open(url: string) {
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("the file has no video track");
    if (!(await track.canDecode())) throw new Error(`this browser cannot decode its codec (${(await track.getCodec()) ?? "unknown"})`);
    // The video track's own span: a longer audio track must not stretch the clip.
    this.duration = await track.computeDuration();
    const [w, h] = [await track.getDisplayWidth(), await track.getDisplayHeight()];
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    this.canvas.width = Math.max(2, Math.round(w * k));
    this.canvas.height = Math.max(2, Math.round(h * k));
    this.sink = new VideoSampleSink(track);
    setMediaDuration(this.src, this.duration);
    this.status = VideoStatus.Ready;
  }

  /** The frame decoded most recently (whatever time it is), drawn into the canvas (the WebGL2 path). */
  drawCurrent(): number | null {
    if (!this.cur) return null;
    this.cur.draw(this.g, 0, 0, this.canvas.width, this.canvas.height);
    return this.cur.timestamp;
  }

  /** Put the frame decoded most recently into `engine` under `key`; false when there is none yet. */
  upload(engine: Engine, key: string): boolean {
    const cur = this.cur;
    if (!cur) return false;
    const t0 = performance.now();
    if (takesFrames(engine)) {
      // GPU to GPU: no drawing of the frame on the CPU side, the browser converts it from YUV.
      const frame = cur.toVideoFrame();
      try {
        engine.setVideoFrameFrom(key, frame);
      } finally {
        frame.close();
      }
    } else {
      this.drawCurrent();
      engine.setVideoFrame(key, this.canvas as HTMLCanvasElement);
    }
    perf.upload.add(performance.now() - t0);
    return true;
  }

  /** True if the current frame is the one shown at file time `t`. */
  covers(t: number): boolean {
    if (!this.cur || this.next === undefined) return false;
    const target = t + FRAME_EPSILON;
    return this.cur.timestamp <= target && (this.next === null || this.next.timestamp > target);
  }

  /** Decode up to the frame shown at file time `t` and draw it into the canvas. False if unavailable. */
  frameAt(t: number): Promise<boolean> {
    const run = this.queue.then(async () => {
      const t0 = performance.now();
      await this.seek(t);
      perf.decode.add(performance.now() - t0);
    });
    this.queue = run.catch(() => undefined);
    return run.then(
      () => this.cur !== null,
      () => false,
    );
  }

  private async seek(t: number) {
    await this.ready;
    if (!this.sink) return;
    const target = t + FRAME_EPSILON;
    const restart = !this.iter || !this.cur || target < this.cur.timestamp || target > this.cur.timestamp + MAX_DECODE_AHEAD;
    if (restart) {
      await this.reset();
      this.iter = this.sink.samples(Math.max(0, t));
      const first = await this.iter.next();
      this.cur = first.done ? null : first.value;
      this.next = undefined;
    }
    for (;;) {
      if (this.next === undefined) {
        const n = await this.iter!.next();
        this.next = n.done ? null : n.value;
      }
      if (!this.next || this.next.timestamp > target) return;
      this.cur?.close();
      this.cur = this.next;
      this.next = undefined;
    }
  }

  private async reset() {
    this.cur?.close();
    this.next?.close();
    this.cur = null;
    this.next = undefined;
    const it = this.iter;
    this.iter = null;
    await it?.return(undefined).catch(() => undefined);
  }

  dispose() {
    void this.reset();
  }
}

/** Frames uploaded into one engine: key → whether it is the exact frame. */
export type FrameCache = Map<string, boolean>;

/** Every video file the scene uses, shared by the editor engine and export engines. */
export class VideoLibrary {
  private files = new Map<string, VideoFile>();
  /** Generation of the latest live refinement; older ones give up. */
  private live = 0;

  /** `onChange` runs when a file finishes opening (or fails), to redraw. */
  constructor(
    private readonly url: (src: string) => string,
    private readonly onChange?: () => void,
  ) {}

  /** Open the files the engine's scene uses. */
  sync(engine: Engine) {
    for (const src of engine.videoSources()) {
      if (this.files.has(src)) continue;
      const f = new VideoFile(src, this.url(src));
      this.files.set(src, f);
      void f.ready.then(() => this.onChange?.());
    }
  }

  /** Resolves once every file the scene uses is open (or failed). */
  async ready(engine: Engine) {
    this.sync(engine);
    await Promise.all(engine.videoSources().map((s) => this.files.get(s)?.ready));
  }

  status(src: string): { status: VideoStatus; error: string; duration: number } | null {
    const f = this.files.get(src);
    return f ? { status: f.status, error: f.error, duration: f.duration } : null;
  }

  /** Upload the exact frames a render at `t` needs (awaits decoding). Call right before `engine.render(t)`. */
  async prepare(engine: Engine, t: number, cache: FrameCache) {
    const needs = JSON.parse(engine.videoFrames(t)) as FrameNeed[];
    if (!needs.length && !cache.size) return;
    await this.ready(engine);
    for (const n of needs) {
      if (cache.get(n.key)) continue;
      const f = this.files.get(n.src);
      if (f?.status !== VideoStatus.Ready || !(await f.frameAt(n.time))) continue;
      f.upload(engine, n.key);
      cache.set(n.key, true);
    }
    retain(engine, needs, cache);
  }

  /**
   * Live preview: upload what is decoded right now (never waits) and return a promise that
   * resolves true once the exact frames are in (then render again), or false if superseded.
   */
  show(engine: Engine, t: number, cache: FrameCache): Promise<boolean> | null {
    const needs = JSON.parse(engine.videoFrames(t)) as FrameNeed[];
    if (!needs.length) {
      if (cache.size) retain(engine, needs, cache);
      return null;
    }
    this.sync(engine);
    let missing = false;
    for (const n of needs) {
      if (cache.get(n.key)) continue;
      const f = this.files.get(n.src);
      if (f?.status !== VideoStatus.Ready) {
        missing ||= f?.status === VideoStatus.Loading;
        continue;
      }
      missing = true;
      if (!f.upload(engine, n.key)) continue;
      cache.set(n.key, f.covers(n.time));
    }
    retain(engine, needs, cache);
    if (!missing) return null;
    const gen = ++this.live;
    return (async () => {
      await this.ready(engine);
      for (const n of needs) {
        if (gen !== this.live) return false;
        if (cache.get(n.key)) continue;
        const f = this.files.get(n.src);
        if (f?.status !== VideoStatus.Ready || !(await f.frameAt(n.time))) continue;
        if (gen !== this.live) return false;
        f.upload(engine, n.key);
        cache.set(n.key, true);
      }
      return true;
    })();
  }

  dispose() {
    this.files.forEach((f) => f.dispose());
    this.files.clear();
  }
}

function retain(engine: Engine, needs: FrameNeed[], cache: FrameCache) {
  const keys = new Set(needs.map((n) => n.key));
  for (const k of [...cache.keys()]) if (!keys.has(k)) cache.delete(k);
  engine.retainVideoFrames([...keys]);
}

/**
 * The clips' sound for the export mix: each video layer with volume > 0 sampled at every frame,
 * cut into stretches where the file plays continuously at one rate (loops, time remaps and
 * freezes start a new stretch or go silent).
 */
export function clipSounds(engine: Engine, fps: number, duration: number): ClipSound[] {
  const out: ClipSound[] = [];
  /** Open stretches, with the previous frame's level (to start a ramp where the level starts changing). */
  const open = new Map<string, ClipSound & { last: number; prevT: number; prevV: number; prevKept: boolean; prevP: number; prevPKept: boolean }>();
  const frames = Math.max(1, Math.round(duration * fps));
  const step = 1 / fps;
  // Each clip's own effects ride along with its stretches.
  const fxOf = new Map(((JSON.parse(engine.sceneJson()) as { layers?: { id: string; audio_fx?: AudioFx }[] }).layers ?? []).filter((l) => l.audio_fx).map((l) => [l.id, l.audio_fx!]));
  const close = (id: string) => {
    const s = open.get(id);
    if (s && s.seconds > 0) out.push({ src: s.src, at: s.at, offset: s.offset, seconds: s.seconds, rate: s.rate, volume: s.volume, levels: s.levels, pan: s.pan, pans: s.pans, ...(fxOf.has(id) ? { fx: fxOf.get(id) } : {}) });
    open.delete(id);
  };
  for (let i = 0; i <= frames; i++) {
    const t = i * step;
    const clips = i < frames ? (JSON.parse(engine.videoClips(t)) as ClipState[]).filter((c) => c.volume > 0) : [];
    const seen = new Set<string>();
    for (const c of clips) {
      seen.add(c.id);
      const s = open.get(c.id);
      const rate = Math.min(MAX_RATE, c.rate);
      const continues = s && Math.abs(s.rate - rate) < 1e-3 && Math.abs(s.last + rate * step - c.time) < step * 0.5;
      if (s && continues) {
        s.seconds += step;
        s.last = c.time;
        // Volume keyframes: a point where the level changes (and the one before it, where the ramp starts).
        const changed = Math.abs(c.volume - s.prevV) > 1e-4;
        if (changed && !s.prevKept) s.levels.push([s.prevT, s.prevV]);
        if (changed) s.levels.push([t, c.volume]);
        s.prevKept = changed;
        // Pan keyframes, the same way.
        const moved = Math.abs(c.pan - s.prevP) > 1e-4;
        if (moved && !s.prevPKept) s.pans.push([s.prevT, s.prevP]);
        if (moved) s.pans.push([t, c.pan]);
        s.prevPKept = moved;
        s.prevT = t;
        s.prevV = c.volume;
        s.prevP = c.pan;
        continue;
      }
      close(c.id);
      if (rate >= MIN_RATE) open.set(c.id, { src: c.src, at: t, offset: c.time, seconds: step, rate, volume: c.volume, levels: [], pan: c.pan, pans: [], last: c.time, prevT: t, prevV: c.volume, prevKept: true, prevP: c.pan, prevPKept: true });
    }
    for (const id of [...open.keys()]) if (!seen.has(id)) close(id);
  }
  return out;
}
