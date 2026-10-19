import init, { Engine, captionStyles, stylePalettes, stylePresets } from "./pkg/engine_wasm.js";
import type { CaptionStyle, Op, StylePreset } from "@motionily/protocol";
import demoScene from "../../../../examples/demo.scene.json?raw";
import { DEFAULT_FONT_FAMILY, fontFilesFor } from "./fonts";
import { EngineStatus, useEditor } from "../store";

type AudioTrack = { start: number; trim_in: number; trim_out: number | null };
type SceneMeta = { style: StylePreset; caption_style: CaptionStyle; duration: number; width: number; height: number; audio?: AudioTrack | null };

/** Audio drift (s) tolerated before re-syncing it to the video clock. */
const AUDIO_DRIFT = 0.15;

/**
 * Owns the Rust engine and the playback loop, outside React. React only reads
 * the store and calls these methods; frames never go through React renders.
 */
class EngineHost {
  private engine: Engine | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private lastTick = 0;
  private listeners = new Set<() => void>();

  /** Font files already handed to the current engine, by url. */
  private loadedFonts = new Set<string>();
  private fontCache = new Map<string, Promise<ArrayBuffer>>();

  /** Voice-over/music played in sync with the preview (not saved yet). */
  private audio: HTMLAudioElement | null = null;
  private audioTrack: AudioTrack = { start: 0, trim_in: 0, trim_out: null };
  private size: [number, number] = [1080, 1920];

  styles: StylePreset[] = [];
  captionStyles: CaptionStyle[] = [];
  palettes: Record<StylePreset, string[]> = {} as Record<StylePreset, string[]>;

  private wasmReady: Promise<unknown> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  /** Attach the engine to a canvas (one per editor screen) and load `sceneJson`, or the demo scene. */
  async mount(canvas: HTMLCanvasElement, sceneJson?: string | null) {
    if (this.canvas === canvas) return;
    this.unmount();
    this.canvas = canvas;
    useEditor.setState({ engineStatus: EngineStatus.Loading, time: 0 });
    try {
      this.wasmReady ??= init().then(() => {
        this.styles = JSON.parse(stylePresets());
        this.captionStyles = JSON.parse(captionStyles());
        this.palettes = JSON.parse(stylePalettes());
      });
      await this.wasmReady;
      this.fitCanvas();
      const engine = await Engine.create(canvas);
      if (this.canvas !== canvas) {
        engine.free(); // unmounted while creating
        return;
      }
      this.engine = engine;
      this.buildOps = [];
      this.loadedFonts.clear();
      this.engine.loadScene(sceneJson ?? demoScene);
      void this.ensureFonts(DEFAULT_FONT_FAMILY);
      this.resizeObserver = new ResizeObserver(() => this.fitCanvas());
      this.resizeObserver.observe(canvas);
      useEditor.setState({ engineStatus: EngineStatus.Ready, adapter: this.engine.adapterInfo() });
      this.syncMeta();
      this.draw();
    } catch (e) {
      useEditor.setState({ engineStatus: EngineStatus.Failed, engineError: String(e) });
    }
  }

  unmount() {
    this.pause();
    this.setAudio(null);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.engine?.free();
    this.engine = null;
    this.canvas = null;
  }

  /** Called after every scene change, from the agent or the user. */
  onSceneChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get ready() {
    return this.engine !== null;
  }

  duration() {
    return useEditor.getState().duration;
  }

  sceneJson() {
    return this.require().sceneJson();
  }

  summary() {
    return this.require().summary();
  }

  /** Throws with the engine's validation message if any op is invalid. */
  applyOps(ops: Op[]) {
    this.require().applyOps(JSON.stringify(ops));
    this.changed();
  }

  /** Ops derived from the user's bricks (palette…). Re-applied on every scene load so an agent can't drop them. */
  private buildOps: Op[] = [];

  setBuildOps(ops: Op[]) {
    this.buildOps = ops;
    for (const op of ops) {
      const family = (op.typography as { family?: string } | null | undefined)?.family;
      if (family) void this.ensureFonts(family);
    }
    if (this.engine) this.applyOps(ops);
  }

  loadScene(json: string) {
    const engine = this.require();
    engine.loadScene(json);
    if (this.buildOps.length) engine.applyOps(JSON.stringify(this.buildOps));
    this.changed();
  }

  /** Every font file fetched so far, to hand to another engine (export). */
  async loadedFontFiles(): Promise<{ family: string; weight: number; bytes: Uint8Array }[]> {
    const typo = (JSON.parse(this.require().sceneJson()) as { typography?: { family: string } | null }).typography;
    const files = [...fontFilesFor(DEFAULT_FONT_FAMILY), ...(typo ? fontFilesFor(typo.family) : [])];
    return Promise.all(
      files.map(async (f) => {
        let bytes = this.fontCache.get(f.url);
        if (!bytes) {
          bytes = fetch(f.url).then((r) => r.arrayBuffer());
          this.fontCache.set(f.url, bytes);
        }
        return { family: f.family, weight: f.weight, bytes: new Uint8Array(await bytes) };
      }),
    );
  }

