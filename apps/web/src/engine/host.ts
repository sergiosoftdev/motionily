import type { ImportedTimeline } from "../editor/edit/timelinePlan";
import init, { Engine, analyzeAudio, captionStyles, checkSceneShaders, clearAudioAnalysis, parseTimeline, stylePalettes, stylePresets } from "./pkg/engine_wasm.js";
import type { Loudness, Mix } from "@motionily/protocol";
import { audioBus } from "../audio/bus";
import { workerViewer, type WorkerSource } from "./workerViewer";
import { measureLoudness } from "../audio/loudness";
import { mixAudio } from "../export/exportVideo";
import type { MusicTrack } from "../audio/music";
import type { SfxCue } from "../audio/sfxPlayer";
import { loadMix, sfxCues, type MixScene, type MixSources } from "../audio/mix";
import { decodeAudio } from "../audio/decode";
import { PreviewMix } from "../audio/preview";
import { OpName, type CaptionStyle, type FrameLayout, type Marker, type Op, type ReviewReport, type StylePreset, type WorkArea } from "@motionily/protocol";
import { DEFAULT_FONT_FAMILY, fontFilesFor, text3dFonts } from "./fonts";
import { decodeBytes, decodePng, modelFileUrl, modelUrl, packOf, packTextureUrl, type Pixels } from "./models";
import { mediaUrl } from "../api/client";
import { ActivitySource, EngineStatus, logActivity, useEditor } from "../store";
import { AUDIO_LAYER, VIDEO_LAYER, VideoLibrary, VideoStatus, clipSounds, hasSound, type ClipSound, type FrameCache } from "./video";
import { decodeMono, type AudioAnalysisInfo } from "./audioReactive";
import type { AudioTrack } from "../audio/track";
import { nativeViewer } from "../native/viewer";
import { RenderCache } from "./renderCache";
import { PixelCache } from "./pixelCache";
import { perf } from "./perf";
import { liveMeter } from "../audio/meter";

/** A layer under the pointer (see `pickStack`). */
export type PickHit = { id: string; cover: boolean };
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
const LayerType = { Shape: "shape", Text: "text", Image: "image", Video: VIDEO_LAYER, Character: "character", Particles: "particles", Use: "use", Shader: "shader" } as const;
/** Box-like layers: backgrounds may bleed off frame, and text sits inside them (shader layers fill a box like a rect). */
const BOX_TYPES: LayerType[] = [LayerType.Shape, LayerType.Shader];
type LayerType = (typeof LayerType)[keyof typeof LayerType];
/** Absolute URL of a layer's media src. */
const mediaSrc = (src: string) => (src.startsWith("/media/") ? mediaUrl(src) : src);

/** A new video starts blank: the agent designs everything. */
/** Per-viewer switch for preview proxies (on by default). */
const PROXY_PREF = "motionily.proxies";
function readProxyPref(): boolean {
  try {
    return localStorage.getItem(PROXY_PREF) !== "off";
  } catch {
    return true;
  }
}
/** Decoded images and textures kept in memory for re-use, each cache (see pixelCache). */
const PIXEL_BUDGET = 160 * 1024 * 1024;
/** One display frame (a 60 Hz screen), what lateness is measured against. */
const DISPLAY_FRAME_MS = 1000 / 60;
/** Stillness (ms) before heavy frames are rendered ahead (not between two edits), and frames rendered between yields. */
const FILL_IDLE_MS = 2500;
const FILL_BATCH = 4;

/** The canvas cached frames are shown on: over the engine's, same box, never in the way of the pointer. */
function makeOverlay(): HTMLCanvasElement {
  const o = document.createElement("canvas");
  o.dataset.renderCache = "";
  Object.assign(o.style, { position: "absolute", pointerEvents: "none", visibility: "hidden" });
  return o;
}

/**
 * Put the overlay exactly over the canvas, wherever it is now: the editors move the canvas between
 * stages, a vertical frame slides sideways without resizing when the stage gets wider, and zoom
 * scales it with a transform. Done each time a cached frame is shown, so it never lags behind.
 */
function placeOverlay(o: HTMLCanvasElement, canvas: HTMLCanvasElement) {
  const parent = canvas.parentElement;
  if (!parent) return;
  if (o.previousElementSibling !== canvas) canvas.after(o);
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  const cs = getComputedStyle(canvas);
  Object.assign(o.style, {
    left: `${canvas.offsetLeft}px`,
    top: `${canvas.offsetTop}px`,
    width: `${canvas.offsetWidth}px`,
    height: `${canvas.offsetHeight}px`,
    borderRadius: cs.borderRadius,
    transform: cs.transform === "none" ? "" : cs.transform,
    transformOrigin: cs.transformOrigin,
  });
}

/** A task boundary without the 4 ms clamp of nested timeouts. */
const channel = typeof MessageChannel === "undefined" ? null : new MessageChannel();
const yieldTask = () =>
  new Promise<void>((resolve) => {
    if (!channel) return void setTimeout(resolve, 0);
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });

/** Resolves once the GPU has finished what `engine` submitted until now. */
async function gpuDone(engine: Engine) {
  const ticket = engine.watchWork();
  while (!engine.workDone(ticket)) await yieldTask();
}

