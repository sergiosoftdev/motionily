import { perf } from "./perf";

/** Per-viewer switch for playback in a worker (on by default where the browser has WebGPU in workers). */
const PREF_KEY = "motionily.workerPlayback";
/** How often (ms) the worker's clock is checked against the sound's while playing. */
const SYNC_MS = 250;

type Pixels = { rgba: Uint8Array; width: number; height: number };

export type ToWorker =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | {
      type: "load";
      scene: string;
      fps: number;
      /** Clip src → the file the preview opens (proxies applied). */
      urls: Record<string, string>;
      fonts: { family: string; weight: number; bytes: Uint8Array }[];
      models: { key: string; bytes: Uint8Array }[];
      textures: ({ pack: string } & Pixels)[];
      images: ({ src: string } & Pixels)[];
      luts: { src: string; text: string }[];
      /** The soundtrack for audio-reactive expressions (null = none); left out when unchanged. */
      audio?: { samples: Float32Array; rate: number } | null;
    }
  | { type: "resize"; width: number; height: number }
  | { type: "play"; t: number; at: number; rate: number }
  | { type: "sync"; t: number; at: number; rate: number }
  | { type: "stop" };

export type FromWorker = { type: "ready"; adapter: string } | { type: "drawn" } | { type: "stats"; renders: number[] } | { type: "failed"; error: string };

/** What the viewer needs from the editor's engine host to draw the same thing. */
export type WorkerSource = {
  fonts(): Promise<{ family: string; weight: number; bytes: Uint8Array }[]>;
  stage(): Promise<{ models: { key: string; bytes: Uint8Array }[]; textures: ({ pack: string } & Pixels)[] }>;
  images(): Promise<({ src: string } & Pixels)[]>;
  luts(): Promise<{ src: string; text: string }[]>;
  audio(): { samples: Float32Array; rate: number } | null;
  urls(): Record<string, string>;
  fps(): number;
};

const epoch = () => performance.timeOrigin + performance.now();

