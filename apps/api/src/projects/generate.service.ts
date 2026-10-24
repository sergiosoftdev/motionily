import { ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { checkPrompts, rolePrompt } from "../common/prompts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConflictException, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Types } from "mongoose";
import { TokenScope, type JwtPayload } from "../auth/auth";
import { ProjectsService } from "./projects.service";
import { AgentEffort, AgentModel, GenerateMode, type GenerateDto } from "./projects.dto";
import { VideoFormat, type AgentRunUsage } from "./project.schema";
import { filmNotes } from "../references/film";
import { AgentEventKind, agentCli, bareTool, emptyUsage, modelFor, runAgent, type AgentCli, type AgentMcp, type AgentUsage } from "../common/agent-cli";

export enum GenerateStatus {
  Idle = "idle",
  Running = "running",
  Done = "done",
  Failed = "failed",
  Stopped = "stopped",
  /** The API restarted mid-run; its agents were stopped. */
  Interrupted = "interrupted",
}

export enum GenerateEventKind {
  /** The agent called a Motionily tool. */
  Tool = "tool",
  /** The agent said something. */
  Text = "text",
  Error = "error",
  /** Team phase started: text is a GeneratePhase. */
  Phase = "phase",
  /** The plan: text is JSON [{group,start,end}]. */
  Plan = "plan",
  /** A role finished: text is the role (beat group, "plan" or "review"). */
  Done = "done",
}

export enum GeneratePhase {
  Plan = "plan",
  Build = "build",
  Review = "review",
  Sound = "sound",
}

export type GenerateEvent = { at: string; kind: GenerateEventKind; text: string };

/** A phrase of the voice-over with its timing: what the video must show while it is said. */
type VoiceLine = { start: number; end: number; text: string };

type Run = { voice?: VoiceLine[]; projectId?: string; processes: Set<ChildProcess>; status: GenerateStatus; events: GenerateEvent[]; summary: string | null; usage: AgentRunUsage | null };

export function usageFrom(r: AgentUsage, kind: string, model: string | null, effort: string | null): AgentRunUsage {
  return { at: new Date().toISOString(), kind, model, effort, ...r };
}

const MAX_EVENTS = 200;
const MCP_SERVER = "motionily";
/** Beats built at the same time (each is its own claude process). */
const MAX_PARALLEL_BUILDERS = 4;
const MAX_BEATS = 6;

/** Mirrors FORMAT_SIZE in @motionily/protocol. */
const FORMAT_SIZE: Record<VideoFormat, [number, number]> = {
  [VideoFormat.Vertical]: [1080, 1920],
  [VideoFormat.Horizontal]: [1920, 1080],
  [VideoFormat.Square]: [1080, 1080],
  [VideoFormat.Portrait]: [1080, 1350],
};

/** MCP tools each role sees (each tool description costs context on every turn). */
const ROLE_TOOLS = {
  planner: [
    "get_project",
    "get_brand",
    "view_image",
    "view_asset",
    "search_fonts",
    "set_font",
    "apply_ops",
    "add_layers",
    "cut",
    "search_assets",
    "import_assets",
    "cut_out",
    "list_library",
    "generate_image",
    "set_direction",
    "examples",
    "define_component",
    "get_component",
  ],
  builder: ["run", "add_layers", "edit_layers", "apply_ops", "get_layout", "render_frames", "view_asset", "view_image", "get_brand", "find_icons", "add_vector", "add_map", "cut_out", "cut", "define_component", "get_component"],
  finisher: ["run", "get_feedback", "cut", "edit_layers", "review_video", "get_layout", "render_frames", "inspect", "add_layers", "apply_ops", "list_sounds", "add_sfx", "get_component", "set_font", "search_fonts"],
  sound: ["get_project", "list_sounds", "add_sfx"],
} as const;

/** The timed voice-over, phrase by phrase (the engine's own phrasing: a pause or 12 words starts a new line). */
function voiceLines(scene: unknown): VoiceLine[] {
  const words = (scene as { captions?: { words?: { text: string; start: number; end: number }[] } } | null)?.captions?.words ?? [];
  const lines: VoiceLine[] = [];
  for (const w of words) {
    const cur = lines.at(-1);
    if (cur && w.start - cur.end <= 0.6 && cur.text.split(" ").length < 12) {
      cur.text += ` ${w.text}`;
      cur.end = w.end;
    } else {
      lines.push({ start: w.start, end: w.end, text: w.text });
    }
  }
  return lines;
}

function voiceDuring(lines: VoiceLine[], from: number, to: number): string {
  return lines
    .filter((l) => l.end >= from && l.start <= to)
    .map((l) => `${l.start.toFixed(1)}-${l.end.toFixed(1)}s "${l.text}"`)
    .join("\n");
}

/** What the voice says during this beat, so the builder shows it. */
function voiceFor(run: Run, beat: Beat): string {
  const said = voiceDuring(run.voice ?? [], beat.start, beat.end);
  return said ? `\nThe voice-over says during this beat (show these words on screen, in order):\n${said}` : "";
}


/** What happens at a moment of the cut. */
const MomentKind = { Enter: "enter", Exit: "exit", Animation: "animation", Voice: "voice", Emphasis: "emphasis" } as const;
type MomentKind = (typeof MomentKind)[keyof typeof MomentKind];

/** A moment of the cut where a sound can land: a layer enters or leaves, an animation starts, a phrase or an emphasis word. */
type Moment = { at: number; kind: MomentKind; what: string };

/** Layer `type` of video clips (the user's footage) in the scene JSON. */
const VIDEO_LAYER = "video";

/** A cue the team already placed covers the moments this close to it. */
const CUE_COVERS_S = 0.4;

/**
 * The moments the sound pass places sounds on, read from the scene (the agent can't infer them from the brief).
 * Moments next to a cue the team already placed are left out, so the pass fills gaps instead of doubling sounds.
 */
function sceneMoments(scene: Record<string, unknown> | null): { moments: Moment[]; placed: number } {
  const s = scene as {
    duration?: number;
    layers?: { id: string; type?: string; start?: number; end?: number | null; anims?: { use: string; at?: number }[] }[];
    captions?: { words?: { text: string; start: number; end: number; emphasis?: boolean }[] };
    sfx?: { at: number }[];
  } | null;
  const duration = s?.duration ?? 0;
  const moments: Moment[] = [];
  for (const l of s?.layers ?? []) {
    // The user's footage: each cut is a layer, and a sound on every jump cut would be noise.
    if (l.type === VIDEO_LAYER) continue;
    const start = l.start ?? 0;
    if (start > 0.05) moments.push({ at: start, kind: MomentKind.Enter, what: l.id });
    if (l.end != null && l.end < duration - 0.1) moments.push({ at: l.end, kind: MomentKind.Exit, what: l.id });
    for (const a of l.anims ?? []) moments.push({ at: start + (a.at ?? 0), kind: MomentKind.Animation, what: `${l.id} ${a.use}` });
  }
  const words = s?.captions?.words ?? [];
  words.forEach((w, i) => {
    if (i === 0 || w.start - (words[i - 1]?.end ?? 0) > 0.6) moments.push({ at: w.start, kind: MomentKind.Voice, what: w.text });
    if (w.emphasis) moments.push({ at: w.start, kind: MomentKind.Emphasis, what: w.text });
  });
  const cues = (s?.sfx ?? []).map((c) => c.at);
  // Sorted, and never two moments closer than 0.25 s: one sound per beat of the picture, not a stream.
  moments.sort((a, b) => a.at - b.at);
  const kept: Moment[] = [];
  for (const m of moments) {
    if (cues.some((at) => Math.abs(at - m.at) < CUE_COVERS_S)) continue;
    if (!kept.length || m.at - kept[kept.length - 1]!.at >= 0.25) kept.push(m);
  }
  return { moments: kept.slice(0, 60), placed: cues.length };
}








type RoleModel = { model: AgentModel; effort: AgentEffort };
type TeamSetup = {
  plan: RoleModel;
  build: RoleModel;
  review: RoleModel;
  reviewRounds: number;
  /** One designer owns the whole video (no split into parallel beats): best continuity. */
  solo?: boolean;
};

/**
 * Who does what in each mode. Premium is all Opus thinking hard (best motion design, slowest and
 * priciest); Economy is Sonnet executing a Sonnet plan.
 */
const TEAM: Record<Exclude<GenerateMode, GenerateMode.Custom>, TeamSetup> = {
  [GenerateMode.Premium]: {
    plan: { model: AgentModel.Opus, effort: AgentEffort.High },
    build: { model: AgentModel.Opus, effort: AgentEffort.High },
    review: { model: AgentModel.Opus, effort: AgentEffort.Medium },
    reviewRounds: 3,
    solo: true,
  },
  [GenerateMode.Balanced]: {
    plan: { model: AgentModel.Opus, effort: AgentEffort.Medium },
    build: { model: AgentModel.Sonnet, effort: AgentEffort.Medium },
    review: { model: AgentModel.Sonnet, effort: AgentEffort.Medium },
    reviewRounds: 2,
  },
  [GenerateMode.Economy]: {
    plan: { model: AgentModel.Sonnet, effort: AgentEffort.Medium },
    build: { model: AgentModel.Sonnet, effort: AgentEffort.Low },
    review: { model: AgentModel.Sonnet, effort: AgentEffort.Low },
    reviewRounds: 1,
  },
};

function teamFor(mode: GenerateMode | undefined, model?: AgentModel, effort?: AgentEffort): TeamSetup {
  if (mode && mode !== GenerateMode.Custom) return TEAM[mode];
  const m = model ?? AgentModel.Sonnet;
  const e = effort ?? AgentEffort.Medium;
  return { plan: { model: m, effort: e }, build: { model: m, effort: e }, review: { model: m, effort: e }, reviewRounds: 2 };
}

/** `energy` (0-100) and `device` trace the attention curve the planner designed (craft: SHORT-FORM ATTENTION CURVE). */
type Beat = { group: string; start: number; end: number; brief: string; region?: string; energy?: number; device?: string };

/** Energy from which a beat is a peak, and under which it is a valley. */
const PEAK_ENERGY = 80;
const VALLEY_ENERGY = 50;

/** What a beat's energy asks of its builder. */
function energyNote(beat: Beat): string {
  if (beat.energy === undefined) return "";
  const how =
    beat.energy >= PEAK_ENERGY
      ? "A PEAK: hit it hard (camera move or whip, scale punch or color flip, big type, impact moment) and land it early in your span."
      : beat.energy >= VALLEY_ENERGY
        ? "A RE-HOOK: one clear new thing early in your span (a reveal, a number, a twist), then keep it moving."
        : "A VALLEY: calmer drift and smaller type, but a fact on screen and something moving every 0.5-1.5 s.";
  return `\nAttention: energy ${beat.energy}/100${beat.device ? `, device ${beat.device}` : ""}. ${how}`;
}
type Plan = { direction: string; motif?: string; reference?: string; beats: Beat[] };

/**
 * Runs Claude Code headless (`claude -p`) for a project, with the Motionily MCP
 * server preconfigured and scoped to that project. Uses the local Claude login;
 * a hosted version would swap this for the Agent SDK with an API key.
 *
 * A full build is a small team: a planner sets the look and splits the video into
 * beats, builders write each beat at the same time, and a finisher reviews the cut.
 * Requests on top of an existing video use a single agent.
 */
/** Is this pid a live claude process (and not some unrelated process that reused the pid)? */
/** A live agent CLI process (any of the CLIs Motionily drives), not a reused pid. */
function isClaude(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="]).toString();
    return /claude|codex|gemini|opencode/.test(cmd);
  } catch {
    return false;
  }
}

