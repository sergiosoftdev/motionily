import init, { Engine, captionStyles, checkSceneShaders, stylePalettes, stylePresets } from "./pkg/engine_wasm.js";
import { sfxPlayer, type SfxCue } from "../audio/sfxPlayer";
import type { CaptionStyle, FrameLayout, Op, ReviewReport, StylePreset } from "@motionily/protocol";
import { DEFAULT_FONT_FAMILY, fontFilesFor, text3dFonts } from "./fonts";
import { decodeBytes, decodePng, modelFileUrl, modelUrl, packOf, packTextureUrl, type Pixels } from "./models";
import { mediaUrl } from "../api/client";
import { EngineStatus, useEditor } from "../store";

type AudioTrack = { start: number; trim_in: number; trim_out: number | null };
type ReviewLayer = {
  id: string;
  type: LayerType;
  start?: number;
  end?: number | null;
  visible?: boolean;
  soft?: unknown;
  parent?: string;
  camera?: unknown;
  [prop: string]: unknown;
};
/** `use` = a component instance: reviews measure the layers inside it (`instance/layer`) instead. */
const LayerType = { Shape: "shape", Text: "text", Image: "image", Character: "character", Particles: "particles", Use: "use", Shader: "shader" } as const;
/** Box-like layers: backgrounds may bleed off frame, and text sits inside them (shader layers fill a box like a rect). */
const BOX_TYPES: LayerType[] = [LayerType.Shape, LayerType.Shader];
type LayerType = (typeof LayerType)[keyof typeof LayerType];
/** A new video starts blank: the agent designs everything. */
const EMPTY_SCENE = JSON.stringify({ width: 1080, height: 1920, fps: 30, duration: 6, layers: [] });
const REVIEW_PROBE = 32;
const BLANK_VARIANCE = 0.0004;
const OFF_FRAME_TOLERANCE = 0.08;
const TEXT_OVERLAP = 0.08;
/** Shapes bigger than this share of the frame are backgrounds: text may sit on them freely. */
const BACKDROP_SHARE = 0.55;
/** Breathing room (px) text should keep from the edge of the shape it sits in. */
const EDGE_PADDING = 6;
/** Two texts on one line closer than this × their height read as one jammed word. */
const JAMMED_GAP = 0.2;
/** Share of the frame in saturated color above which the palette reads as "vibe coded". */
const SATURATED_SHARE = 0.4;
/** Each of violet, magenta and cyan above this share of the saturated pixels = the neon AI cliché. */
const NEON_TRIO_SHARE = 0.12;
/** Motion sampling rate for the per-layer checks and strips. */
const MOTION_FPS = 12;
/** Px per sample (at 1/12 s) that counts as a sudden stop (expo-out starts fast on purpose). */
const ABRUPT_PX = 22;
/** Px per sample below which a layer counts as still. */
const STILL_PX = 0.6;
/** Seconds a visible text/image may hold perfectly still before it reads as dead. */
const MAX_HOLD = 2.6;
/** This many layers starting at the same instant is a crowd: stagger them. */
const CROWD = 6;
/** Strips: how many, and frames per strip. */
const STRIPS = 2;
const STRIP_FRAMES = 8;
/** Animated properties whose linear keys look mechanical. */
const EASED_PROPS = ["x", "y", "scale", "rotation", "w", "h"];
const STILL_DIFF = 0.004;
/** Consecutive unchanged samples that count as dead air. */
const STILL_RUN = 3;

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
  private loadingTextures = new Set<string>();
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

  /** Attach the engine to a canvas (one per editor screen) and load `sceneJson`, or a blank canvas for the agent. */
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
      this.loadingTextures.clear();
      this.loadingImages.clear();
      this.engine.loadScene(sceneJson ?? EMPTY_SCENE);
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
    for (const op of ops) this.fontsFor(op.typography);
    this.text3dFontsFor(ops);
    this.changed();
  }

  /** Load the fonts 3D text names explicitly (the typography's font is loaded by fontsFor). */
  private text3dFontsFor(value: unknown) {
    for (const [family, weights] of text3dFonts(value)) void this.ensureFonts(family, [...weights]);
  }

  /** Load the Google Font a typography (from an op or a scene) asks for. */
  private fontsFor(typography: unknown) {
    const t = typography as { family?: string; body?: number; heading?: number } | null | undefined;
    if (t?.family) void this.ensureFonts(t.family, [t.body ?? 500, t.heading ?? 700]);
  }

  /** Ops derived from the user's bricks (palette…). Re-applied on every scene load so an agent can't drop them. */
  private buildOps: Op[] = [];

  setBuildOps(ops: Op[]) {
    this.buildOps = ops;
    if (this.engine) this.applyOps(ops);
  }

  loadScene(json: string) {
    const engine = this.require();
    // A broken custom shader is an error here too, as it is for ops (the editor still opens saved scenes).
    const badShader = checkSceneShaders(json);
    if (badShader) throw new Error(badShader);
    engine.loadScene(json);
    const parsed = JSON.parse(json) as { typography?: unknown };
    this.fontsFor(parsed.typography);
    this.text3dFontsFor(parsed);
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
    await this.ensureModelTextures();
    this.draw();
  }

  /** A model image by its engine key: a file next to the models or bytes embedded in a GLB. */
  private fetchModelTexture(key: string, embedded: Uint8Array | undefined) {
    let p = this.textureCache.get(key);
    if (!p) {
      p = (embedded ? decodeBytes(embedded) : decodePng(modelFileUrl(key))).catch(() => null);
      this.textureCache.set(key, p);
    }
    return p;
  }

  /** Images loaded models need beyond their pack's shared texture (own files, embedded images). */
  private async ensureModelTextures() {
    const engine = this.engine;
    if (!engine) return;
    const missing = engine.missingTextures().filter((k) => !this.loadingTextures.has(k));
    missing.forEach((k) => this.loadingTextures.add(k));
    await Promise.all(
      missing.map(async (key) => {
        const px = await this.fetchModelTexture(key, engine.embeddedTexture(key));
        if (px && engine === this.engine) engine.addTexture(key, px.rgba, px.width, px.height);
      }),
    );
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
    // Also the images inside component instances.
    const srcs = this.require().imageSources().filter(Boolean);
    const out = await Promise.all(srcs.map(async (src) => ({ src, px: await this.fetchImage(src) })));
    return out.filter((o): o is { src: string; px: Pixels } => o.px !== null).map((o) => ({ src: o.src, ...o.px }));
  }

  /** Every model and pack texture the scene needs, for another engine (export). */
  async stageAssets(): Promise<{ models: { key: string; bytes: Uint8Array }[]; textures: ({ pack: string } & Pixels)[] }> {
    const engine = this.require();
    const keys = engine.modelKeys();
    const models = (await Promise.all(keys.map(async (key) => ({ key, bytes: new Uint8Array(await this.fetchModel(key).catch(() => new ArrayBuffer(0))) })))).filter(
      (m) => m.bytes.length > 0,
    );
    // Pack textures plus every model image the preview engine registered (own files, embedded).
    const packs = [...new Set(keys.map(packOf))].map(async (pack) => ({ pack, px: await this.fetchTexture(pack) }));
    const images = engine
      .textureKeys()
      .filter((k) => k.includes("/") || k.includes("#"))
      .map(async (key) => ({ pack: key, px: await this.fetchModelTexture(key, engine.embeddedTexture(key)) }));
    const textures = (await Promise.all([...packs, ...images]))
      .filter((t): t is { pack: string; px: Pixels } => t.px !== null)
      .map((t) => ({ pack: t.pack, ...t.px }));
    return { models, textures };
  }

  /** Every font file fetched so far, to hand to another engine (export). */
  async loadedFontFiles(): Promise<{ family: string; weight: number; bytes: Uint8Array }[]> {
    const scene = JSON.parse(this.require().sceneJson()) as { typography?: { family: string; body: number; heading: number } | null };
    const typo = scene.typography;
    const files = [
      ...fontFilesFor(DEFAULT_FONT_FAMILY),
      ...(typo ? fontFilesFor(typo.family, [typo.body, typo.heading]) : []),
      ...[...text3dFonts(scene)].flatMap(([family, weights]) => fontFilesFor(family, [...weights])),
    ];
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
    void sfxPlayer.start(useEditor.getState().time, this.sfxCues());
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.audio?.pause();
    sfxPlayer.stop();
    useEditor.setState({ playing: false });
  }

  seek(t: number) {
    useEditor.setState({ time: Math.max(0, Math.min(t, useEditor.getState().duration)) });
    this.syncAudio(false);
    if (useEditor.getState().playing) void sfxPlayer.start(useEditor.getState().time, this.sfxCues());
    this.draw();
  }

  /** The scene's sound effect cues. */
  sfxCues(): SfxCue[] {
    if (!this.engine) return [];
    return (JSON.parse(this.sceneJson()) as { sfx?: SfxCue[] }).sfx ?? [];
  }

  private tick = (now: number) => {
    const { time, duration } = useEditor.getState();
    const next = time + (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (next >= duration && this.loop) {
      useEditor.setState({ time: 0 });
      void sfxPlayer.start(0, this.sfxCues());
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

  /**
   * Self-review for the agent: renders `frames` evenly spaced frames into one contact sheet
   * and flags visible problems (layers off frame, overlapping text, dead stretches, blank frames).
   */
  review(frames: number): ReviewReport {
    const canvas = this.canvas;
    const duration = this.duration();
    if (!canvas || !this.engine) return { duration, times: [], sheet: "", issues: ["engine not ready"], motion: [], strips: [] };
    const [sw, sh] = this.size;
    const n = Math.max(4, Math.min(24, frames));
    const times = Array.from({ length: n }, (_, i) => +((duration * (i + 0.5)) / n).toFixed(2));
    const cols = n <= 8 ? 4 : 6;
    const cellW = 240;
    const cellH = Math.round((cellW * sh) / sw);
    const labelH = 18;
    const sheet = document.createElement("canvas");
    sheet.width = cols * cellW;
    sheet.height = Math.ceil(n / cols) * (cellH + labelH);
    const g = sheet.getContext("2d")!;
    g.fillStyle = "#111";
    g.fillRect(0, 0, sheet.width, sheet.height);
    g.font = "12px sans-serif";
    // Tiny grayscale copies to compare frames.
    const probe = document.createElement("canvas");
    probe.width = REVIEW_PROBE;
    probe.height = REVIEW_PROBE;
    const pg = probe.getContext("2d", { willReadFrequently: true })!;
    const probes: Float32Array[] = [];
    // Same problem across frames is reported once, with when it happens.
    const found = new Map<string, number[]>();
    const flag = (what: string, t: number) => found.set(what, [...(found.get(what) ?? []), t]);
    // Instances are followed by their layers (`instance/layer`), which the checks measure one by one.
    const layers = JSON.parse(this.require().flatLayers()) as ReviewLayer[];
    let saturated = 0;
    let sampled = 0;
    /** Particle layers seen at the review times, and whether any particle was ever alive. */
    const swarms = new Map<string, boolean>();
    const hues = { violet: 0, magenta: 0, cyan: 0 };

    times.forEach((t, i) => {
      this.engine!.render(t);
      const x = (i % cols) * cellW;
      const y = Math.floor(i / cols) * (cellH + labelH);
      g.drawImage(canvas, x, y + labelH, cellW, cellH);
      g.fillStyle = "#ddd";
      g.fillText(`${i + 1} · ${t}s`, x + 4, y + 13);
      pg.drawImage(canvas, 0, 0, REVIEW_PROBE, REVIEW_PROBE);
      const px = pg.getImageData(0, 0, REVIEW_PROBE, REVIEW_PROBE).data;
      const lum = new Float32Array(REVIEW_PROBE * REVIEW_PROBE);
      for (let k = 0; k < lum.length; k++) {
        const [r, gr, b] = [px[k * 4]! / 255, px[k * 4 + 1]! / 255, px[k * 4 + 2]! / 255];
        lum[k] = r * 0.3 + gr * 0.59 + b * 0.11;
        const [h, sat, l] = hsl(r, gr, b);
        sampled++;
        if (sat > 0.35 && l > 0.12 && l < 0.88) {
          saturated++;
          if (h >= 250 && h < 290) hues.violet++;
          else if (h >= 290 && h < 340) hues.magenta++;
          else if (h >= 170 && h < 205) hues.cyan++;
        }
      }
      probes.push(lum);
      const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
      const variance = lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length;
      if (variance < BLANK_VARIANCE) flag("blank frame: nothing visible", t);

      const boxes = layers
        .filter((l) => t >= (l.start ?? 0) && (l.end == null || t < l.end))
        .flatMap((l) => {
          const b = this.engine!.layerBounds(l.id, t);
          if (!b) return [];
          const [cx = 0, cy = 0, w = 0, h = 0] = b;
          return [{ l, x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, area: w * h }];
        });
      // Particles flying off frame are normal; they are judged by their counts instead.
      for (const row of this.layout([t])[0]?.layers ?? []) {
        const p = row.particles;
        if (!p || !row.visible) continue;
        swarms.set(row.id, (swarms.get(row.id) ?? false) || p.live > 0);
        if (p.live >= p.max) flag(`particles '${row.id}' hit max=${p.max}: rate×life is over the cap, so the oldest vanish early — lower rate/life or raise max (≤2000)`, t);
        else if (p.live > 0 && p.on_screen === 0) flag(`particles '${row.id}': all ${p.live} live particles are off frame`, t);
      }
      for (const b of boxes) {
        if (b.area <= 0 || BOX_TYPES.includes(b.l.type) || b.l.type === LayerType.Particles || b.l.type === LayerType.Use) continue;
        const inside = Math.max(0, Math.min(b.x1, sw) - Math.max(b.x0, 0)) * Math.max(0, Math.min(b.y1, sh) - Math.max(b.y0, 0));
        if (inside / b.area < 1 - OFF_FRAME_TOLERANCE) flag(`${b.l.type} '${b.l.id}' goes off frame`, t);
      }
      // Text is judged by its real glyphs, not its layer box.
      const texts = boxes
        .filter((b) => b.l.type === LayerType.Text)
        .flatMap((b) => {
          const ink = this.engine!.textInk(b.l.id, t);
          if (!ink) return [];
          const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = ink;
          return [{ l: b.l, x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) }];
        });
      const overlap = (p: Box, q: Box) => Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)) * Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0));
      for (let a = 0; a < texts.length; a++)
        for (let c = a + 1; c < texts.length; c++) {
          const p = texts[a]!;
          const q = texts[c]!;
          const ov = overlap(p, q);
          if (ov / Math.max(1, Math.min(p.area, q.area)) > TEXT_OVERLAP) {
            flag(`text '${p.l.id}' and '${q.l.id}' overlap`, t);
            continue;
          }
          const height = Math.min(p.y1 - p.y0, q.y1 - q.y0);
          const sameLine = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0) > height * 0.5;
          const gap = Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1);
          if (sameLine && gap < height * JAMMED_GAP)
            flag(`text '${p.l.id}' and '${q.l.id}' touch on one line: write the phrase as ONE text layer and mark the key word with *word*`, t);
        }
      // Text crossing the outline of a card, pill or button it is meant to sit in.
      const frame = sw * sh;
      const panels = boxes.filter((b) => BOX_TYPES.includes(b.l.type) && b.l.visible !== false && !b.l.soft && b.area < frame * BACKDROP_SHARE && b.area > 0);
      for (const tx of texts)
        for (const sp of panels) {
          const ov = overlap(tx, sp);
          if (ov <= 0) continue;
          if (ov < tx.area * 0.97) flag(`text '${tx.l.id}' crosses the edge of '${sp.l.id}'`, t);
          else if (tx.x0 - sp.x0 < EDGE_PADDING || sp.x1 - tx.x1 < EDGE_PADDING || tx.y0 - sp.y0 < EDGE_PADDING || sp.y1 - tx.y1 < EDGE_PADDING)
            flag(`text '${tx.l.id}' touches the edge of '${sp.l.id}' (give it padding)`, t);
        }
    });

    for (const [id, seen] of swarms)
      if (!seen) found.set(`particles '${id}' never has a live particle at the review times: set rate= and/or burst= inside its span (and life=)`, [times[0]!]);
    const share = saturated / Math.max(1, sampled);
    if (share > SATURATED_SHARE)
      flag(`palette: ${Math.round(share * 100)}% of the frame is saturated color — pro films keep neutrals (near-black/white/warm grey) ≥60% and save saturation for small accents`, times[0]!);
    if (saturated > 0 && Object.values(hues).every((n) => n / saturated > NEON_TRIO_SHARE))
      flag("palette: violet + magenta + cyan neon is the generic AI look — pick ONE hue family plus one small contrasting accent", times[0]!);
    const issues = [...found].map(([what, ts]) => `${what} (${ts.length > 1 ? `${ts[0]}s-${ts[ts.length - 1]}s` : `${ts[0]}s`})`);
    for (const [id, why] of JSON.parse(this.engine!.shaderFailures()) as [string, string][]) issues.push(`custom shader on '${id}' draws nothing: ${why}`);
    const diff = (a: Float32Array, b: Float32Array) => a.reduce((s, v, k) => s + Math.abs(v - b[k]!), 0) / a.length;
    const deltas = probes.slice(1).map((p, i) => diff(probes[i]!, p));
    if (deltas.every((d) => d < STILL_DIFF)) issues.push("the whole video looks static: nothing visibly moves between frames");
    else {
      let run = 0;
      deltas.forEach((d, i) => {
        run = d < STILL_DIFF ? run + 1 : 0;
        if (run === STILL_RUN) issues.push(`nothing moves from ${times[i + 1 - STILL_RUN]}s to ${times[i + 1]}s (dead air)`);
      });
    }
    const motion = this.motionNotes(layers, duration);
    // The moments that change most, seen as consecutive frames.
    const peaks = deltas
      .map((d, i) => ({ d, t: (times[i]! + times[i + 1]!) / 2 }))
      .sort((a, b) => b.d - a.d)
      .slice(0, STRIPS)
      .sort((a, b) => a.t - b.t);
    const strips = peaks.map(({ t }) => this.strip(Math.max(0, t - STRIP_FRAMES / 2 / MOTION_FPS), duration));
    this.draw();
    return { duration, times, sheet: sheet.toDataURL("image/jpeg", 0.8), issues, motion, strips };
  }

  /** `STRIP_FRAMES` consecutive frames at `MOTION_FPS` from `from`, in one row of 4 × 2. */
  private strip(from: number, duration: number): { from: number; to: number; image: string } {
    const canvas = this.canvas!;
    const [sw, sh] = this.size;
    const cellW = 300;
    const cellH = Math.round((cellW * sh) / sw);
    const out = document.createElement("canvas");
    const cols = 4;
    out.width = cols * cellW;
    out.height = Math.ceil(STRIP_FRAMES / cols) * cellH;
    const g = out.getContext("2d")!;
    g.font = "12px sans-serif";
    let last = from;
    for (let k = 0; k < STRIP_FRAMES; k++) {
      const t = Math.min(duration - 0.01, from + k / MOTION_FPS);
      last = t;
      this.engine!.render(t);
      const x = (k % cols) * cellW;
      const y = Math.floor(k / cols) * cellH;
      g.drawImage(canvas, x, y, cellW, cellH);
      g.fillStyle = "rgba(0,0,0,0.6)";
      g.fillRect(x, y, 52, 16);
      g.fillStyle = "#fff";
      g.fillText(`${t.toFixed(2)}s`, x + 4, y + 12);
    }
    return { from: +from.toFixed(2), to: +last.toFixed(2), image: out.toDataURL("image/jpeg", 0.75) };
  }

  /** Per-layer motion checks from the layers' boxes at `MOTION_FPS`, plus keyframe easing. */
  private motionNotes(layers: ReviewLayer[], duration: number): string[] {
    const notes: string[] = [];
    const [sw, sh] = this.size;
    // A stop that happens off screen (zoom-throughs, wipes) is a cut on motion, not a flaw.
    const onScreen = (cx: number, cy: number, w: number, h: number) =>
      Math.max(0, Math.min(cx + w / 2, sw) - Math.max(cx - w / 2, 0)) * Math.max(0, Math.min(cy + h / 2, sh) - Math.max(cy - h / 2, 0)) > Math.max(1, w * h) * 0.25 && w < sw * 3;
    const abruptStops: string[] = [];
    const linearLayers: string[] = [];
    const steps = Math.floor(duration * MOTION_FPS);
    const fmt = (t: number) => `${t.toFixed(1)}s`;
    for (const l of layers) {
      // A particle layer's box is its swarm: it grows and shrinks by design. Instances are measured by their inner layers.
      if (l.visible === false || l.camera || l.type === LayerType.Particles || l.type === LayerType.Use) continue;
      let prev: number[] | null = null;
      let prevSpeed = 0;
      let stillSince: number | null = null;
      let abrupt = 0;
      let longest = { from: 0, len: 0 };
      for (let k = 0; k <= steps; k++) {
        const t = k / MOTION_FPS;
        const b = this.engine!.layerBounds(l.id, t);
        if (!b) {
          prev = null;
          stillSince = null;
          continue;
        }
        const [cx = 0, cy = 0, w = 0, h = 0, r = 0] = b;
        if (prev) {
          const speed = Math.hypot(cx - prev[0]!, cy - prev[1]!) + Math.abs(w - prev[2]!) / 2 + Math.abs(h - prev[3]!) / 2 + Math.abs(r - prev[4]!) * 100;
          if (prevSpeed > ABRUPT_PX && speed < STILL_PX && onScreen(cx, cy, w, h)) abrupt++;
          if (speed < STILL_PX) {
            stillSince ??= t;
            const len = t - stillSince;
            if (len > longest.len) longest = { from: stillSince, len };
          } else stillSince = null;
          prevSpeed = speed;
        }
        prev = [cx, cy, w, h, r];
      }
      const big = (l.type === LayerType.Text || l.type === LayerType.Image) && longest.len > MAX_HOLD;
      if (big) notes.push(`'${l.id}' holds perfectly still ${fmt(longest.from)}-${fmt(longest.from + longest.len)}: add a slow drift/scale or move the camera`);
      if (abrupt > 0) abruptStops.push(l.id);
      if (EASED_PROPS.some((p) => Array.isArray(l[p]) && (l[p] as { ease?: string }[]).slice(0, -1).some((k) => k.ease === "linear"))) linearLayers.push(l.id);
    }
    const some = (ids: string[]) => `${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ` +${ids.length - 6}` : ""}`;
    if (abruptStops.length) notes.push(`${abruptStops.length} layer(s) slam to a stop at full speed (${some(abruptStops)}): end moves with an ease-out (eo/o) or a spring`);
    if (linearLayers.length) notes.push(`${linearLayers.length} layer(s) move with linear keys (${some(linearLayers)}): mechanical — use expo/back/spring curves`);
    const starts = new Map<string, string[]>();
    for (const l of layers) {
      if (l.visible === false) continue;
      const key = (l.start ?? 0).toFixed(2);
      starts.set(key, [...(starts.get(key) ?? []), l.id]);
    }
    for (const [t, ids] of starts)
      if (ids.length >= CROWD && Number(t) > 0) notes.push(`${ids.length} layers start together at ${t}s (${ids.slice(0, 4).join(", ")}…): stagger them 0.03-0.08 s`);
    if (!layers.some((l) => l.camera)) notes.push(`no camera layer: add one (a vis=0 layer with cam=…) and move it — slow push, drifts, fly-throughs; static frames read as slides`);
    return notes;
  }

  /** Where every layer lands on screen at each time (what the agent checks instead of test renders). */
  layout(times: number[]): FrameLayout[] {
    if (!this.engine) return [];
    return times.map((t) => ({ t, ...(JSON.parse(this.engine!.layout(t)) as Omit<FrameLayout, "t">) }));
  }

  sceneSize(): [number, number] {
    return this.size;
  }

  pick(x: number, y: number): string | undefined {
    return this.engine?.pick(useEditor.getState().time, x, y);
  }

  /** A layer's JSON (to edit it directly without the agent). */
  layer(id: string): Record<string, unknown> | undefined {
    const json = this.engine?.layerJson(id);
    return json ? (JSON.parse(json) as Record<string, unknown>) : undefined;
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

type Box = { x0: number; y0: number; x1: number; y1: number };

/** Hue (degrees), saturation and lightness of an RGB color in 0..1. */
function hsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
