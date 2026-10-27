/**
 * The playback viewer's worker: its own engine on an `OffscreenCanvas` and its own video decoders, so
 * while the video plays every frame is decoded, rendered and presented off the main thread, and React,
 * the timeline or a busy panel never make it stutter. The editor's engine (main thread) stays the one
 * that edits, picks and draws while paused; this one follows its scene.
 */
import init, { Engine, analyzeAudio, clearAudioAnalysis } from "./pkg/engine_wasm.js";
import { VideoLibrary, type FrameCache } from "./video";
import type { ToWorker, FromWorker } from "./workerViewer";

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

let engine: Engine | null = null;
let surface: OffscreenCanvas | null = null;
let videos: VideoLibrary | null = null;
let urls: Record<string, string> = {};
let frames: FrameCache = new Map();
let fps = 30;
/** The clock: scene second `t` at epoch ms `at`, advancing at `rate`. */
let clock: { t: number; at: number; rate: number } | null = null;
let shown = -1;
let raf = 0;
let drawn = false;
/** Asset keys already in this engine. */
const have = new Set<string>();
/** Render and decode times since the last report (ms). */
let renders: number[] = [];
let lastReport = 0;

const now = () => performance.timeOrigin + performance.now();
const frameLoop: (cb: () => void) => number = typeof requestAnimationFrame === "function" ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 1000 / 60) as unknown as number;
const cancelLoop = (id: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));

function tick() {
  if (!engine || !clock || !videos) return;
  const t = clock.t + ((now() - clock.at) / 1000) * clock.rate;
  const frame = Math.floor(t * fps + 1e-6);
  if (frame !== shown) {
    shown = frame;
    const t0 = performance.now();
    const exact = videos.show(engine, t, frames);
    engine.render(t);
    renders.push(performance.now() - t0);
    if (!drawn) {
      drawn = true;
      post({ type: "drawn" });
    }
    void exact?.then((done) => {
      if (done && engine && clock && shown === frame) engine.render(t);
    });
  }
  if (performance.now() - lastReport > 500 && renders.length) {
    post({ type: "stats", renders });
    renders = [];
    lastReport = performance.now();
  }
  // The browser runs a worker's animation frames only for a canvas on screen: until the first frame shows, a timer.
  raf = drawn ? frameLoop(tick) : (setTimeout(tick, 4) as unknown as number);
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "init": {
        await init();
        surface = m.canvas;
        engine = await Engine.createOffscreen(m.canvas, m.webgl);
        engine.resize(m.width, m.height);
        videos = new VideoLibrary((src) => urls[src] ?? src);
        post({ type: "ready", adapter: engine.adapterInfo() });
        return;
      }
      case "load": {
        if (!engine) return;
        for (const f of m.fonts) if (!have.has(`f:${f.family}:${f.weight}`)) (engine.addFont(f.family, f.weight, f.bytes), have.add(`f:${f.family}:${f.weight}`));
        for (const x of m.models) if (!have.has(`m:${x.key}`)) (engine.addModel(x.key, x.bytes), have.add(`m:${x.key}`));
        for (const x of m.textures) if (!have.has(`t:${x.pack}`)) (engine.addTexture(x.pack, x.rgba, x.width, x.height), have.add(`t:${x.pack}`));
        for (const x of m.images) if (!have.has(`i:${x.src}`)) (engine.addImage(x.src, x.rgba, x.width, x.height), have.add(`i:${x.src}`));
        for (const x of m.luts) if (!have.has(`l:${x.src}`)) (engine.addLut(x.src, x.text), have.add(`l:${x.src}`));
        if (m.audio !== undefined) {
          if (m.audio) analyzeAudio(m.audio.samples, m.audio.rate);
          else clearAudioAnalysis();
        }
        // Other files (proxies switched on or off): reopen the clips.
        if (JSON.stringify(m.urls) !== JSON.stringify(urls)) {
          videos?.dispose();
          videos = new VideoLibrary((src) => urls[src] ?? src);
          frames = new Map();
        }
        urls = m.urls;
        fps = m.fps;
        engine.loadScene(m.scene);
        shown = -1;
        return;
      }
      case "resize":
        if (surface) [surface.width, surface.height] = [m.width, m.height];
        engine?.resize(m.width, m.height);
        shown = -1;
        return;
      case "play":
        clock = { t: m.t, at: m.at, rate: m.rate };
        drawn = false;
        shown = -1;
        cancelLoop(raf);
        clearTimeout(raf);
        tick();
        return;
      case "sync":
        // The sound coming out is the clock: follow it when they drift apart by more than a frame.
        if (clock) {
          const here = clock.t + ((m.at - clock.at) / 1000) * clock.rate;
          if (Math.abs(here - m.t) > 1 / fps || m.rate !== clock.rate) clock = { t: m.t, at: m.at, rate: m.rate };
        }
        return;
      case "stop":
        clock = null;
        cancelLoop(raf);
        clearTimeout(raf);
        return;
    }
  } catch (err) {
    post({ type: "failed", error: err instanceof Error ? err.message : String(err) });
  }
};
