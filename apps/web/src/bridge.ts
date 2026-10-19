import {
  BRIDGE_PATH,
  BridgeRole,
  EditorMessageType,
  OpName,
  ServerMessageType,
  type EditorMessage,
  type ServerMessage,
} from "@motionily/protocol";
import { API_URL } from "./api/client";
import { engineHost } from "./engine/host";
import { useSession } from "./session";
import { ActivitySource, logActivity, useEditor } from "./store";

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
    useEditor.setState({ agentConnected: false });
    if (id) this.connect();
  }

  private connect() {
    const token = useSession.getState().token;
    const projectId = this.projectId;
    if (!token || !projectId) return;
    const url = new URL(BRIDGE_PATH, API_URL.replace(/^http/, "ws"));
    url.search = new URLSearchParams({ role: BridgeRole.Editor, project: projectId, token }).toString();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.hello();
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agente desconectado");
      useEditor.setState({ agentConnected: false });
      this.ws = null;
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
        if (!useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agente conectado");
        useEditor.setState({ agentConnected: true });
        return;
      case ServerMessageType.Detached:
        if (useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agente desconectado");
        useEditor.setState({ agentConnected: false });
        return;
      case ServerMessageType.ProjectChanged:
        logActivity(ActivitySource.Agent, "Cambia las opciones del vídeo");
        this.onProjectChanged?.();
        return;
      case ServerMessageType.RenderFrames: {
        const images = engineHost.snapshots(msg.times.slice(0, 6));
        logActivity(ActivitySource.Agent, `Mira ${images.length} fotogramas`);
        this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: true, images });
        return;
      }
    }
    try {
      switch (msg.type) {
        case ServerMessageType.ApplyOps:
          // The project's format owns the frame size; agents change it with set_format.
          if (msg.ops.some((o) => o.op === OpName.SetSize)) {
            throw new Error("set_size is not allowed: the frame size comes from the project format; use the set_format tool");
          }
          engineHost.applyOps(msg.ops);
          logActivity(ActivitySource.Agent, describeOps(msg.ops.map((o) => o.op)));
          break;
        case ServerMessageType.LoadScene:
          engineHost.loadScene(msg.scene);
          logActivity(ActivitySource.Agent, "Escena nueva");
          break;
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
      logActivity(ActivitySource.System, `Cambio del agente rechazado: ${error}`);
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
