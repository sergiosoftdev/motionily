import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../desktop";
import { syncNativeAssets, type AssetSource } from "./assets";

/** Per-viewer switch for native playback (on by default where the app has it). */
const PREF_KEY = "motionily.nativePlayback";

type Rect = { x: number; y: number; width: number; height: number; scale: number };

function rectOf(canvas: HTMLCanvasElement): Rect {
  const r = canvas.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height, scale: window.devicePixelRatio || 1 };
}

/**
 * The desktop app's native playback viewer: while playing, the native engine draws over the preview
 * canvas (full resolution, clips decoded by ffmpeg); paused, the editor's canvas and its gizmos are back.
 */
class NativeViewer {
  private supported: Promise<boolean> | null = null;
  /** Native frames are on screen (the editor can skip drawing its own canvas). */
  active = false;
  private inFlight = false;
  private pending: number | null = null;
  private observer: ResizeObserver | null = null;
  private session = 0;
  private canvas: HTMLCanvasElement | null = null;

  private async available(): Promise<boolean> {
    if (!desktop || desktop.error) return false;
    try {
      if (localStorage.getItem(PREF_KEY) === "off") return false;
    } catch {
      // Storage blocked: keep the default.
    }
    this.supported ??= invoke<boolean>("viewer_supported").catch(() => false);
    return this.supported;
  }

  /** Show the native viewer over `canvas`, drawing `sceneJson` from second `t` (it appears with that frame drawn). */
  async start(canvas: HTMLCanvasElement, sceneJson: string, assets: AssetSource, t: number) {
    const session = ++this.session;
    if (!(await this.available())) return;
    this.canvas = canvas;
    try {
      await syncNativeAssets(assets);
      if (session !== this.session) return;
      await invoke<string>("viewer_show", { rect: rectOf(canvas), sceneJson, t });
      if (session !== this.session) return void invoke("viewer_hide");
      this.active = true;
      this.observer = new ResizeObserver(() => void invoke("viewer_place", { rect: rectOf(canvas) }));
      this.observer.observe(canvas);
    } catch (e) {
      // Native playback is an enhancement: the editor's canvas keeps playing.
      console.warn("[motionily] native viewer unavailable:", e);
      this.active = false;
    }
  }

  /** The scene changed while playing (an agent or an edit): the viewer draws the new one from `t`. */
  async reload(sceneJson: string, assets: AssetSource, t: number) {
    const canvas = this.canvas;
    if (!this.active || !canvas) return;
    const session = this.session;
    try {
      await syncNativeAssets(assets);
      if (session !== this.session) return;
      await invoke<string>("viewer_show", { rect: rectOf(canvas), sceneJson, t });
      if (session !== this.session) void invoke("viewer_hide");
    } catch (e) {
      console.warn("[motionily] native viewer reload failed:", e);
    }
  }

  /** Draws `t` natively; frames requested while one is drawing collapse to the latest. */
  frame(t: number) {
    if (!this.active) return;
    if (this.inFlight) {
      this.pending = t;
      return;
    }
    this.inFlight = true;
    void invoke("viewer_frame", { t })
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = false;
        const next = this.pending;
        this.pending = null;
        if (next !== null) this.frame(next);
      });
  }

  stop() {
    this.session++;
    this.observer?.disconnect();
    this.observer = null;
    if (!this.active) return;
    this.active = false;
    void invoke("viewer_hide");
  }
}

export const nativeViewer = new NativeViewer();