  /** Fetch a family's font files once and register them in the engine, then redraw. */
  async ensureFonts(family: string) {
    const files = fontFilesFor(family).filter((f) => !this.loadedFonts.has(f.url));
    if (files.length === 0) return;
    files.forEach((f) => this.loadedFonts.add(f.url));
    const engine = this.engine;
    await Promise.all(
      files.map(async (f) => {
        let bytes = this.fontCache.get(f.url);
        if (!bytes) {
          bytes = fetch(f.url).then((r) => r.arrayBuffer());
          this.fontCache.set(f.url, bytes);
        }
        const data = new Uint8Array(await bytes);
        if (engine && engine === this.engine) engine.addFont(f.family, f.weight, data);
      }),
    );
    this.draw();
  }

  setAudio(url: string | null) {
    this.audio?.pause();
    this.audio = url ? new Audio(url) : null;
  }

  play() {
    if (useEditor.getState().playing) return;
    const { time, duration } = useEditor.getState();
    if (time >= duration) useEditor.setState({ time: 0 });
    useEditor.setState({ playing: true });
    this.syncAudio(true);
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.audio?.pause();
    useEditor.setState({ playing: false });
  }

  seek(t: number) {
    useEditor.setState({ time: Math.max(0, Math.min(t, useEditor.getState().duration)) });
    this.syncAudio(false);
    this.draw();
  }

  private tick = (now: number) => {
    const { time, duration } = useEditor.getState();
    const next = time + (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (next >= duration) {
      useEditor.setState({ time: duration });
      this.draw();
      this.pause();
      return;
    }
    useEditor.setState({ time: next });
    this.syncAudio(true);
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Keep the audio element on the timeline: play inside its trimmed window, silent outside. */
  private syncAudio(playing: boolean) {
    const a = this.audio;
    if (!a) return;
    const t = useEditor.getState().time;
    const { start, trim_in, trim_out } = this.audioTrack;
    const fileTime = trim_in + (t - start);
    const end = trim_out ?? (Number.isFinite(a.duration) ? a.duration : Infinity);
    const inside = t >= start && fileTime < end;
    if (!inside) {
      if (!a.paused) a.pause();
      return;
    }
    if (Math.abs(a.currentTime - fileTime) > AUDIO_DRIFT) a.currentTime = fileTime;
    if (playing && a.paused) void a.play();
    if (!playing && !a.paused) a.pause();
  }

  /** Small JPEG of the frame at each time, for the agent to look at. Restores the current frame. */
  snapshots(times: number[], width = 360): string[] {
    const canvas = this.canvas;
    if (!canvas || !this.engine) return [];
    const [sw, sh] = this.size;
    const out = document.createElement("canvas");
    out.width = width;
    out.height = Math.round((width * sh) / sw);
    const g = out.getContext("2d")!;
    const images = times.map((t) => {
      this.engine!.render(t);
      // Copy in the same task as the render: a WebGPU canvas is cleared once presented.
      g.drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL("image/jpeg", 0.72);
    });
    this.draw();
    return images;
  }

  sceneSize(): [number, number] {
    return this.size;
  }

  pick(x: number, y: number): string | undefined {
    return this.engine?.pick(useEditor.getState().time, x, y);
  }

  layerBounds(id: string): number[] | undefined {
    const b = this.engine?.layerBounds(id, useEditor.getState().time);
    return b ? Array.from(b) : undefined;
  }

  private draw() {
    this.engine?.render(useEditor.getState().time);
  }

  private changed() {
    this.syncMeta();
    this.draw();
    this.listeners.forEach((fn) => fn());
  }

  private syncMeta() {
    const meta = JSON.parse(this.require().sceneJson()) as SceneMeta;
    this.size = [meta.width, meta.height];
    this.audioTrack = meta.audio ?? { start: 0, trim_in: 0, trim_out: null };
    useEditor.setState((s) => ({
      sceneSize: [meta.width, meta.height],
      style: meta.style,
      captionStyle: meta.caption_style,
      duration: meta.duration,
      time: Math.min(s.time, meta.duration),
    }));
  }

  private fitCanvas() {
    const c = this.canvas;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width === w && c.height === h) return;
    c.width = w;
    c.height = h;
    this.engine?.resize(w, h);
    this.draw();
  }

  private require(): Engine {
    if (!this.engine) throw new Error("engine not ready");
    return this.engine;
  }
}

export const engineHost = new EngineHost();
