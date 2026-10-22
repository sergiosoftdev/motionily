import {
  BRIDGE_PATH,
  BridgeClose,
  BridgeRole,
  HEADLESS_PARAM,
  EditorMessageType,
  ServerMessageType,
  type EditorMessage,
  type ServerMessage,
} from "@motionily/protocol";
import { API_URL } from "./api/client";
import { presetViolation, scenePresetViolation } from "./agentRules";
import { engineHost } from "./engine/host";
import { renderSound, toWav, type SoundRecipe } from "./audio/synth";
import { useSession } from "./session";
import { ActivitySource, logActivity, useEditor } from "./store";

/** Frames the agent asks to see: small by default (cheap), up to this width for detail checks. */
const MIN_FRAME_WIDTH = 360;
const MAX_FRAME_WIDTH = 1280;
/** Instants per layout request (it is cheap: numbers, no rendering). */
const MAX_LAYOUT_TIMES = 12;

const RECONNECT_MS = 2000;

/**
 * Editor side of the agent link, through the API hub. Agents send ops here; the
 * Rust engine validates and applies them and we answer with the new summary.
 */
class AgentBridge {
  private ws: WebSocket | null = null;
  private projectId: string | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** Called when the agent changes project settings, so the editor reloads them. */
  onProjectChanged: (() => void) | null = null;

  /** Connect for the project open in the editor (`null` disconnects). */
  setProject(id: string | null) {
    if (id === this.projectId) return;
    this.projectId = id;
    clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    useEditor.setState({ agentConnected: false, openElsewhere: false });
    if (id) this.connect();
  }

  private connect() {
    const token = useSession.getState().token;
    const projectId = this.projectId;
    if (!token || !projectId) return;
    const url = new URL(BRIDGE_PATH, API_URL.replace(/^http/, "ws"));
    url.search = new URLSearchParams({ role: BridgeRole.Editor, project: projectId, token }).toString();
    // The agent's invisible editor never kicks out a real one.
    if (new URLSearchParams(location.search).has(HEADLESS_PARAM)) url.searchParams.set(HEADLESS_PARAM, "1");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.hello();
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      if (useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agent disconnected");
      this.ws = null;
      // Another tab took the video: reconnecting would steal it back, and the two would take turns forever.
      if (e.code === BridgeClose.OpenedElsewhere) return useEditor.setState({ agentConnected: false, openElsewhere: true });
      useEditor.setState({ agentConnected: false });
      this.retry = setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  /** User changed something by hand: keep the agent's summary in sync. */
  sceneChanged() {
    if (!this.projectId || !engineHost.ready) return;
    this.send({ type: EditorMessageType.SceneChanged, projectId: this.projectId, scene: engineHost.sceneJson(), summary: engineHost.summary() });
  }

  private hello() {
    if (!this.projectId || !engineHost.ready) return;
    this.send({ type: EditorMessageType.Hello, projectId: this.projectId, scene: engineHost.sceneJson(), summary: engineHost.summary() });
  }

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case ServerMessageType.Attached:
        if (!useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agent connected");
        useEditor.setState({ agentConnected: true });
        // A new agent must start from what is on screen right now, not a cached copy.
        this.hello();
        return;
      case ServerMessageType.Detached:
        if (useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agent disconnected");
        useEditor.setState({ agentConnected: false });
        return;
      case ServerMessageType.ProjectChanged:
        logActivity(ActivitySource.Agent, "Changes the video options");
        this.onProjectChanged?.();
        return;
      case ServerMessageType.Review: {
        // Async: video frames are decoded exactly for every sampled instant.
        void engineHost.review(msg.frames).then((review) => {
          logActivity(ActivitySource.Agent, `Reviews the video (${review.issues.length} warnings)`);
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, review });
        }, (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: String(e) }));
        return;
      }
      case ServerMessageType.Layout: {
        const layouts = engineHost.layout(msg.times.slice(0, MAX_LAYOUT_TIMES));
        this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, layouts });
        return;
      }
      case ServerMessageType.RenderSound: {
        // A sound the agent designed: render its recipe here (the synth needs Web Audio) and send it back as WAV.
        void renderSound(msg.recipe as SoundRecipe)
          .then(async (buf) => {
            logActivity(ActivitySource.Agent, `Designs a sound effect (${buf.duration.toFixed(1)} s)`);
            this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, sound: { wav: await dataUrl(toWav(buf)), duration: buf.duration } });
          })
          .catch((e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: `the recipe could not be rendered: ${String(e)}` }));
        return;
      }
      case ServerMessageType.RenderFrames: {
        const width = Math.min(MAX_FRAME_WIDTH, Math.max(MIN_FRAME_WIDTH, msg.width ?? MIN_FRAME_WIDTH));
        void engineHost.snapshots(msg.times.slice(0, 6), width).then((images) => {
          logActivity(ActivitySource.Agent, `Looks at ${images.length} ${images.length === 1 ? "frame" : "frames"}`);
          this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, images });
        }, (e: unknown) => this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: String(e) }));
        return;
      }
    }
    try {
      switch (msg.type) {
        case ServerMessageType.ApplyOps:
          // The project's format owns the frame size; agents change it with set_format.
          {
            const why = presetViolation(msg.ops);
            if (why) throw new Error(why);
          }
          engineHost.applyOps(msg.ops);
          logActivity(ActivitySource.Agent, describeOps(msg.ops.map((o) => o.op)));
          break;
        case ServerMessageType.LoadScene: {
          const why = scenePresetViolation(JSON.parse(msg.scene) as Record<string, unknown>);
          if (why) throw new Error(why);
          engineHost.loadScene(msg.scene);
          logActivity(ActivitySource.Agent, "New scene");
          break;
        }
      }
      this.send({
        type: EditorMessageType.Result,
        requestId: msg.requestId,
        ok: true,
        scene: engineHost.sceneJson(),
        summary: engineHost.summary(),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logActivity(ActivitySource.System, `Agent change rejected: ${error}`);
      this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error });
    }
  }

  private send(msg: EditorMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

function describeOps(names: string[]): string {
  const counts = new Map<string, number>();
  names.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
}

export const agentBridge = new AgentBridge();
// A hot update (development) builds a fresh bridge: close this one's socket first, or the hub sees two editors in one
// tab and the stale one shows "open in another tab".
import.meta.hot?.dispose(() => agentBridge.setProject(null));

/** A blob as a data URL (rendered sounds travel to the agent inline). */
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