@Injectable()
export class GenerateService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GenerateService.name);
  private runs = new Map<string, Run>();

  constructor(
    private readonly projects: ProjectsService,
    private readonly jwt: JwtService,
  ) {}

  /** After a restart: agents a previous API process left behind are stopped and their runs marked interrupted. */
  async onModuleInit() {
    this.logger.log(`${checkPrompts()} prompts loaded from docs/agent/prompts`);
    for (const p of await this.projects.liveRuns()) {
      const pids = p.liveRun?.pids ?? [];
      for (const pid of pids) if (isClaude(pid)) process.kill(pid, "SIGKILL");
      // A run that logged its result after it started actually finished: just clear the marker.
      const startedAt = p.liveRun?.startedAt ?? "";
      if (!pids.length && (p.agentRuns ?? []).some((r) => r.at >= startedAt)) {
        await this.projects.setLiveRun(String(p._id), null);
        continue;
      }
      await this.projects.setLiveRun(String(p._id), { status: GenerateStatus.Interrupted, startedAt: p.liveRun!.startedAt, pids: [] });
      this.logger.warn(`run on ${String(p._id)} interrupted by a restart (${pids.length} agents stopped)`);
    }
  }

  /** Hot reload / shutdown: never leave claude processes burning tokens with nobody tracking them. */
  async onApplicationShutdown() {
    for (const [projectId, run] of this.runs) {
      if (run.status !== GenerateStatus.Running) continue;
      run.status = GenerateStatus.Interrupted;
      // Keep the pids: if the kill doesn't land before we exit, the next boot finishes the job.
      const pids = [...run.processes].flatMap((p) => (p.pid ? [p.pid] : []));
      for (const p of run.processes) p.kill("SIGKILL");
      await this.projects.setLiveRun(projectId, { status: GenerateStatus.Interrupted, startedAt: new Date().toISOString(), pids }).catch(() => undefined);
    }
  }

  isRunning(projectId: string) {
    return this.runs.get(projectId)?.status === GenerateStatus.Running;
  }

  status(projectId: string) {
    const run = this.runs.get(projectId);
    return run
      ? { status: run.status, events: run.events, summary: run.summary, usage: run.usage }
      : { status: GenerateStatus.Idle, events: [], summary: null, usage: null };
  }

  /** Status including runs this API process doesn't hold in memory (e.g. interrupted by a restart). */
  async statusOf(projectId: string) {
    if (this.runs.has(projectId)) return this.status(projectId);
    const live = await this.projects.liveRunOf(projectId);
    if (live?.status === GenerateStatus.Interrupted) return { status: GenerateStatus.Interrupted, events: [], summary: null, usage: null };
    return this.status(projectId);
  }

  async start(ownerId: Types.ObjectId, email: string, projectId: string, { instruction, model, effort, references, mode, resume, sfxOnly }: GenerateDto) {
    const project = await this.projects.get(ownerId, projectId);
    if (this.runs.get(project.id)?.status === GenerateStatus.Running) {
      throw new ConflictException("the agent is already working on this project");
    }
    // A team started by another API process (before a restart) may still be alive: never run two.
    const live = await this.projects.liveRunOf(project.id);
    if (live?.status === GenerateStatus.Running && live.pids.some(isClaude)) {
      throw new ConflictException("the agent is already working on this project");
    }
    const payload: JwtPayload = { sub: ownerId.toString(), email, scope: TokenScope.Agent, projectId: project.id };
    const token = await this.jwt.signAsync(payload, { expiresIn: "2h" });
    const mcp = (tools?: readonly string[]) => this.mcpServer(project.id, token, tools);

    const run: Run = { processes: new Set(), status: GenerateStatus.Running, events: [], summary: null, usage: null };
    this.runs.set(project.id, run);
    await this.projects.setLiveRun(project.id, { status: GenerateStatus.Running, startedAt: new Date().toISOString(), pids: [] });
    run.projectId = project.id;
    const voice = voiceLines(project.scene);
    run.voice = voice;
    const voiceNote = voice.length ? `\nVoice-over, timed (what is said when; the video must show it at that moment):\n${voiceDuring(voice, 0, Infinity)}` : "";
    const refs = (await referencePrompt([...new Set([...(project.references ?? []), ...(references ?? [])])])) + voiceNote;
    const opts: AgentOpts = { cli: agentCli(), mcp, model, effort, size: FORMAT_SIZE[project.format] ?? FORMAT_SIZE[VideoFormat.Vertical] };

    // Callers without a mode (prefab workshop, older clients) keep their explicit model/effort.
    mode ??= model ? GenerateMode.Custom : GenerateMode.Balanced;
    const team = teamFor(mode, model, effort);
    // A fresh start drops any plan from an earlier run; a resume keeps it when one was saved.
    const saved = resume ? await this.projects.buildPlanOf(project.id) : null;
    if (!resume) await this.projects.setBuildPlan(project.id, null);
    const build = sfxOnly
      ? null
      : resume
      ? saved
        ? this.resume(run, refs, { ...opts, ...team.build }, team, saved)
        : this.single(run, rolePrompt("continue") + refs, { ...opts, ...team.build })
      : instruction?.trim()
      ? this.single(run, `The user asks: "${instruction.trim()}". Apply it to the current video (read get_project and inspect first; finish with review_video and fix what it shows).${refs}`, { ...opts, ...team.build })
      : project.footage?.length
      ? this.editFootage(run, refs, { ...opts, ...team.build })
      : this.team(run, refs, opts, team, mode);
    // The sound pass follows a build, not an edit: after every change request it would stack more cues on the
    // same moments (the edit agent places sounds itself when the user asks for them). Sound-only runs just it.
    const soundAfter = !instruction?.trim();
    const work = build
      ? build.then(async (usage) => {
          if (soundAfter && run.status === GenerateStatus.Running) await this.projects.logAgentRun(project.id, await this.soundPass(run, { ...opts, ...team.review }));
          return usage;
        })
      : this.soundPass(run, { ...opts, ...team.review });
    void work
      .then(async (usage) => {
        run.usage = usage;
        if (run.status === GenerateStatus.Running) run.status = GenerateStatus.Done;
        if (run.status === GenerateStatus.Done) await this.projects.setBuildPlan(project.id, null);
        // In order: the finished run is on record before the live marker goes.
        await this.projects.logAgentRun(project.id, usage);
        await this.projects.setLiveRun(project.id, null);
      })
      .catch((e: Error) => {
        if (run.status !== GenerateStatus.Running) return;
        this.push(run, GenerateEventKind.Error, e.message);
        run.status = GenerateStatus.Failed;
        void this.projects.setLiveRun(project.id, null);
      });
    this.logger.log(`agent started for project ${project.id}`);
    return this.status(project.id);
  }

  stop(projectId: string) {
    const run = this.runs.get(projectId);
    if (run?.status === GenerateStatus.Running) {
      run.status = GenerateStatus.Stopped;
      for (const p of run.processes) p.kill("SIGTERM");
    }
    void this.projects.setLiveRun(projectId, null);
    return this.status(projectId);
  }

  /** A failed sound pass never fails the video: the cut is already done, so it only leaves a note. */
  private async soundPass(run: Run, o: AgentOpts): Promise<AgentRunUsage> {
    const t0 = Date.now();
    const results: AgentUsage[] = [];
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Sound);
    try {
      const { scene, brief } = await this.projects.soundInputOf(run.projectId!);
      const { moments, placed } = sceneMoments(scene);
      if (placed && !moments.length) {
        this.push(run, GenerateEventKind.Text, `Sound: the team already placed ${placed} cues, so nothing was added.`);
        return sumUsage(results, t0, { ...o, model: "sound", effort: undefined });
      }
      const list = moments.map((m) => `${m.at.toFixed(2)} ${m.kind} ${m.what}`).join("\n");
      const tone = brief.trim() ? `Brief (sets the tone):\n${brief.trim().slice(0, 1200)}\n\n` : "";
      const team = placed ? `The team already placed ${placed} cues; keep them and add only on these free moments.\n` : "";
      const prompt = moments.length
        ? `${tone}${team}Place sounds on these moments of the cut (seconds, kind, what). Use the time exactly as written, one add_sfx call:\n${list}`
        : `${tone}Add the sound effects to this video.`;
      const r = await this.agent(run, prompt, rolePrompt("sound"), { ...o, effort: AgentEffort.Low }, "sound", ROLE_TOOLS.sound);
      results.push(r.result);
      // What the sound agent says it did, so an empty result is visible in the log instead of silent.
      this.push(run, GenerateEventKind.Text, `Sound: ${r.text}`);
      // The builders' summary describes the video; the sound line only stands in when there is none.
      if (!run.summary) run.summary = r.text;
    } catch (e) {
      this.push(run, GenerateEventKind.Error, `sound: ${(e as Error).message}`);
      if (!run.summary) run.summary = `Sound: ${(e as Error).message}`;
    }
    return sumUsage(results, t0, { ...o, model: "sound", effort: undefined });
  }

  /** One editor cuts the user's clips and adds the graphics: the cut needs a single view of the whole transcript. */
  private async editFootage(run: Run, refs: string, o: AgentOpts): Promise<AgentRunUsage> {
    const r = await this.agent(run, `Edit this video from the user's footage.${refs}`, rolePrompt("footage"), o, "edit", undefined);
    run.summary = r.text;
    return usageFrom(r.result, "edit", o.model ?? null, o.effort ?? null);
  }

  private async single(run: Run, prompt: string, o: AgentOpts): Promise<AgentRunUsage> {
    const r = await this.agent(run, prompt, rolePrompt("agent"), o, "", undefined);
    run.summary = r.text;
    return usageFrom(r.result, "edit", o.model ?? null, o.effort ?? null);
  }

  /** Plan, build beats in parallel, finish. Wall time ≈ planner + slowest beat + finisher. */
  private async team(run: Run, refs: string, base: AgentOpts, team: TeamSetup, mode: GenerateMode): Promise<AgentRunUsage> {
    // The cost log names the mode rather than one model (each role may run a different one).
    const label: AgentOpts = { ...base, model: `${mode} mode`, effort: undefined };
    const o: AgentOpts = { ...base, ...team.plan };
    const results: AgentUsage[] = [];
    const t0 = Date.now();
    if (team.solo) return this.solo(run, refs, base, team, label, t0);
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Plan);
    const planned = await this.agent(run, `Plan this video from its brief.${refs}`, rolePrompt("planner", { max_beats: MAX_BEATS }), o, "plan", ROLE_TOOLS.planner);
    results.push(planned.result);
    const plan = parsePlan(planned.text);
    await this.projects.setBuildPlan(run.projectId!, { plan: { ...plan }, done: [] });
    this.push(run, GenerateEventKind.Text, plan.direction);
    this.push(run, GenerateEventKind.Plan, JSON.stringify(plan.beats.map(({ group, start, end }) => ({ group, start, end }))));
    return this.buildFrom(run, plan, plan.beats, refs, base, team, results, label, t0);
  }

  /** Continue an interrupted team run: the saved plan, only the beats not built yet, then the review. */
  private async resume(run: Run, refs: string, base: AgentOpts, team: TeamSetup, saved: { plan: Record<string, unknown>; done: string[] }): Promise<AgentRunUsage> {
    const plan = saved.plan as Plan;
    const label: AgentOpts = { ...base, model: "continue", effort: undefined };
    this.push(run, GenerateEventKind.Text, plan.direction);
    return this.buildFrom(run, plan, plan.beats.filter((b) => !saved.done.includes(b.group)), refs, base, team, [], label, Date.now());
  }

  /** Builders write the given beats in parallel, then the finisher reviews the whole cut. */
  private async buildFrom(run: Run, plan: Plan, beats: Beat[], refs: string, base: AgentOpts, team: TeamSetup, results: AgentUsage[], label: AgentOpts, t0: number): Promise<AgentRunUsage> {
    const o = base;
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Build);

    // The plan already did the thinking: builders and finisher execute it with low effort (thinking is output tokens).
    const crew: AgentOpts = { ...base, ...team.build };
    const overview = plan.beats.map((b) => `- ${b.group} ${b.start}-${b.end}s${b.energy !== undefined ? ` (energy ${b.energy}${b.device ? `, ${b.device}` : ""})` : ""}: ${b.brief}`).join("\n");
    const queue = [...beats];
    const worker = async () => {
      for (let beat = queue.shift(); beat && run.status === GenerateStatus.Running; beat = queue.shift()) {
        const reference = plan.reference ? `\nReference breakdown (match its techniques and rhythm):\n${plan.reference}` : "";
        const prompt = `Art direction: ${plan.direction}\nRecurring motif: ${plan.motif ?? "—"}${reference}\nWhole video:\n${overview}\n\nYOUR BEAT: group "${beat.group}", ${beat.start}-${beat.end}s, world region ${beat.region ?? "centered"}.\n${beat.brief}${energyNote(beat)}${voiceFor(run, beat)}\nCanvas ${o.size[0]}x${o.size[1]} px. Palette and font are already set (use the slot names). Build it now.`;
        const r = await this.agent(run, prompt, rolePrompt("builder"), crew, beat.group, ROLE_TOOLS.builder).catch((e: Error) => {
          this.push(run, GenerateEventKind.Error, `${beat!.group}: ${e.message}`);
          return null;
        });
        if (r) {
          results.push(r.result);
          await this.projects.markBeatDone(run.projectId!, beat.group);
        }
        this.push(run, GenerateEventKind.Done, beat.group);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_BUILDERS, plan.beats.length) }, worker));
    if (run.status !== GenerateStatus.Running) return sumUsage(results, t0, label);

    this.push(run, GenerateEventKind.Phase, GeneratePhase.Review);
    const finished = await this.agent(run, `Review and polish the whole video. Canvas ${o.size[0]}x${o.size[1]} px. Groups: ${plan.beats.map((b) => `${b.group} ${b.start}-${b.end}s`).join(", ")}.${refs}`, rolePrompt("finisher", { review_rounds: team.reviewRounds }), { ...base, ...team.review }, "review", ROLE_TOOLS.finisher);
    results.push(finished.result);
    run.summary = finished.text;
    return sumUsage(results, t0, label);
  }

