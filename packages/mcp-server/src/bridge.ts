import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { HeadlessEditor } from "./headless.js";
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
/** How long to wait for the headless editor to boot (wasm, fonts, models). */
const HEADLESS_BOOT_MS = 40_000;
const REVIEW_TIMEOUT_MS = 60_000;
/** A page reload closes the editor for a few seconds: wait for it before opening our own. */
const RELOAD_GRACE_MS = 10_000;
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

  /** Opens an invisible editor when the user has none open; set by the server. */
  headless: HeadlessEditor | null = null;
  private waiters: (() => void)[] = [];
  /** Whether a real editor has been seen (then a disconnect is probably a reload). */
  private everOpen = false;

  private waitForEditor(ms: number): Promise<boolean> {
    if (this.socket && this.editorOpen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      this.waiters.push(done);
    });
  }

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

  renderFrames(times: number[], width?: number) {
    return this.request({ type: ServerMessageType.RenderFrames, requestId: randomUUID(), projectId: this.projectId, times, width });
  }

  review(frames: number) {
    return this.request({ type: ServerMessageType.Review, requestId: randomUUID(), projectId: this.projectId, frames }, REVIEW_TIMEOUT_MS);
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
        this.waiters.splice(0).forEach((w) => w());
        return;
      case HubMessageType.EditorClosed:
        this.editorOpen = false;
        return;
      case EditorMessageType.Hello:
      case EditorMessageType.SceneChanged:
        this.editorOpen = true;
        if (!this.headless?.running) this.everOpen = true;
        this.waiters.splice(0).forEach((w) => w());
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

  /** Make sure some editor (the user's or our headless one) is attached. */
  private async ensureEditor() {
    if (this.socket && this.editorOpen) return;
    // The user may just be reloading the page: give their editor a moment to come back.
    if (this.everOpen && (await this.waitForEditor(RELOAD_GRACE_MS))) return;
    if (!this.headless) throw new Error("The editor is not open on this project. Ask the user to open it in Motionily and retry.");
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The headless editor did not start in time.")), HEADLESS_BOOT_MS);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.headless.open();
    await ready;
  }

  private async request(msg: Request, timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.ensureEditor();
    const ws = this.socket;
    if (!ws || !this.editorOpen) throw new Error("The editor is not open on this project.");
    return new Promise<ResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.requestId);
        reject(new Error("Editor did not answer in time."));
      }, timeoutMs);
      this.pending.set(msg.requestId, { resolve, timer });
      ws.send(JSON.stringify(msg));
    });
  }
}
