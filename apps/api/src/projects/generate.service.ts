import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Types } from "mongoose";
import { TokenScope, type JwtPayload } from "../auth/auth";
import { ProjectsService } from "./projects.service";
import type { GenerateDto } from "./projects.dto";

export enum GenerateStatus {
  Idle = "idle",
  Running = "running",
  Done = "done",
  Failed = "failed",
  Stopped = "stopped",
}

export enum GenerateEventKind {
  /** The agent called a Motionily tool. */
  Tool = "tool",
  /** The agent said something. */
  Text = "text",
  Error = "error",
}

export type GenerateEvent = { at: string; kind: GenerateEventKind; text: string };

type Run = { process: ChildProcess | null; status: GenerateStatus; events: GenerateEvent[]; summary: string | null };

const MAX_EVENTS = 200;
const MCP_SERVER = "motionily";

/** How the agent should work when launched from the editor's Generate button. */
const AGENT_GUIDE = `You are Motionily's motion designer and art director. You build the WHOLE video through the motionily MCP tools.
There are NO presets in Motionily: no built-in animations, transitions, styles, templates or stock models.
You decide the concept, look, colors, typography and you write every animation yourself as keyframes,
exactly like a motion designer building a spot by hand. Avoid generic videos. Work like a senior motion designer:
1. get_project (brief), get_brand (product notes, brand palettes, logos, screenshots with descriptions), then
   get_reference once. If the brand has palettes, build from them; if not, choose your own palette for the concept.
   Show and explain the real product (view_asset to look at screenshots; image layers to show them).
   The VOICE-OVER drives the video: if there are captions (the user uploaded the voice), tie every beat, text
   and cut to the words' timings and make on-screen text mirror what is said. If there is only a voice script
   (get_project), time beats to its paragraphs (~2.3 words/s, "[long pause]" = scene change) and keep it.
2. Decide an art direction that fits THIS brief (one sentence: concept, visual metaphor, mood, pacing), then plan
   2-5 beats. One idea per beat, strong hierarchy, big legible type, deliberate composition.
3. Express that direction yourself: set_palette op with your own colors, a Google Font that fits (search_fonts +
   set_font), hand-written keyframes on every element (or your own define_anim keys reused across layers),
   your own cuts and wipes between beats.
   For places, people and objects use the 3D stage built PROCEDURALLY: list_prefabs first and reuse; otherwise
   design what the brief needs from primitives and save each piece with save_prefab so the user's library grows;
   place them with put_prop and give them behaviour with beats (go_to, sit_on, face, walk_to). People are ALWAYS
   stickman rigs. Move the camera with your own keyframes (set_camera) or set_shots for auto-framed moves.
   MOTION IS THE PRODUCT: staggered entrances, emphasis on key words, characters always doing something, camera
   that moves with intent. Nothing should sit still for more than ~1.5 s.
4. SELF-REVIEW with review_video (contact sheet + automatic checks). Fix every reported issue and anything a
   motion designer would reject: cut or off-screen characters, overlapping or tiny text, dead air, flat camera,
   generic look. Use render_frames to zoom into a moment. Review again until it is clean (max 3 rounds).
   Never hand back a video you have not reviewed.
5. Check get_feedback at the end and apply it.
Finish with a 2-3 sentence summary in Spanish: the art direction you chose and what the video shows.`;

/**
 * Runs Claude Code headless (`claude -p`) for a project, with the Motionily MCP
 * server preconfigured and scoped to that project. Uses the local Claude login;
 * a hosted version would swap this for the Agent SDK with an API key.
 */
