import {
  BRIDGE_PORT,
  EditorMessageType,
  ServerMessageType,
  type EditorMessage,
  type ServerMessage,
} from "@motionily/protocol";
import { engineHost } from "./engine/host";
import { ActivitySource, logActivity, useEditor } from "./store";

const RECONNECT_MS = 2000;

/**
 * Editor side of the agent link. The MCP server forwards agent ops here; the
 * Rust engine validates and applies them and we answer with the new summary.
 */
class AgentBridge {
  private ws: WebSocket | null = null;
  private projectId: string | null = null;

  /** The project open in the editor. Agents for other projects are ignored. */
  setProject(id: string | null) {
    this.projectId = id;
    useEditor.setState({ agentConnected: false });
    this.hello();
  }

  start() {
    if (this.ws) return;
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    this.ws = ws;
    ws.onopen = () => this.hello();
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      if (useEditor.getState().agentConnected) logActivity(ActivitySource.System, "Agente desconectado");
      useEditor.setState({ agentConnected: false });
      this.ws = null;
      setTimeout(() => this.start(), RECONNECT_MS);
    };
  }

  /** User changed something by hand: keep the agent's summary in sync. */
  sceneChanged() {
    if (!this.projectId || !engineHost.ready) return;
    this.send({ type: EditorMessageType.SceneChanged, projectId: this.projectId, scene: engineHost.sceneJson(), summary: engineHost.summary() });
  }

  private hello() {
    if (!this.projectId || !engineHost.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: EditorMessageType.Hello, projectId: this.projectId, scene: engineHost.sceneJson(), summary: engineHost.summary() });
  }

  private handle(msg: ServerMessage) {
    if (msg.type === ServerMessageType.Attached) {
      if (msg.projectId === this.projectId) {
        useEditor.setState({ agentConnected: true });
        logActivity(ActivitySource.System, "Agente conectado");
      }
      return;
    }
    if (msg.projectId !== this.projectId) {
      this.send({ type: EditorMessageType.Result, requestId: msg.requestId, ok: false, error: "The editor is showing another project." });
      return;
    }
    try {
      switch (msg.type) {
        case ServerMessageType.ApplyOps:
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