function placeOver(o: HTMLCanvasElement, canvas: HTMLCanvasElement) {
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

/**
 * Playback off the main thread: while the video plays, a worker with its own engine draws it on a canvas
 * laid over the editor's (its clips decoded there too), following the sound's clock; paused, the editor's
 * canvas and its gizmos are back. Like the desktop app's native viewer, it is an enhancement: anything
 * that fails leaves the editor's canvas playing.
 */
class WorkerViewer {
  /** The worker's frames are on screen (the editor can skip drawing its own canvas). */
  active = false;
  private worker: Worker | null = null;
  private view: HTMLCanvasElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ready: Promise<boolean> | null = null;
  private sent = new Set<string>();
  private sentAudio: object | null | undefined = undefined;
  private session = 0;
  private lastSync = 0;
  private onDrawn: (() => void) | null = null;

  /** On unless switched off; needs workers that can draw (OffscreenCanvas) and the WebGPU engine. */
  enabled(adapter: string): boolean {
    try {
      if (localStorage.getItem(PREF_KEY) === "off") return false;
    } catch {
      // Storage blocked: keep the default.
    }
    return typeof OffscreenCanvas !== "undefined" && "transferControlToOffscreen" in HTMLCanvasElement.prototype && /WebGpu/i.test(adapter) && !(globalThis as { __motionilyMainPlayback?: boolean }).__motionilyMainPlayback;
  }

  get on(): boolean {
    try {
      return localStorage.getItem(PREF_KEY) !== "off";
    } catch {
      return true;
    }
  }

  set on(v: boolean) {
    try {
      localStorage.setItem(PREF_KEY, v ? "on" : "off");
    } catch {
      // Not remembered.
    }
    if (!v) this.detach();
  }

  /** The worker and its canvas, made once per editor canvas (a canvas hands its drawing to a worker only once). */
  private attach(canvas: HTMLCanvasElement): Promise<boolean> {
    if (this.canvas === canvas && this.ready) return this.ready;
    this.teardown();
    this.canvas = canvas;
    const view = document.createElement("canvas");
    view.dataset.playbackWorker = "";
    view.width = canvas.width;
    view.height = canvas.height;
    Object.assign(view.style, { position: "absolute", pointerEvents: "none", visibility: "hidden" });
    placeOver(view, canvas);
    this.view = view;
    const worker = new Worker(new URL("./playback.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.ready = new Promise<boolean>((resolve) => {
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "ready") resolve(true);
        else if (m.type === "failed") {
          console.warn("[motionily] playback worker:", m.error);
          resolve(false);
          if (this.active) this.stop();
        } else if (m.type === "drawn") this.onDrawn?.();
        else if (m.type === "stats") for (const ms of m.renders) perf.render.add(ms);
      };
      worker.onerror = (e) => {
        console.warn("[motionily] playback worker failed:", e.message);
        resolve(false);
      };
    });
    const offscreen = view.transferControlToOffscreen();
    this.post({ type: "init", canvas: offscreen, width: canvas.width, height: canvas.height }, [offscreen]);
    return this.ready;
  }

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer);
  }

  /** Send the scene and whatever it needs that the worker does not have yet. */
  private async load(sceneJson: string, src: WorkerSource) {
    const [fonts, stage, images, luts] = await Promise.all([src.fonts(), src.stage(), src.images(), src.luts()]);
    const fresh = <T>(list: T[], key: (x: T) => string) =>
      list.filter((x) => {
        const k = key(x);
        if (this.sent.has(k)) return false;
        this.sent.add(k);
        return true;
      });
    const audio = src.audio();
    const m: ToWorker = {
      type: "load",
      scene: sceneJson,
      fps: src.fps(),
      urls: src.urls(),
      fonts: fresh(fonts, (f) => `f:${f.family}:${f.weight}`),
      models: fresh(stage.models, (x) => `m:${x.key}`),
      textures: fresh(stage.textures, (x) => `t:${x.pack}`),
      images: fresh(images, (x) => `i:${x.src}`),
      luts: fresh(luts, (x) => `l:${x.src}`),
    };
    if (audio !== this.sentAudio) {
      m.audio = audio;
      this.sentAudio = audio;
    }
    this.post(m);
  }

  /** Play `sceneJson` in the worker from where `clock` says the playhead is; its canvas covers the editor's once its first frame is drawn. */
  async start(canvas: HTMLCanvasElement, adapter: string, sceneJson: string, src: WorkerSource, clock: () => { t: number; rate: number }) {
    const session = ++this.session;
    if (!this.enabled(adapter)) return;
    try {
      if (!(await this.attach(canvas)) || session !== this.session) return;
      if (this.view && (this.view.width !== canvas.width || this.view.height !== canvas.height)) this.post({ type: "resize", width: canvas.width, height: canvas.height });
      await this.load(sceneJson, src);
      if (session !== this.session) return;
      this.onDrawn = () => {
        this.onDrawn = null;
        if (session !== this.session || !this.view || !this.canvas) return;
        placeOver(this.view, this.canvas);
        this.view.style.visibility = "visible";
        this.active = true;
      };
      this.lastSync = performance.now();
      // Where the playhead is now (loading took a moment).
      const { t, rate } = clock();
      this.post({ type: "play", t, at: epoch(), rate });
    } catch (e) {
      console.warn("[motionily] playback worker unavailable:", e);
      this.stop();
    }
  }

  /** The editor's playhead (the sound's clock) at this moment: the worker follows it when they drift. */
  sync(t: number, rate: number) {
    if (!this.worker) return;
    const now = performance.now();
    if (now - this.lastSync < SYNC_MS) return;
    this.lastSync = now;
    if (this.view && this.canvas && this.active) placeOver(this.view, this.canvas);
    this.post({ type: "sync", t, at: epoch(), rate });
  }

  /** A jump while playing (a loop, a seek): right away. */
  jump(t: number, rate: number) {
    this.lastSync = performance.now();
    this.post({ type: "sync", t, at: epoch(), rate });
  }

  /** The scene changed while playing: the worker draws the new one. */
  async reload(sceneJson: string, src: WorkerSource) {
    if (!this.worker || this.session === 0) return;
    await this.load(sceneJson, src);
  }

  /** The editor's canvas changed size: so does the worker's. */
  resize(width: number, height: number) {
    if (this.worker) this.post({ type: "resize", width, height });
  }

  stop() {
    this.session++;
    this.onDrawn = null;
    this.post({ type: "stop" });
    if (this.view) this.view.style.visibility = "hidden";
    this.active = false;
  }

  /** The editor's canvas is going away. */
  detach() {
    this.stop();
    this.teardown();
  }

  private teardown() {
    this.active = false;
    this.worker?.terminate();
    this.worker = null;
    this.view?.remove();
    this.view = null;
    this.canvas = null;
    this.ready = null;
    this.sent.clear();
    this.sentAudio = undefined;
  }
}

export const workerViewer = new WorkerViewer();