@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);
  private runs = new Map<string, Run>();

  constructor(
    private readonly projects: ProjectsService,
    private readonly jwt: JwtService,
  ) {}

  status(projectId: string) {
    const run = this.runs.get(projectId);
    return run
      ? { status: run.status, events: run.events, summary: run.summary }
      : { status: GenerateStatus.Idle, events: [], summary: null };
  }

  async start(ownerId: Types.ObjectId, email: string, projectId: string, { instruction, model, effort }: GenerateDto) {
    const project = await this.projects.get(ownerId, projectId);
    if (this.runs.get(project.id)?.status === GenerateStatus.Running) {
      throw new ConflictException("the agent is already working on this project");
    }
    const payload: JwtPayload = { sub: ownerId.toString(), email, scope: TokenScope.Agent, projectId: project.id };
    const token = await this.jwt.signAsync(payload, { expiresIn: "2h" });

    const mcpDir = resolve(process.env.MOTIONILY_MCP_DIR ?? join(process.cwd(), "../../packages/mcp-server"));
    // Fresh empty folder: the agent must not pick up any repo's CLAUDE.md or files.
    const workDir = mkdtempSync(join(tmpdir(), "motionily-agent-"));
    const config = join(workDir, "mcp.json");
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER]: {
            command: join(mcpDir, "node_modules/.bin/tsx"),
            args: [join(mcpDir, "src/index.ts")],
            env: { MOTIONILY_API: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3100}`, MOTIONILY_PROJECT: project.id, MOTIONILY_TOKEN: token },
          },
        },
      }),
    );

    const prompt = instruction?.trim()
      ? `The user asks: "${instruction.trim()}". Apply it to the current video (read get_project and get_scene first; finish with review_video and fix what it shows).`
      : "Design and build the video for this project from its brief.";
    const child = spawn(
      process.env.CLAUDE_BIN ?? "claude",
      [
        "-p",
        prompt,
        "--append-system-prompt",
        AGENT_GUIDE,
        "--mcp-config",
        config,
        "--strict-mcp-config",
        "--allowedTools",
        `mcp__${MCP_SERVER}`,
        "--output-format",
        "stream-json",
        "--verbose",
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
      ],
      { cwd: workDir, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    const run: Run = { process: child, status: GenerateStatus.Running, events: [], summary: null };
    this.runs.set(project.id, run);
    const push = (kind: GenerateEventKind, text: string) => {
      run.events.push({ at: new Date().toISOString(), kind, text });
      if (run.events.length > MAX_EVENTS) run.events.shift();
    };

    let buffered = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) this.onLine(line, run, push);
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
    child.on("error", (e) => {
      push(GenerateEventKind.Error, `No se pudo lanzar Claude Code: ${e.message}`);
      run.status = GenerateStatus.Failed;
    });
    child.on("close", (code) => {
      run.process = null;
      if (run.status !== GenerateStatus.Running) return;
      run.status = code === 0 ? GenerateStatus.Done : GenerateStatus.Failed;
      if (code !== 0) push(GenerateEventKind.Error, stderr.trim().split("\n").slice(-3).join(" ") || `claude terminó con código ${code}`);
    });
    this.logger.log(`agent started for project ${project.id}`);
    return this.status(project.id);
  }

  stop(projectId: string) {
    const run = this.runs.get(projectId);
    if (run?.process) {
      run.status = GenerateStatus.Stopped;
      run.process.kill("SIGTERM");
    }
    return this.status(projectId);
  }

  /** One stream-json line from claude: keep tool calls and text the user can follow. */
  private onLine(line: string, run: Run, push: (k: GenerateEventKind, t: string) => void) {
    let msg: { type?: string; subtype?: string; result?: string; message?: { content?: { type: string; text?: string; name?: string }[] } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "assistant") {
      for (const c of msg.message?.content ?? []) {
        if (c.type === "tool_use" && c.name) push(GenerateEventKind.Tool, c.name.replace(`mcp__${MCP_SERVER}__`, ""));
        if (c.type === "text" && c.text?.trim()) push(GenerateEventKind.Text, c.text.trim());
      }
    }
    if (msg.type === "result") {
      run.summary = msg.result?.trim() ?? null;
      if (msg.subtype && msg.subtype !== "success") push(GenerateEventKind.Error, msg.subtype);
    }
  }
}

