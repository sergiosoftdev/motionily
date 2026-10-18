import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  EditorMessageType,
  ServerMessageType,
  type EditorMessage,
  type Op,
  type ServerMessage,
} from "@motionily/protocol";

const REQUEST_TIMEOUT_MS = 10_000;

type ResultMessage = Extract<EditorMessage, { type: typeof EditorMessageType.Result }>;
type Pending = { resolve: (msg: ResultMessage) => void; timer: NodeJS.Timeout };

/**
 * Live link to the editor that has this project open. The editor holds the
 * Rust engine: it validates and applies every op, renders it, and autosaves
 * the scene to the API. We only forward ops and keep the latest summary.
 */
export class EditorBridge {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private summary = "";

  constructor(
    port: number,
    private readonly projectId: string,
  ) {
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (ws) => this.attach(ws));
    // stdout belongs to MCP; logs go to stderr.
    console.error(`[motionily] editor bridge on ws://127.0.0.1:${port} for project ${projectId}`);
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  get lastSummary(): string {
    return this.summary;
  }

  applyOps(ops: Op[]) {
    return this.request({ type: ServerMessageType.ApplyOps, requestId: randomUUID(), projectId: this.projectId, ops });
  }

  loadScene(scene: string) {
    return this.request({ type: ServerMessageType.LoadScene, requestId: randomUUID(), projectId: this.projectId, scene });
  }

  private attach(ws: WebSocket) {
    ws.on("message", (raw) => this.onMessage(ws, JSON.parse(String(raw)) as EditorMessage));
    ws.on("close", () => {
      if (this.socket === ws) this.socket = null;
    });
  }

  private onMessage(ws: WebSocket, msg: EditorMessage) {
    switch (msg.type) {
      case EditorMessageType.Hello:
      case EditorMessageType.SceneChanged:
        // Only the editor showing our project counts; other tabs are ignored.
        if (msg.projectId !== this.projectId) {
          if (this.socket === ws) this.socket = null;
          return;
        }
        if (this.socket !== ws) {
          this.socket?.close();
          this.socket = ws;
          ws.send(JSON.stringify({ type: ServerMessageType.Attached, projectId: this.projectId } satisfies ServerMessage));
        }
        this.summary = msg.summary;
        return;
      case EditorMessageType.Result: {
        const p = this.pending.get(msg.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.requestId);
        if (msg.ok && msg.summary) this.summary = msg.summary;
        p.resolve(msg);
        return;
      }
    }
  }

  private request(msg: Exclude<ServerMessage, { type: typeof ServerMessageType.Attached }>) {
    const ws = this.socket;
    if (!ws) {
      return Promise.reject(
        new Error("The editor is not showing this project. Ask the user to open it in Motionily and retry."),
      );
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