/** Premium: one designer builds the whole film as one continuous world, then a reviewer polishes it. */
  private async solo(run: Run, refs: string, base: AgentOpts, team: TeamSetup, label: AgentOpts, t0: number): Promise<AgentRunUsage> {
    const results: AgentUsage[] = [];
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Build);
    const designer = await this.agent(
      run,
      `This is a NEW video from scratch: first call apply_ops [{"op":"clear_layers"}] to drop any old cut. Canvas ${base.size[0]}x${base.size[1]} px.${refs}\n${rolePrompt("solo-steps")}`,
      rolePrompt("agent"),
      { ...base, ...team.build },
      "design",
      undefined,
    );
    results.push(designer.result);
    if (run.status !== GenerateStatus.Running) return sumUsage(results, t0, label);
    this.push(run, GenerateEventKind.Phase, GeneratePhase.Review);
    const finished = await this.agent(
      run,
      `Review and polish the whole video. Canvas ${base.size[0]}x${base.size[1]} px.${refs}`,
      rolePrompt("finisher", { review_rounds: team.reviewRounds }),
      { ...base, ...team.review },
      "review",
      ROLE_TOOLS.finisher,
    );
    results.push(finished.result);
    run.summary = finished.text;
    return sumUsage(results, t0, label);
  }

  /** One agent process (Claude Code, Codex, Gemini CLI or OpenCode); events are tagged with its role so the UI can show who is doing what. */
  private async agent(run: Run, prompt: string, guide: string, o: AgentOpts, role: string, tools: readonly string[] | undefined): Promise<{ text: string; result: AgentUsage }> {
    // Fresh empty folder: the agent must not pick up any repo's instructions or files.
    const cwd = mkdtempSync(join(tmpdir(), "motionily-agent-"));
    const tag = role ? `[${role}] ` : "";
    const r = await runAgent(
      o.cli,
      { prompt, system: guide, cwd, mcp: o.mcp(tools), model: modelFor(o.cli, o.model), effort: o.effort, stream: true },
      {
        onSpawn: (child) => {
          run.processes.add(child);
          if (child.pid && run.projectId) void this.projects.trackPid(run.projectId, child.pid, true);
        },
        onExit: (child) => {
          run.processes.delete(child);
          if (child.pid && run.projectId) void this.projects.trackPid(run.projectId, child.pid, false);
        },
        onEvent: (e) => {
          if (e.kind === AgentEventKind.Tool) this.push(run, GenerateEventKind.Tool, `${tag}${bareTool(e.text, MCP_SERVER)}`);
          if (e.kind === AgentEventKind.Text && !tag.startsWith("[plan")) this.push(run, GenerateEventKind.Text, `${tag}${e.text}`);
          if (e.kind === AgentEventKind.Error) this.push(run, GenerateEventKind.Error, `${tag}${e.text}`);
        },
      },
    );
    return { text: r.text.trim(), result: r.usage };
  }

  /** The Motionily MCP server as this run's agents start it (stdio, scoped to the project). */
  private mcpServer(projectId: string, token: string, tools?: readonly string[]): AgentMcp {
    const mcpDir = resolve(process.env.MOTIONILY_MCP_DIR ?? join(process.cwd(), "../../packages/mcp-server"));
    // A bundled server (desktop app) runs on node itself; from the repo it runs the TypeScript with tsx.
    const bundled = process.env.MOTIONILY_MCP_BUNDLE;
    return {
      name: MCP_SERVER,
      command: bundled ? process.execPath : join(mcpDir, "node_modules/.bin/tsx"),
      args: [bundled ?? join(mcpDir, "src/index.ts")],
      env: { MOTIONILY_API: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3100}`, MOTIONILY_PROJECT: projectId, MOTIONILY_TOKEN: token, MOTIONILY_MANUAL: "0" },
      tools,
    };
  }

  private push(run: Run, kind: GenerateEventKind, text: string) {
    run.events.push({ at: new Date().toISOString(), kind, text });
    if (run.events.length > MAX_EVENTS) run.events.shift();
  }

}

type AgentOpts = { cli: AgentCli; mcp: (tools?: readonly string[]) => AgentMcp; model?: string; effort?: string; size: [number, number] };

function parsePlan(text: string): Plan {
  try {
    const plan = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Plan;
    const beats = (plan.beats ?? []).filter((b) => b.group && b.end > b.start).slice(0, MAX_BEATS);
    if (!beats.length) throw new Error("no beats");
    return { direction: plan.direction ?? "", motif: plan.motif, reference: plan.reference, beats };
  } catch {
    throw new Error("The planner did not return a valid plan; try again.");
  }
}

/** What the agents are told about the user's references (images, and films cut into sheets + timing). */
async function referencePrompt(paths: string[]): Promise<string> {
  if (!paths.length) return "";
  const films = (await Promise.all(paths.map(filmNotes))).filter((n): n is string => !!n);
  const unique = [...new Set(films)];
  const film = unique.length
    ? ` REFERENCE FILM(S) — the quality bar: match their palette, density, camera language, transitions and shot rhythm. ${unique.join(" ")}`
    : "";
  return ` The user attached references; look at each with view_image first: ${paths.join(", ")}.${film}`;
}

/** One usage row for the whole team (wall time, not the sum of each agent's time). */
function sumUsage(results: AgentUsage[], t0: number, o: AgentOpts): AgentRunUsage {
  const total = emptyUsage();
  for (const r of results) {
    total.costUsd += r.costUsd;
    total.turns += r.turns;
    total.inputTokens += r.inputTokens;
    total.outputTokens += r.outputTokens;
    total.cacheReadTokens += r.cacheReadTokens;
    total.cacheWriteTokens += r.cacheWriteTokens;
  }
  total.durationMs = Date.now() - t0;
  return usageFrom(total, "generate", o.model ?? null, o.effort ?? null);
}
