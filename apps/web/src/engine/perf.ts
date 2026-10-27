/**
 * What the preview costs, measured as it plays (the performance HUD and the browser benchmarks read
 * it): display frames and the ones that came late, the engine's render call, video decoding, and
 * memory. Samples live in short rolling windows; recording is a few `performance.now()` calls, cheap
 * enough to leave on.
 */

/** Seconds of history each statistic covers. */
const WINDOW_MS = 2000;
/** A display frame counts as dropped when it took this many 60 Hz frames. */
const LATE = 1.6;
const FRAME_60 = 1000 / 60;

type Sample = { at: number; ms: number };

class Series {
  private samples: Sample[] = [];
  add(ms: number, at = performance.now()) {
    this.samples.push({ at, ms });
    this.trim(at);
  }
  private trim(now: number) {
    let i = 0;
    while (i < this.samples.length && now - this.samples[i]!.at > WINDOW_MS) i++;
    if (i) this.samples.splice(0, i);
  }
  stats(now = performance.now()) {
    this.trim(now);
    const v = this.samples.map((s) => s.ms).sort((a, b) => a - b);
    const at = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor((v.length - 1) * p + 0.5))]! : 0);
    return { count: v.length, p50: at(0.5), p95: at(0.95), max: v.at(-1) ?? 0, total: v.reduce((a, b) => a + b, 0) };
  }
  clear() {
    this.samples = [];
  }
}

export type PerfSnapshot = {
  playing: boolean;
  /** Frames of the video shown per second (playback), and display frames that came late. */
  fps: number;
  dropped: number;
  /** The engine's render call (CPU side: building and submitting the GPU work), ms. */
  render: { p50: number; p95: number; count: number };
  /** From the render call until the GPU has drawn the frame, ms. */
  gpu: { p50: number; p95: number; count: number };
  /** Decoding a clip frame up to the one needed (WebCodecs), ms. */
  decode: { p50: number; p95: number; count: number };
  /** Uploading video frames to the GPU, ms. */
  upload: { p50: number; p95: number; count: number };
  /** JS heap (Chromium only) and the engine's WebAssembly memory, MB. */
  heapMB: number | null;
  wasmMB: number | null;
  /** Rendered-ahead frames kept for playback, MB. */
  cacheMB: number;
};

class PerfMonitor {
  readonly frames = new Series();
  readonly shown = new Series();
  readonly render = new Series();
  readonly gpu = new Series();
  /** Measure the GPU side too (the HUD turns it on: it costs a callback per frame). */
  watchGpu = false;
  readonly decode = new Series();
  readonly upload = new Series();
  private dropped: number[] = [];
  playing = false;
  /** Set by the host: bytes of the render cache and of the engine's memory. */
  cacheBytes = () => 0;
  wasmBytes: () => number | null = () => null;

  /** A display frame during playback, `ms` after the previous one. */
  frame(ms: number) {
    const now = performance.now();
    this.frames.add(ms, now);
    if (ms > LATE * FRAME_60) this.dropped.push(now);
  }

  /** A new frame of the video reached the screen. */
  showed() {
    this.shown.add(0);
  }

  /** Time `fn` and record it under `series`. */
  time<T>(series: Series, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      series.add(performance.now() - t0);
    }
  }

  snapshot(): PerfSnapshot {
    const now = performance.now();
    this.dropped = this.dropped.filter((t) => now - t <= WINDOW_MS);
    const pick = (s: Series) => {
      const x = s.stats(now);
      return { p50: x.p50, p95: x.p95, count: x.count };
    };
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const wasm = this.wasmBytes();
    return {
      playing: this.playing,
      fps: (this.shown.stats(now).count * 1000) / WINDOW_MS,
      dropped: this.dropped.length,
      render: pick(this.render),
      gpu: pick(this.gpu),
      decode: pick(this.decode),
      upload: pick(this.upload),
      heapMB: memory ? memory.usedJSHeapSize / 1048576 : null,
      wasmMB: wasm === null ? null : wasm / 1048576,
      cacheMB: this.cacheBytes() / 1048576,
    };
  }

  reset() {
    for (const s of [this.frames, this.shown, this.render, this.gpu, this.decode, this.upload]) s.clear();
    this.dropped = [];
  }
}

export const perf = new PerfMonitor();

// Benchmarks and the console read it from here.
if (typeof window !== "undefined") (window as unknown as { __motionilyPerf?: PerfMonitor }).__motionilyPerf = perf;
