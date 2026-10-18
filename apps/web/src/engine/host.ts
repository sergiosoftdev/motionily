import init, { Engine, captionStyles, stylePalettes, stylePresets } from "./pkg/engine_wasm.js";
import type { CaptionStyle, Op, StylePreset } from "@motionily/protocol";
import demoScene from "../../../../examples/demo.scene.json?raw";
import { EngineStatus, useEditor } from "../store";

type SceneMeta = { style: StylePreset; caption_style: CaptionStyle; duration: number };

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

  styles: StylePreset[] = [];
  captionStyles: CaptionStyle[] = [];
  palettes: Record<StylePreset, string[]> = {} as Record<StylePreset, string[]>;

  async mount(canvas: HTMLCanvasElement) {
    if (this.canvas === canvas) return;
    this.canvas = canvas;
    try {
      await init();
      this.styles = JSON.parse(stylePresets());
      this.captionStyles = JSON.parse(captionStyles());
      this.palettes = JSON.parse(stylePalettes());
      this.fitCanvas();
      this.engine = await Engine.create(canvas);
      this.engine.loadScene(demoScene);
      new ResizeObserver(() => this.fitCanvas()).observe(canvas);
      useEditor.setState({ engineStatus: EngineStatus.Ready, adapter: this.engine.adapterInfo() });
      this.syncMeta();
      this.draw();
    } catch (e) {
      useEditor.setState({ engineStatus: EngineStatus.Failed, engineError: String(e) });
    }
  }

  /** Called after every scene change, from the agent or the user. */
  onSceneChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get ready() {
    return this.engine !== null;
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

  loadScene(json: string) {
    this.require().loadScene(json);
    this.changed();
  }

  play() {
    if (useEditor.getState().playing) return;
    const { time, duration } = useEditor.getState();
    if (time >= duration) useEditor.setState({ time: 0 });
    useEditor.setState({ playing: true });
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    useEditor.setState({ playing: false });
  }

  seek(t: number) {
    useEditor.setState({ time: Math.max(0, Math.min(t, useEditor.getState().duration)) });
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
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

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
    useEditor.setState((s) => ({
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