/** How long one scrub plays (a couple of frames of sound, as editors do). */
const SCRUB_MS = 90;
const SCRUB_PREF = "motionily.scrubAudio";

/** Quiet time after a soundtrack edit before it is rescheduled while playing. */
const REMIX_MS = 150;
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
/** Smallest text that still reads on a phone, as a share of the frame's short side (26 px on 1080). */
const MIN_TEXT_SHARE = 0.024;
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

type SceneMeta = {
  style: StylePreset;
  caption_style: CaptionStyle;
  duration: number;
  width: number;
  height: number;
  fps?: number;
  audio?: AudioTrack | null;
  music?: MusicTrack | null;
  captions?: { words?: { start: number; end: number }[] } | null;
  markers?: Marker[];
  work_area?: WorkArea;
  mix?: Mix | null;
};


/**
 * Owns the Rust engine and the playback loop, outside React. React only reads
 * the store and calls these methods; frames never go through React renders.
 */
class EngineHost {
  private engine: Engine | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private lastTick = 0;
  /**
   * Playback's own clock (seconds). The store's `time` follows it only when the scene frame changes:
   * a 30 fps video on a 120 Hz screen renders and re-renders the editor 30 times a second, not 120.
   */
  private playhead = 0;
  private shownFrame = -1;
  /** Shuttle speed (J/K/L): 1 plays normally; anything else scrubs silently, backwards when negative. */
  private rate = 1;
  private listeners = new Set<() => void>();

  /** Font files already handed to the current engine, by url. */
  private loadedFonts = new Set<string>();
  private fontCache = new Map<string, Promise<ArrayBuffer>>();
  /** 3D models and pack textures, fetched once and shared with export engines. */
  private modelCache = new Map<string, Promise<ArrayBuffer>>();
  private textureCache = new PixelCache(PIXEL_BUDGET);
  private loadingModels = new Set<string>();
  private loadingTextures = new Set<string>();
  private loadingImages = new Set<string>();
  /** `.cube` files the color effects use, as loaded (export engines get them too). */
  private lutTexts = new Map<string, string>();
  private lutsLoading: Promise<void> = Promise.resolve();
  private imageCache = new PixelCache(PIXEL_BUDGET);

  /** Heavy frames rendered ahead while paused, shown on `overlay` during playback (see renderCache). */
  private cache = new RenderCache();
  private sceneVersion = 0;
  private sceneFps = 30;
  private overlay: HTMLCanvasElement | null = null;
  private fillTimer = 0;
  /** The soundtrack (voice, music, effects, clip sound), scheduled as the export mixes it; also the playback clock. */
  private mix = new PreviewMix();
  private mixKey = "";
  private audioUrl: string | null = null;
  /** Analysis of `audioUrl` for audio-reactive expressions; resolves once installed in the engine. */
  private audioAnalysis: Promise<void> = Promise.resolve();
  audioInfo: AudioAnalysisInfo | null = null;
  /** The analysed soundtrack's samples, for the playback worker's engine. */
  private audioSamples: { samples: Float32Array; rate: number } | null = null;
  /** Video files (decoders shared with export engines), frames uploaded to this engine, clip sounds. */
  private videos = new VideoLibrary((src) => this.previewSrc(src), () => this.draw());
  /** The original files, for exports (the preview may play proxies instead). */
  private originals = new VideoLibrary(mediaSrc);
  /** Preview proxies by clip src, and whether the preview plays them. */
  private proxies: Record<string, string> = {};
  private useProxies = readProxyPref();
  private frames: FrameCache = new Map();
  private size: [number, number] = [1080, 1920];

