import init, { Engine, captionStyles, stylePalettes, stylePresets } from "./pkg/engine_wasm.js";
import type { CaptionStyle, Op, StylePreset } from "@motionily/protocol";
import demoScene from "../../../../examples/demo.scene.json?raw";
import { DEFAULT_FONT_FAMILY, fontFilesFor } from "./fonts";
import { decodePng, modelUrl, packOf, packTextureUrl, type Pixels } from "./models";
import { mediaUrl } from "../api/client";
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
  /** 3D models and pack textures, fetched once and shared with export engines. */
  private modelCache = new Map<string, Promise<ArrayBuffer>>();
  private textureCache = new Map<string, Promise<Pixels | null>>();
  private loadingModels = new Set<string>();
  private loadingImages = new Set<string>();
  private imageCache = new Map<string, Promise<Pixels | null>>();

  /** Voice-over/music played in sync with the preview (not saved yet). */
  private audio: HTMLAudioElement | null = null;
  private audioTrack: AudioTrack = { start: 0, trim_in: 0, trim_out: null };
  private size: [number, number] = [1080, 1920];

  /** Restart at the end instead of stopping (turntable previews). */
  loop = false;

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
      this.loadingModels.clear();
      this.loadingImages.clear();
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
    this.loop = false;
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
      const t = op.typography as { family?: string; body?: number; heading?: number } | null | undefined;
      if (t?.family) void this.ensureFonts(t.family, [t.body ?? 500, t.heading ?? 700]);
    }
    if (this.engine) this.applyOps(ops);
  }

  loadScene(json: string) {
    const engine = this.require();
    engine.loadScene(json);
    if (this.buildOps.length) engine.applyOps(JSON.stringify(this.buildOps));
    this.changed();
  }

  private fetchModel(key: string) {
    let p = this.modelCache.get(key);
    if (!p) {
      p = fetch(modelUrl(key)).then((r) => {
        if (!r.ok) throw new Error(`model ${key} not found`);
        return r.arrayBuffer();
      });
      this.modelCache.set(key, p);
    }
    return p;
  }

  private fetchTexture(pack: string) {
    let p = this.textureCache.get(pack);
    if (!p) {
      p = decodePng(packTextureUrl(pack)).catch(() => null);
      this.textureCache.set(pack, p);
    }
    return p;
  }

  /** Load every model the scene's 3D stage uses (and their pack textures), then redraw. */
  async ensureModels() {
    const engine = this.engine;
    if (!engine) return;
    const missing = engine.missingModels().filter((k) => !this.loadingModels.has(k));
    if (missing.length === 0) return;
    missing.forEach((k) => this.loadingModels.add(k));
    const packs = new Set(missing.map(packOf));
    await Promise.all([
      ...missing.map(async (key) => {
        const bytes = await this.fetchModel(key).catch(() => null);
        if (bytes && engine === this.engine) engine.addModel(key, new Uint8Array(bytes));
      }),
      ...[...packs].map(async (pack) => {
        const px = await this.fetchTexture(pack);
        if (px && engine === this.engine) engine.addTexture(pack, px.rgba, px.width, px.height);
      }),
    ]);
    this.draw();
  }

  private fetchImage(src: string) {
    let p = this.imageCache.get(src);
    if (!p) {
      p = decodePng(src.startsWith("/media/") ? mediaUrl(src) : src).catch(() => null);
      this.imageCache.set(src, p);
    }
    return p;
  }

  /** Decode every image the layers use (brand logos, screenshots) for the engine. */
  async ensureImages() {
    const engine = this.engine;
    if (!engine) return;
    const missing = engine.missingImages().filter((s) => !this.loadingImages.has(s));
    if (missing.length === 0) return;
    missing.forEach((s) => this.loadingImages.add(s));
    await Promise.all(
      missing.map(async (src) => {
        const px = await this.fetchImage(src);
        if (px && engine === this.engine) engine.addImage(src, px.rgba, px.width, px.height);
      }),
    );
    this.draw();
  }

  /** Decoded images for another engine (export). */
  async imageAssets(): Promise<({ src: string } & Pixels)[]> {
    const scene = JSON.parse(this.require().sceneJson()) as { layers: { type: string; src?: string }[] };
    const srcs = [...new Set(scene.layers.filter((l) => l.type === "image" && l.src).map((l) => l.src!))];
    const out = await Promise.all(srcs.map(async (src) => ({ src, px: await this.fetchImage(src) })));
    return out.filter((o): o is { src: string; px: Pixels } => o.px !== null).map((o) => ({ src: o.src, ...o.px }));
  }

  /** Every model and pack texture the scene needs, for another engine (export). */
  async stageAssets(): Promise<{ models: { key: string; bytes: Uint8Array }[]; textures: ({ pack: string } & Pixels)[] }> {
    const scene = JSON.parse(this.require().sceneJson()) as { stage?: { props?: { model: string }[] } | null };
    const keys = [...new Set((scene.stage?.props ?? []).map((p) => p.model))];
    const models = (await Promise.all(keys.map(async (key) => ({ key, bytes: new Uint8Array(await this.fetchModel(key).catch(() => new ArrayBuffer(0))) })))).filter(
      (m) => m.bytes.length > 0,
    );
    const textures = (await Promise.all([...new Set(keys.map(packOf))].map(async (pack) => ({ pack, px: await this.fetchTexture(pack) }))))
      .filter((t): t is { pack: string; px: Pixels } => t.px !== null)
      .map((t) => ({ pack: t.pack, ...t.px }));
    return { models, textures };
  }

  /** Every font file fetched so far, to hand to another engine (export). */
  async loadedFontFiles(): Promise<{ family: string; weight: number; bytes: Uint8Array }[]> {
    const typo = (JSON.parse(this.require().sceneJson()) as { typography?: { family: string; body: number; heading: number } | null }).typography;
    const files = [...fontFilesFor(DEFAULT_FONT_FAMILY), ...(typo ? fontFilesFor(typo.family, [typo.body, typo.heading]) : [])];
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
  async ensureFonts(family: string, weights?: number[]) {
    const files = fontFilesFor(family, weights).filter((f) => !this.loadedFonts.has(f.url));
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
    if (next >= duration && this.loop) {
      useEditor.setState({ time: 0 });
      this.draw();
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
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
    void this.ensureModels();
    void this.ensureImages();
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
