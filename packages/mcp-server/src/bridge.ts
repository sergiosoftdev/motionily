import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  BRIDGE_PATH,
  BridgeRole,
  EditorMessageType,
  HubMessageType,
  ServerMessageType,
  type EditorMessage,
  type HubMessage,
  type Op,
  type ServerMessage,
} from "@motionily/protocol";

const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_MS = 2_000;

type ResultMessage = Extract<EditorMessage, { type: typeof EditorMessageType.Result }>;
type Pending = { resolve: (msg: ResultMessage) => void; timer: NodeJS.Timeout };
type Request = Extract<ServerMessage, { requestId: string }>;

/**
 * Live link to the editor showing this project, through the API's bridge hub.
 * The editor holds the engine: it validates and applies every op, renders it,
 * and autosaves the scene. Several agents can work at once without port clashes.
 */
export class EditorBridge {
  private socket: WebSocket | null = null;
  private editorOpen = false;
  private pending = new Map<string, Pending>();
  private summary = "";
  private scene: string | null = null;

  constructor(
    apiUrl: string,
    token: string,
    private readonly projectId: string,
  ) {
    const url = new URL(BRIDGE_PATH, apiUrl.replace(/^http/, "ws"));
    url.search = new URLSearchParams({ role: BridgeRole.Agent, token }).toString();
    this.connect(url.toString());
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.editorOpen;
  }

  get lastSummary(): string {
    return this.summary;
  }

  /** Latest scene JSON the editor reported (fresher than the API's autosave). */
  get lastScene(): string | null {
    return this.connected ? this.scene : null;
  }

  applyOps(ops: Op[]) {
    return this.request({ type: ServerMessageType.ApplyOps, requestId: randomUUID(), projectId: this.projectId, ops });
  }

  renderFrames(times: number[]) {
    return this.request({ type: ServerMessageType.RenderFrames, requestId: randomUUID(), projectId: this.projectId, times });
  }

  loadScene(scene: string) {
    return this.request({ type: ServerMessageType.LoadScene, requestId: randomUUID(), projectId: this.projectId, scene });
  }

  private connect(url: string) {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      this.socket = ws;
      // stdout belongs to MCP; logs go to stderr.
      console.error(`[motionily] connected to the editor hub for project ${this.projectId}`);
    });
    ws.on("message", (raw) => this.onMessage(JSON.parse(String(raw)) as EditorMessage | HubMessage));
    ws.on("error", () => undefined);
    ws.on("close", (code) => {
      if (this.socket === ws) this.socket = null;
      this.editorOpen = false;
      if (code === 4401) {
        console.error("[motionily] the agent token was rejected; get a new one with 'Conectar agente'.");
        return;
      }
      setTimeout(() => this.connect(url), RECONNECT_MS);
    });
  }

  private onMessage(msg: EditorMessage | HubMessage) {
    switch (msg.type) {
      case HubMessageType.EditorOpen:
        this.editorOpen = true;
        return;
      case HubMessageType.EditorClosed:
        this.editorOpen = false;
        return;
      case EditorMessageType.Hello:
      case EditorMessageType.SceneChanged:
        this.editorOpen = true;
        this.summary = msg.summary;
        this.scene = msg.scene;
        return;
      case EditorMessageType.Result: {
        const p = this.pending.get(msg.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.requestId);
        if (msg.ok && msg.summary) this.summary = msg.summary;
        if (msg.ok && msg.scene) this.scene = msg.scene;
        p.resolve(msg);
        return;
      }
    }
  }

  private request(msg: Request) {
    const ws = this.socket;
    if (!ws || !this.editorOpen) {
      return Promise.reject(new Error("The editor is not open on this project. Ask the user to open it in Motionily and retry."));
    }
    return new Promise<ResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.requestId);
        reject(new Error("Editor did not answer in time."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(msg.requestId, { resolve, timer });
      ws.send(JSON.stringify(msg));
    });
  }
}