  /** Restart at the end instead of stopping (turntable previews). */
  loop = false;
  /** The scene's work area and markers, as of the last change. */
  private range: WorkArea = null;
  private marks: Marker[] = [];

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
      this.wasmReady ??= init().then((wasm) => {
        perf.wasmBytes = () => wasm.memory.buffer.byteLength;
        perf.cacheBytes = () => this.cache.byteSize;
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
      this.frames = new Map();
      this.buildOps = [];
      this.loadedFonts.clear();
      this.loadingModels.clear();
      this.loadingTextures.clear();
      this.loadingImages.clear();
      this.engine.loadScene(sceneJson ?? EMPTY_SCENE);
      void this.ensureFonts(DEFAULT_FONT_FAMILY);
      this.cache.clear();
      this.overlay = makeOverlay();
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
    workerViewer.detach();
    this.loop = false;
    void this.setAudio(null);
    this.videos.dispose();
    this.videos = new VideoLibrary((src) => this.previewSrc(src), () => this.draw());
    this.originals.dispose();
    this.originals = new VideoLibrary(mediaSrc);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.clearTimeout(this.fillTimer);
    this.overlay?.remove();
    this.overlay = null;
    this.cache.clear();
    this.engine?.free();
    this.engine = null;
    this.canvas = null;
  }

  /** Called after every scene change, from the agent or the user. */
  onSceneChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Bumps with every change to the scene (to tell whether a copy of it is still current). */
  get revision() {
    return this.sceneVersion;
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
    return this.textureCache.get(pack, () => decodePng(packTextureUrl(pack)).catch(() => null));
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
    return this.textureCache.get(key, () => (embedded ? decodeBytes(embedded) : decodePng(modelFileUrl(key))).catch(() => null));
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
    return this.imageCache.get(src, () => decodePng(src.startsWith("/media/") ? mediaUrl(src) : src).catch(() => null));
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

  /** Load the LUTs the color effects name and the engine does not have yet. */
  ensureLuts(): Promise<void> {
    const engine = this.engine;
    if (!engine) return this.lutsLoading;
    const missing = engine.missingLuts();
    if (!missing.length) return this.lutsLoading;
    this.lutsLoading = Promise.all(
      missing.map(async (src) => {
        const text = this.lutTexts.get(src) ?? (await fetch(mediaUrl(src)).then((r) => (r.ok ? r.text() : null)).catch(() => null));
        if (text == null || engine !== this.engine) return;
        try {
          engine.addLut(src, text);
          this.lutTexts.set(src, text);
        } catch (e) {
          logActivity(ActivitySource.System, `LUT ${src.split("/").pop()} not loaded: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    ).then(() => this.draw());
    return this.lutsLoading;
  }

  /** The scene's LUTs as `.cube` text, for another engine (export, the desktop app's native one). */
  async lutAssets(): Promise<{ src: string; text: string }[]> {
    await this.ensureLuts();
    const srcs = this.engine?.lutSources() ?? [];
    return srcs.flatMap((src) => {
      const text = this.lutTexts.get(src);
      return text == null ? [] : [{ src, text }];
    });
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

  /** Use `url` as the project audio (preview + audio-reactive analysis). Resolves once analysed. */
  setAudio(url: string | null): Promise<void> {
    if (url === this.audioUrl) return this.audioAnalysis;
    this.audioUrl = url;
    // Decoded ahead, so the first play starts at once.
    if (url) void decodeAudio(url);
    this.audioInfo = null;
    this.audioSamples = null;
    this.audioAnalysis = this.analyzeAudio(url);
    return this.audioAnalysis;
  }

  private async analyzeAudio(url: string | null) {
    if (!this.wasmReady) return;
    await this.wasmReady;
    if (!url) {
      clearAudioAnalysis();
      this.draw();
      return;
    }
    try {
      const { samples, rate } = await decodeMono(url);
      // A newer file replaced this one while it decoded.
      if (url !== this.audioUrl) return;
      this.audioInfo = JSON.parse(analyzeAudio(samples, rate)) as AudioAnalysisInfo;
      this.audioSamples = { samples, rate };
    } catch {
      if (url === this.audioUrl) clearAudioAnalysis();
    }
    this.draw();
  }

  /** What the preview opens for a clip: its proxy when it has one (and proxies are on), else the file. */
  previewSrc(src: string): string {
    return mediaSrc(this.useProxies ? (this.proxies[src] ?? src) : src);
  }

  /** Clip src → proxy src (from the project's footage); the preview reopens its clips when they change. */
  setProxies(map: Record<string, string>) {
    if (JSON.stringify(map) === JSON.stringify(this.proxies)) return;
    this.proxies = map;
    this.reopenPreviewClips();
  }

  /** Play proxies in the preview (a per-viewer choice; exports always use the originals). */
  setUseProxies(on: boolean) {
    if (on === this.useProxies) return;
    this.useProxies = on;
    try {
      localStorage.setItem(PROXY_PREF, on ? "on" : "off");
    } catch {
      // Storage blocked: the choice lasts this session.
    }
    this.reopenPreviewClips();
  }

  get proxiesOn() {
    return this.useProxies;
  }

  /** The scene for the desktop app's native viewer: clip sources swapped for their proxies (decoded by ffmpeg there). */
  private viewerScene(): string {
    let json = this.sceneJson();
    if (!this.useProxies) return json;
    for (const [src, proxy] of Object.entries(this.proxies)) json = json.split(JSON.stringify(src)).join(JSON.stringify(proxy));
    return json;
  }

  private reopenPreviewClips() {
    if (useEditor.getState().playing) void workerViewer.reload(this.sceneJson(), this.workerSource);
    this.videos.dispose();
    this.videos = new VideoLibrary((src) => this.previewSrc(src), () => this.draw());
    this.frames = new Map();
    this.draw();
  }

  /** Resolves once the audio is analysed and every video file is open: export and agent renders wait for it. */
  async mediaReady() {
    await this.audioAnalysis;
    await this.ensureLuts();
    if (this.engine) await this.videos.ready(this.engine);
  }

  /** Video decoders, for export engines. */
  videoLibrary(): VideoLibrary {
    return this.originals;
  }

  /** The Edit timeline as FCPXML, OTIO or EDL, sources under `mediaRoot`, with the voice-over as a clip. */
  /** A timeline from another editor (FCPXML, Final Cut Pro 7 XML, OpenTimelineIO): its clips by track. Throws when unreadable. */
  parseTimeline(text: string): ImportedTimeline {
    this.require();
    return JSON.parse(parseTimeline(text)) as ImportedTimeline;
  }

  timelineFile(format: "fcpxml" | "otio" | "edl", name: string, mediaRoot: string): string {
    const voice = this.audioUrl ? new URL(this.audioUrl, location.href).pathname : undefined;
    return this.require().timelineFile(format, name, mediaRoot, voice?.startsWith("/media/") ? voice : this.audioUrl ?? undefined);
  }

  /** The captions as SRT or WebVTT, cue by cue as on screen (empty without captions); `range` = an exported part. */
  subtitles(format: "srt" | "vtt", range?: [number, number] | null): string {
    return this.require().subtitles(format, range?.[0], range?.[1]);
  }

  /** Loudness of the mix as it exports, at a master level of 0 dB without the master effects, or at `masterDb` with them (null when silent). */
  async mixLoudness(masterDb?: number): Promise<Loudness | null> {
    await this.mediaReady();
    const mix = await mixAudio(this.sceneJson(), this.audioUrl, this.clipSounds(), masterDb === undefined ? { master: false } : { masterDb });
    if (!mix) return null;
    return measureLoudness(Array.from({ length: mix.numberOfChannels }, (_, c) => mix.getChannelData(c)), mix.sampleRate);
  }

  /** What the video clips play and how loud, over the whole video (the native exporter mixes it in). */
  clipSounds(): ClipSound[] {
    const scene = JSON.parse(this.sceneJson()) as { fps: number; duration: number };
    return this.engine ? clipSounds(this.engine, scene.fps, scene.duration) : [];
  }

  /** Scene `work_area` `[in, out]` (null = the whole video): playback loops inside it. */
  workArea(): WorkArea {
    return this.range;
  }

  /** Scene timeline markers, sorted by time. */
  markers(): Marker[] {
    return this.marks;
  }

  /** Where playback runs: the work area clipped to the video, or the whole video. */
  private playRange(): [number, number] {
    const { duration } = useEditor.getState();
    const [a, b] = this.range ?? [0, duration];
    return a < duration ? [a, Math.min(b, duration)] : [0, duration];
  }

  /**
   * J/K/L shuttle: play at `rate` (−4…4; negative plays backwards). Away from 1× the sound is silent,
   * like an editor's shuttle; 0 pauses.
   */
  shuttle(rate: number) {
    if (rate === 0) return this.pause();
    this.rate = rate;
    if (useEditor.getState().playing) {
      if (rate !== 1) this.mix.stop();
      else this.startMix(useEditor.getState().time);
      this.lastTick = performance.now();
      workerViewer.jump(this.playhead, rate);
      return;
    }
    if (rate === 1) return this.play();
    useEditor.setState({ playing: true });
    this.mix.stop();
    this.playhead = useEditor.getState().time;
    this.shownFrame = -1;
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.startViewer();
  }

  /** Current shuttle speed (1 = normal playback). */
  get shuttleRate() {
    return useEditor.getState().playing ? this.rate : 0;
  }

  play() {
    this.rate = 1;
    if (useEditor.getState().playing) return;
    const { time } = useEditor.getState();
    const [from, to] = this.playRange();
    if (time >= to || (this.range && time < from)) useEditor.setState({ time: from });
    useEditor.setState({ playing: true });
    perf.playing = true;
    this.playhead = useEditor.getState().time;
    this.shownFrame = -1;
    // Inside the click that plays: browsers only start WebAudio on a gesture.
    audioBus.context();
    liveMeter.reset();
    this.startMix(this.playhead);
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.startViewer();
  }

  /** What the playback worker draws from: this engine's scene and assets. */
  private readonly workerSource: WorkerSource = {
    fonts: () => this.loadedFontFiles(),
    stage: () => this.stageAssets(),
    images: () => this.imageAssets(),
    luts: () => this.lutAssets(),
    audio: () => this.audioSamples,
    urls: () => Object.fromEntries((this.engine?.videoSources() ?? []).map((src) => [src, this.previewSrc(src)])),
    fps: () => this.fps(),
  };

  /** Playback drawn elsewhere: the desktop app's native viewer, else a worker (the editor's canvas when neither can). */
  private startViewer() {
    const canvas = this.canvas;
    const engine = this.engine;
    if (!canvas || !engine) return;
    const t = useEditor.getState().time;
    void nativeViewer.start(canvas, this.viewerScene(), this, t).then(() => {
      if (nativeViewer.active || !useEditor.getState().playing || engine !== this.engine) return;
      void workerViewer.start(canvas, engine.adapterInfo(), this.sceneJson(), this.workerSource, () => ({ t: this.playhead, rate: this.rate }));
    });
  }

  pause() {
    const wasPlaying = useEditor.getState().playing;
    this.rate = 1;
    cancelAnimationFrame(this.raf);
    nativeViewer.stop();
    workerViewer.stop();
    this.mix.stop();
    // The playhead lands exactly where playback stopped (the store only follows whole frames while playing).
    useEditor.setState(wasPlaying ? { playing: false, time: this.playhead } : { playing: false });
    perf.playing = false;
    // The editor's canvas comes back where playback stopped (the native viewer drew the frames meanwhile).
    if (wasPlaying) this.draw();
    this.fillSoon();
  }

  /** Whether dragging the playhead (or stepping frames) plays the sound under it. */
  get scrubAudio(): boolean {
    try {
      return localStorage.getItem(SCRUB_PREF) !== "off";
    } catch {
      return true;
    }
  }

  set scrubAudio(on: boolean) {
    try {
      localStorage.setItem(SCRUB_PREF, on ? "on" : "off");
    } catch {
      // Not critical.
    }
  }

  private scrubTimer = 0;
  private scrubMix: { version: number; sources: Promise<MixSources> } | null = null;

  /** The user drags the playhead or steps a frame: seek, and play a few frames of sound there (paused only). */
  scrub(t: number) {
    this.seek(t);
    if (useEditor.getState().playing || !this.scrubAudio || !this.engine) return;
    // The soundtrack loads once per scene version (clip sounds walk the whole timeline).
    if (this.scrubMix?.version !== this.sceneVersion) this.scrubMix = { version: this.sceneVersion, sources: this.loadMix() };
    const sources = this.scrubMix.sources;
    this.mix.start(useEditor.getState().time, () => sources);
    window.clearTimeout(this.scrubTimer);
    this.scrubTimer = window.setTimeout(() => {
      if (!useEditor.getState().playing) this.mix.stop();
    }, SCRUB_MS);
  }

  seek(t: number) {
    useEditor.setState({ time: Math.max(0, Math.min(t, useEditor.getState().duration)) });
    this.playhead = useEditor.getState().time;
    this.shownFrame = -1;
    if (useEditor.getState().playing && this.rate === 1) this.startMix(useEditor.getState().time);
    this.lastTick = performance.now();
    if (nativeViewer.active) nativeViewer.frame(useEditor.getState().time);
    if (useEditor.getState().playing) workerViewer.jump(this.playhead, this.rate);
    this.draw();
    if (!useEditor.getState().playing) this.fillSoon();
  }

  /** The scene's sound effect cues. */
  sfxCues(): SfxCue[] {
    if (!this.engine) return [];
    return sfxCues(JSON.parse(this.sceneJson()) as MixScene);
  }

  private remixTimer = 0;

  /** Reschedule the soundtrack once edits settle (a fader being dragged changes it on every move). */
  private remixSoon() {
    window.clearTimeout(this.remixTimer);
    this.remixTimer = window.setTimeout(() => {
      if (useEditor.getState().playing && this.rate === 1 && this.mixState() !== this.mixKey) this.startMix(useEditor.getState().time);
    }, REMIX_MS);
  }

  /** Schedule the soundtrack from scene second `t` (the clock follows it from then on). */
  private startMix(t: number) {
    this.mixKey = this.mixState();
    this.mix.start(t, () => this.loadMix());
  }

  /** Everything the soundtrack is built from: when an edit changes it mid-play, the mix is rescheduled. */
  private mixState(): string {
    const s = JSON.parse(this.require().sceneJson()) as MixScene & { layers?: { type: string }[]; duration: number };
    const clips = (s.layers ?? []).filter((l) => l.type === VIDEO_LAYER || l.type === AUDIO_LAYER);
    // The master level is the bus's (set live); the mixer's channels and tracks are in the schedule.
    return JSON.stringify([this.audioUrl, s.audio, s.music, s.sfx, s.sfx_volume, s.captions?.words, s.duration, clips, s.tracks, s.mix?.channels]);
  }

  private async loadMix(): Promise<MixSources> {
    const engine = this.require();
    const scene = JSON.parse(engine.sceneJson()) as MixScene & { fps: number; duration: number; layers?: { type: string; volume?: unknown }[] };
    const withSound = (scene.layers ?? []).some((l) => (l.type === VIDEO_LAYER || l.type === AUDIO_LAYER) && hasSound(l.volume));
    // Clip timing needs the files' lengths (loops), known once they are open.
    if (withSound) await this.videos.ready(engine);
    const clips = withSound && engine === this.engine ? clipSounds(engine, scene.fps, scene.duration) : [];
    return loadMix(scene, this.audioUrl, clips);
  }

  private tick = (now: number) => {
    const time = this.playhead;
    perf.frame(now - this.lastTick);
    // A frame that came late marks its beat heavy: it is rendered ahead the next time playback stops.
    if (!nativeViewer.active && !workerViewer.active) this.cache.note(time, this.fps(), now - this.lastTick, DISPLAY_FRAME_MS);
    const elapsed = ((now - this.lastTick) / 1000) * this.rate;
    this.lastTick = now;
    const [from, to] = this.playRange();
    if (this.rate !== 1) {
      // Shuttle: silent, stops at either end.
      const t = Math.min(to, Math.max(from, time + elapsed));
      this.playhead = t;
      this.show(t);
      if (t <= from || t >= to) return this.pause();
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    // At 1× the picture follows the sound coming out (the frame clock keeps time while there is none).
    const next = this.mix.now() ?? time + elapsed;
    // A work area always loops; the whole video only when `loop` is on.
    if (next >= to && (this.loop || this.range)) {
      this.playhead = from;
      workerViewer.jump(from, 1);
      this.show(from);
      this.startMix(from);
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    if (next >= to) {
      this.playhead = to;
      this.pause();
      return;
    }
    this.playhead = next;
    this.show(next);
    this.raf = requestAnimationFrame(this.tick);
  };

  private fps() {
    return this.sceneFps;
  }

  /** Render the heavy frames ahead once the editor has been still a moment (paused, not editing). */
  private fillSoon() {
    window.clearTimeout(this.fillTimer);
    this.fillTimer = window.setTimeout(() => void this.fill(), FILL_IDLE_MS);
  }

  private async fill() {
    const engine = this.engine;
    const canvas = this.canvas;
    // Not while playing, not for a hidden tab, not while the desktop app plays natively.
    if (!engine || !canvas || useEditor.getState().playing || nativeViewer.active || document.hidden) return;
    const version = this.sceneVersion;
    const fps = this.fps();
    const [w, h] = RenderCache.size(canvas.width, canvas.height);
    const still = () => engine === this.engine && version === this.sceneVersion && !useEditor.getState().playing;
    let rendered = 0;
    for (const i of this.cache.pending(useEditor.getState().time, fps)) {
      if (!still()) break;
      await this.renderExact(i / fps);
      // Copied in the same task as the render (a WebGPU canvas is cleared once presented).
      const bitmap = await createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
      if (!this.cache.put(i, bitmap, version)) break;
      rendered++;
      // Yield so the editor stays responsive.
      if (rendered % FILL_BATCH === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (rendered && engine === this.engine && !useEditor.getState().playing) this.draw();
  }

  /** Seconds of the video already rendered ahead (for the timeline). */
  cachedRanges(): [number, number][] {
    return this.cache.ranges(this.fps());
  }

  /** Put the playhead at `t` while playing and draw it (with the desktop app's native viewer on screen, it draws instead). */
  private show(t: number) {
    // Still the same frame of the video: nothing to draw, nothing for the editor to re-render.
    const frame = Math.floor(t * this.fps() + 1e-6);
    if (frame === this.shownFrame) return;
    this.shownFrame = frame;
    perf.showed();
    useEditor.setState({ time: t });
    if (nativeViewer.active) return nativeViewer.frame(t);
    workerViewer.sync(t, this.rate);
    if (workerViewer.active) return;
    const cached = this.cache.get(t, this.fps());
    if (cached && this.overlay && this.canvas) {
      // Rendered ahead: show the bitmap, skip the render.
      placeOverlay(this.overlay, this.canvas);
      const g = this.overlay.getContext("2d")!;
      if (this.overlay.width !== cached.width || this.overlay.height !== cached.height) [this.overlay.width, this.overlay.height] = [cached.width, cached.height];
      g.drawImage(cached, 0, 0);
      this.overlay.style.visibility = "visible";
      return;
    }
    this.draw();
  }

  /** Render the exact frame at `t` (video frames decoded, audio analysed) into the canvas. */
  private async renderExact(t: number) {
    const engine = this.engine!;
    await this.videos.prepare(engine, t, this.frames);
    engine.render(t);
  }

  /** Small JPEG of the frame at each time, for the agent to look at. Restores the current frame. */
  async snapshots(times: number[], width = 360): Promise<string[]> {
    const canvas = this.canvas;
    if (!canvas || !this.engine) return [];
    await this.mediaReady();
    const [sw, sh] = this.size;
    const out = document.createElement("canvas");
    out.width = width;
    out.height = Math.round((width * sh) / sw);
    const g = out.getContext("2d")!;
    const images: string[] = [];
    for (const t of times) {
      await this.renderExact(t);
      // Copy in the same task as the render: a WebGPU canvas is cleared once presented.
      g.drawImage(canvas, 0, 0, out.width, out.height);
      images.push(out.toDataURL("image/jpeg", 0.72));
    }
    this.draw();
    return images;
  }

  /**
   * The frame's pixels, `width` px wide, for scopes: at each of `times` exactly (video frames decoded),
   * or at the playhead as it is on screen when `times` is null. Restores the current frame.
   */
  async framePixels(times: number[] | null, width = 256, temp: { hide?: string[]; ops?: Op[] } = {}): Promise<{ t: number; image: ImageData }[]> {
    const canvas = this.canvas;
    const engine = this.engine;
    if (!canvas || !engine) return [];
    // Measured as the scene would be with some layers hidden (a window tracks the picture, not its own grade)
    // or some ops applied (a grade being tried): for these frames only, the scene is restored after.
    const trial = [...(temp.hide ?? []).map((id) => ({ op: OpName.Patch, id, fields: { visible: false } })), ...(temp.ops ?? [])];
    const saved = trial.length ? engine.sceneJson() : null;
    if (saved) engine.applyOps(JSON.stringify(trial));
    try {
      return await this.pixelsOf(canvas, engine, times, width);
    } finally {
      if (saved && engine === this.engine) {
        engine.loadScene(saved);
        this.draw();
      }
    }
  }

  private async pixelsOf(canvas: HTMLCanvasElement, engine: Engine, times: number[] | null, width: number): Promise<{ t: number; image: ImageData }[]> {
    const [sw, sh] = this.size;
    const out = document.createElement("canvas");
    out.width = width;
    out.height = Math.max(1, Math.round((width * sh) / sw));
    const g = out.getContext("2d", { willReadFrequently: true })!;
    const frames: { t: number; image: ImageData }[] = [];
    if (times) await this.mediaReady();
    for (const t of times ?? [useEditor.getState().time]) {
      if (times) await this.renderExact(t);
      else engine.render(t);
      // Same task as the render: a WebGPU canvas is cleared once presented.
      g.drawImage(canvas, 0, 0, out.width, out.height);
      frames.push({ t, image: g.getImageData(0, 0, out.width, out.height) });
    }
    if (times) this.draw();
    return frames;
  }

  /** The middle of every video and picture clip, in timeline order (where scopes look by default). */
  clipMidpoints(): number[] {
    if (!this.engine) return [];
    const duration = this.engine.duration();
    const layers = JSON.parse(this.engine.flatLayers()) as { type: string; group?: string; start?: number; end?: number | null }[];
    return layers
      .filter((l) => l.type === "video" || (l.type === "image" && l.group === "footage"))
      .map((l) => ((l.start ?? 0) + (l.end ?? duration)) / 2)
      .sort((a, b) => a - b);
  }

  /**
   * Self-review for the agent: renders `frames` evenly spaced frames into one contact sheet
   * and flags visible problems (layers off frame, overlapping text, dead stretches, blank frames).
   */
  async review(frames: number): Promise<ReviewReport> {
    const canvas = this.canvas;
    const duration = this.duration();
    if (!canvas || !this.engine) return { duration, times: [], sheet: "", issues: ["engine not ready"], motion: [], strips: [] };
    await this.mediaReady();
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

    for (const [i, t] of times.entries()) {
      await this.renderExact(t);
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
    }
    for (const note of this.videoIssues(layers, duration)) found.set(note, []);
    for (const note of this.textSizeNotes(layers)) found.set(note, []);

    for (const [id, seen] of swarms)
      if (!seen) found.set(`particles '${id}' never has a live particle at the review times: set rate= and/or burst= inside its span (and life=)`, [times[0]!]);
    const share = saturated / Math.max(1, sampled);
    if (share > SATURATED_SHARE)
      flag(`palette: ${Math.round(share * 100)}% of the frame is saturated color — pro films keep neutrals (near-black/white/warm grey) ≥60% and save saturation for small accents`, times[0]!);
    if (saturated > 0 && Object.values(hues).every((n) => n / saturated > NEON_TRIO_SHARE))
      flag("palette: violet + magenta + cyan neon is the generic AI look — pick ONE hue family plus one small contrasting accent", times[0]!);
    const issues = [...found].map(([what, ts]) => (ts.length ? `${what} (${ts.length > 1 ? `${ts[0]}s-${ts[ts.length - 1]}s` : `${ts[0]}s`})` : what));
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
    const strips: ReviewReport["strips"] = [];
    for (const { t } of peaks) strips.push(await this.strip(Math.max(0, t - STRIP_FRAMES / 2 / MOTION_FPS), duration));
    this.draw();
    return { duration, times, sheet: sheet.toDataURL("image/jpeg", 0.8), issues, motion, strips };
  }

  /** `STRIP_FRAMES` consecutive frames at `MOTION_FPS` from `from`, in one row of 4 × 2. */
  private async strip(from: number, duration: number): Promise<{ from: number; to: number; image: string }> {
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
      await this.renderExact(t);
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

  /**
   * Video layers that will not show what the agent expects: file failed to load, `in` past the end
   * of the file, or a clip that runs out and freezes on its last frame while the layer is still on.
   */
  /** Text layers set below the phone-readable size (static sizes only; animated sizes are not judged). */
  private textSizeNotes(layers: ReviewLayer[]): string[] {
    const [sw, sh] = this.size;
    const short = Math.min(sw, sh);
    const min = short * MIN_TEXT_SHARE;
    const notes: string[] = [];
    for (const l of layers) {
      if (l.type !== LayerType.Text || l.visible === false || typeof l.size !== "number") continue;
      if (l.size < min) notes.push(`text '${l.id}' is ${l.size}px on a ${short}px frame: too small to read on a phone (at least ${Math.round(min)}px)`);
    }
    return notes;
  }

  private videoIssues(layers: ReviewLayer[], duration: number): string[] {
    const notes: string[] = [];
    for (const l of layers) {
      if (l.type !== LayerType.Video || typeof l.src !== "string") continue;
      const st = this.videos.status(l.src);
      if (!st || st.status === VideoStatus.Loading) {
        notes.push(`video '${l.id}' is still loading ${l.src}: nothing is drawn yet`);
        continue;
      }
      if (st.status === VideoStatus.Failed) {
        notes.push(`video '${l.id}' failed to load ${l.src} (${st.error}): it draws nothing — use a src from get_brand`);
        continue;
      }
      const at = Number(l.in ?? 0);
      const out = Math.min(Number(l.out ?? st.duration), st.duration);
      if (at >= st.duration) {
        notes.push(`video '${l.id}' starts at in=${at}s but ${l.src} is only ${st.duration.toFixed(2)}s long: it shows its last frame`);
        continue;
      }
      if (l.loop || l.time) continue;
      const speed = Number(l.speed ?? 1);
      const runsOut = (l.start ?? 0) + (out - at) / speed;
      const end = l.end ?? duration;
      if (end - runsOut > 0.1)
        notes.push(
          `video '${l.id}' runs out at ${runsOut.toFixed(2)}s (in=${at} out=${out.toFixed(2)} of a ${st.duration.toFixed(2)}s file, speed ${speed}) and freezes on its last frame until ${end.toFixed(2)}s: end the layer there, add loop=1 or lower speed`,
        );
    }
    return notes;
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
    return times.map((t) => {
      const frame = { t, ...(JSON.parse(this.engine!.layout(t)) as Omit<FrameLayout, "t">) };
      // Video rows: which second of the file is on screen, and whether the file loaded.
      for (const row of frame.layers) {
        if (!row.video) continue;
        const st = this.videos.status(row.video.src);
        if (st?.status === VideoStatus.Failed) row.video.error = `failed to load: ${st.error}`;
        else if (st?.status !== VideoStatus.Ready) row.video.error = "still loading";
        else row.video.duration = +st.duration.toFixed(3);
      }
      return frame;
    });
  }

  sceneSize(): [number, number] {
    return this.size;
  }

  pick(x: number, y: number): string | undefined {
    return this.engine?.pick(useEditor.getState().time, x, y);
  }

  /** Layers under scene point (x, y) now, front to back; `cover` marks full-frame backdrops and overlays. */
  pickStack(x: number, y: number): PickHit[] {
    const json = this.engine?.pickStack(useEditor.getState().time, x, y);
    return json ? (JSON.parse(json) as PickHit[]) : [];
  }

  /** A layer's JSON (to edit it directly without the agent). */
  layer(id: string): Record<string, unknown> | undefined {
    const json = this.engine?.layerJson(id);
    return json ? (JSON.parse(json) as Record<string, unknown>) : undefined;
  }

  /** A layer's animatable numbers (x, y, scale, rotation, opacity…) at the current time. */
  propValues(id: string): Record<string, number> | undefined {
    const json = this.engine?.propValues(id, useEditor.getState().time);
    return json ? (JSON.parse(json) as Record<string, number>) : undefined;
  }

  /** Exact engine values of a layer prop (`set_prop` name) at scene `times`: keys, bezier, formulas, time remap; no parents. [] for an unknown layer or prop. */
  sampleProp(layerId: string, prop: string, times: number[]): number[] {
    const v = this.engine?.sampleProp(layerId, prop, Float32Array.from(times));
    return v ? Array.from(v) : [];
  }

  layerBounds(id: string): number[] | undefined {
    const b = this.engine?.layerBounds(id, useEditor.getState().time);
    return b ? Array.from(b) : undefined;
  }

  /** `engine.render(t)` timed for the performance HUD: the call, and (when watched) until the GPU has drawn it. */
  private renderMeasured(engine: Engine, t: number) {
    const t0 = performance.now();
    engine.render(t);
    perf.render.add(performance.now() - t0);
    if (perf.watchGpu) void gpuDone(engine).then(() => perf.gpu.add(performance.now() - t0));
  }

  /** Resolves once the GPU has finished everything submitted so far (benchmarks). */
  gpuIdle(): Promise<void> {
    return this.engine ? gpuDone(this.engine) : Promise.resolve();
  }

  /** Render the current time now; video frames still decoding are refined right after. */
  private draw() {
    const engine = this.engine;
    if (!engine || workerViewer.active) return;
    if (this.overlay) this.overlay.style.visibility = "hidden";
    const t = useEditor.getState().time;
    const exact = this.videos.show(engine, t, this.frames);
    this.renderMeasured(engine, t);
    void exact?.then((done) => {
      if (done && engine === this.engine && useEditor.getState().time === t) this.renderMeasured(engine, t);
    });
  }

  private changed() {
    this.cache.invalidate(++this.sceneVersion);
    this.syncMeta();
    // An edit of the soundtrack while playing: reschedule it from the playhead.
    if (useEditor.getState().playing && this.rate === 1 && this.mixState() !== this.mixKey) this.remixSoon();
    if (nativeViewer.active) void nativeViewer.reload(this.viewerScene(), this, useEditor.getState().time);
    if (useEditor.getState().playing) void workerViewer.reload(this.sceneJson(), this.workerSource);
    this.draw();
    void this.ensureModels();
    void this.ensureImages();
    void this.ensureLuts();
    this.listeners.forEach((fn) => fn());
  }

  private syncMeta() {
    const meta = JSON.parse(this.require().sceneJson()) as SceneMeta;
    this.size = [meta.width, meta.height];
    this.sceneFps = meta.fps ?? 30;
    this.range = meta.work_area ?? null;
    this.marks = meta.markers ?? [];
    audioBus.setMaster(10 ** ((meta.mix?.master_db ?? 0) / 20));
    audioBus.setMasterFx(meta.mix?.master_fx);
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
    workerViewer.resize(w, h);
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
