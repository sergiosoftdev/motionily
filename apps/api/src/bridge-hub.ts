import type { IncomingMessage, Server } from "node:http";
import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Types } from "mongoose";
import { WebSocket, WebSocketServer } from "ws";
import { TokenScope, type JwtPayload } from "./auth/auth";
import { ProjectsService } from "./projects/projects.service";

/** Who is on the other end of a socket. */
export enum BridgeRole {
  Editor = "editor",
  Agent = "agent",
}

// Message types the hub reads or emits; they mirror packages/protocol.
const MsgType = {
  Hello: "hello",
  SceneChanged: "scene_changed",
  Result: "result",
  Attached: "attached",
  Detached: "detached",
  EditorOpen: "editor_open",
  EditorClosed: "editor_closed",
  ProjectChanged: "project_changed",
} as const;

export const BRIDGE_PATH = "/bridge";

/**
 * Routes live messages between the editor that shows a project and the agents
 * working on it. The editor holds the engine; agents send it ops and get results.
 */
export class BridgeHub {
  /** Set once the HTTP server is up; services use it to notify open editors. */
  static instance: BridgeHub | null = null;
  private readonly logger = new Logger(BridgeHub.name);
  private editors = new Map<string, WebSocket>();
  private agents = new Map<string, Set<WebSocket>>();
  /** Last hello/scene_changed from each editor, replayed to agents that join late. */
  private lastScene = new Map<string, string>();

  constructor(
    server: Server,
    private readonly jwt: JwtService,
    private readonly projects: ProjectsService,
  ) {
    BridgeHub.instance = this;
    const wss = new WebSocketServer({ server, path: BRIDGE_PATH });
    wss.on("connection", (ws, req) => void this.accept(ws, req));
  }

  private async accept(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? "", "http://localhost");
    const role = url.searchParams.get("role");
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(url.searchParams.get("token") ?? "");
    } catch {
      return ws.close(4401, "invalid token");
    }
    if (role === BridgeRole.Agent && payload.scope === TokenScope.Agent && payload.projectId) {
      return this.addAgent(ws, payload.projectId);
    }
    if (role === BridgeRole.Editor && (payload.scope ?? TokenScope.User) === TokenScope.User) {
      const projectId = url.searchParams.get("project") ?? "";
      const owns = await this.projects.get(new Types.ObjectId(payload.sub), projectId).then(() => true, () => false);
      if (!owns) return ws.close(4404, "project not found");
      return this.addEditor(ws, projectId);
    }
    ws.close(4400, "bad role");
  }

  private addEditor(ws: WebSocket, projectId: string) {
    this.editors.get(projectId)?.close(4409, "editor opened elsewhere");
    this.editors.set(projectId, ws);
    this.toAgents(projectId, JSON.stringify({ type: MsgType.EditorOpen }));
    if (this.agents.get(projectId)?.size) ws.send(JSON.stringify({ type: MsgType.Attached, projectId }));
    ws.on("message", (raw) => {
      const text = String(raw);
      const type = (JSON.parse(text) as { type?: string }).type;
      if (type === MsgType.Hello || type === MsgType.SceneChanged) this.lastScene.set(projectId, text);
      this.toAgents(projectId, text);
    });
    ws.on("close", () => {
      if (this.editors.get(projectId) !== ws) return;
      this.editors.delete(projectId);
      this.toAgents(projectId, JSON.stringify({ type: MsgType.EditorClosed }));
    });
  }

  private addAgent(ws: WebSocket, projectId: string) {
    const set = this.agents.get(projectId) ?? new Set<WebSocket>();
    set.add(ws);
    this.agents.set(projectId, set);
    const editor = this.editors.get(projectId);
    editor?.send(JSON.stringify({ type: MsgType.Attached, projectId }));
    ws.send(JSON.stringify({ type: editor ? MsgType.EditorOpen : MsgType.EditorClosed }));
    const last = this.lastScene.get(projectId);
    if (editor && last) ws.send(last);
    ws.on("message", (raw) => {
      const text = String(raw);
      const ed = this.editors.get(projectId);
      if (ed?.readyState === WebSocket.OPEN) return ed.send(text);
      const { requestId } = JSON.parse(text) as { requestId?: string };
      if (requestId) {
        ws.send(JSON.stringify({ type: MsgType.Result, requestId, ok: false, error: "The editor is not open on this project. Ask the user to open it in Motionily." }));
      }
    });
    ws.on("close", () => {
      set.delete(ws);
      if (set.size === 0) this.editors.get(projectId)?.send(JSON.stringify({ type: MsgType.Detached, projectId }));
    });
    this.logger.log(`agent joined project ${projectId} (${set.size} connected)`);
  }

  /** Tell the open editor that project settings changed (e.g. an agent swapped a brick). */
  notifyProjectChanged(projectId: string) {
    const ed = this.editors.get(projectId);
    if (ed?.readyState === WebSocket.OPEN) ed.send(JSON.stringify({ type: MsgType.ProjectChanged, projectId }));
  }

  private toAgents(projectId: string, text: string) {
    for (const a of this.agents.get(projectId) ?? []) if (a.readyState === WebSocket.OPEN) a.send(text);
  }
}
