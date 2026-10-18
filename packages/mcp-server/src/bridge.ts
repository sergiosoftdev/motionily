import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import {
  EditorMessageType,
  ServerMessageType,
  type EditorMessage,
  type Feedback,
  type Op,
  type ServerMessage,
} from "@motionily/protocol";

const REQUEST_TIMEOUT_MS = 10_000;

type Pending = {
  resolve: (msg: Extract<EditorMessage, { type: typeof EditorMessageType.Result }>) => void;
  timer: NodeJS.Timeout;
};

/**
 * Owns the WebSocket link to the editor. The editor holds the live engine, so
 * every agent edit is forwarded there, validated by Rust, and answered with
 * the new summary. The last known scene is persisted to the project file.
 */
export class EditorBridge {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private feedback: Feedback[] = [];
  private summary = "";

  constructor(
    port: number,
    private readonly projectPath: string,
  ) {
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (ws) => this.attach(ws));
    // stdout belongs to MCP; logs go to stderr.
    console.error(`[motionily] editor bridge on ws://127.0.0.1:${port}, project ${projectPath}`);
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  get lastSummary(): string {
    return this.summary;
  }

  savedScene(): string | null {
    return existsSync(this.projectPath) ? readFileSync(this.projectPath, "utf8") : null;
  }

  async applyOps(ops: Op[]) {
    return this.request({ type: ServerMessageType.ApplyOps, requestId: randomUUID(), ops });
  }

  async loadScene(scene: string) {
    return this.request({ type: ServerMessageType.LoadScene, requestId: randomUUID(), scene });
  }

  drainFeedback(): Feedback[] {
    const out = this.feedback;
    this.feedback = [];
    return out;
  }

  private attach(ws: WebSocket) {
    this.socket?.close();
    this.socket = ws;
    ws.on("message", (raw) => this.onMessage(JSON.parse(String(raw)) as EditorMessage));
    ws.on("close", () => {
      if (this.socket === ws) this.socket = null;
    });
  }

  private onMessage(msg: EditorMessage) {
    switch (msg.type) {
      case EditorMessageType.Hello: {
        const saved = this.savedScene();
        if (saved) {
          // Editor reloaded: restore the project instead of its default scene.
          void this.loadScene(saved);
        } else {
          this.persist(msg.scene, msg.summary);
        }
        return;
      }
      case EditorMessageType.SceneChanged:
        this.persist(msg.scene, msg.summary);
        return;
      case EditorMessageType.Feedback:
        this.feedback.push(msg.feedback);
        return;
      case EditorMessageType.Result: {
        const p = this.pending.get(msg.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.requestId);
        if (msg.ok && msg.scene && msg.summary) this.persist(msg.scene, msg.summary);
        p.resolve(msg);
        return;
      }
    }
  }

  private persist(scene: string, summary: string) {
    this.summary = summary;
    writeFileSync(this.projectPath, scene);
  }

  private request(msg: ServerMessage) {
    const ws = this.socket;
    if (!ws) {
      return Promise.reject(
        new Error("Editor not open. Ask the user to open the Motionily editor (pnpm dev) and retry."),
      );
    }
    return new Promise<Extract<EditorMessage, { type: typeof EditorMessageType.Result }>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(msg.requestId);
          reject(new Error("Editor did not answer in time."));
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(msg.requestId, { resolve, timer });
        ws.send(JSON.stringify(msg));
      },
    );
  }
}
