import { BadGatewayException, Injectable } from "@nestjs/common";
import type { Types } from "mongoose";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { askAgent, jsonIn } from "../common/agent-once";
import { AgentSettingsService } from "../users/agent-settings";
import { AgentEffort, AgentModel } from "../projects/projects.dto";
import { ProjectsService } from "../projects/projects.service";
import type { SunoPrompt } from "../projects/project.schema";
import { rolePrompt } from "../common/prompts";

const SUNO_TIMEOUT_MS = 120_000;
/** Suno's "Style of Music" field takes more, but short styles steer it best. */
const MAX_STYLE = 300;
const MAX_STRUCTURE = 1500;
/** A new phrase of the timeline after a pause this long. */
const PHRASE_GAP = 0.5;
/** How much of the timeline Claude reads. */
const MAX_LINES = 60;
const BRIEF_CHARS = 1200;
const SCRIPT_CHARS = 2500;


export class SunoPromptDto {
  /** What to change from the last prompt ("darker", "more electronic"). */
  @IsOptional() @IsString() @MaxLength(300) steer?: string;
}

type SceneLike = {
  duration?: number;
  layers?: { id: string; type?: string; group?: string; start?: number; end?: number | null; text?: string }[];
  captions?: { words?: { text: string; start: number; end: number }[] } | null;
} | null;

/** The video as a timeline Claude can plan music on: what is said when, and which graphics play when. */
export function videoTimeline(scene: SceneLike): string[] {
  const duration = scene?.duration ?? 0;
  const lines: { at: number; text: string }[] = [];
  let phrase: { start: number; end: number; words: string[] } | null = null;
  for (const w of scene?.captions?.words ?? []) {
    if (phrase && w.start - phrase.end < PHRASE_GAP) {
      phrase.end = w.end;
      phrase.words.push(w.text);
      continue;
    }
    if (phrase) lines.push({ at: phrase.start, text: `voice: "${phrase.words.join(" ")}"` });
    phrase = { start: w.start, end: w.end, words: [w.text] };
  }
  if (phrase) lines.push({ at: phrase.start, text: `voice: "${phrase.words.join(" ")}"` });
  const groups = new Map<string, { start: number; end: number }>();
  for (const l of scene?.layers ?? []) {
    if (!l.group || l.type === "video") continue;
    const g = groups.get(l.group) ?? { start: Infinity, end: 0 };
    g.start = Math.min(g.start, l.start ?? 0);
    g.end = Math.max(g.end, l.end ?? duration);
    groups.set(l.group, g);
  }
  for (const [name, g] of groups) if (g.end - g.start < duration * 0.9) lines.push({ at: g.start, text: `scene "${name}" until ${g.end.toFixed(1)} s` });
  return lines
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_LINES)
    .map((l) => `${l.at.toFixed(1)} s ${l.text}`);
}

/** Writes (and keeps with the video) the Suno prompt for its background music. */
@Injectable()
export class SunoService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly agentSettings: AgentSettingsService,
  ) {}

  async write(ownerId: Types.ObjectId, projectId: string, steer?: string): Promise<SunoPrompt> {
    const project = await this.projects.get(ownerId, projectId);
    const scene = project.scene as SceneLike;
    const duration = scene?.duration ?? 0;
    const script = project.voiceScript.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    const prompt = [
      `Video: "${project.name}", ${duration.toFixed(1)} s, format ${project.format}`,
      project.brief.trim() && `Brief:\n${project.brief.trim().slice(0, BRIEF_CHARS)}`,
      script && `Voice-over script:\n${script.slice(0, SCRIPT_CHARS)}`,
      `Timeline:\n${videoTimeline(scene).join("\n") || "(not built yet)"}`,
      project.sunoPrompt && steer?.trim() && `Last prompt (style): ${project.sunoPrompt.style}`,
      steer?.trim() && `Change: ${steer.trim()}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { text } = await askAgent({ prompt, system: rolePrompt("suno"), model: AgentModel.Sonnet, effort: AgentEffort.Low, timeoutMs: SUNO_TIMEOUT_MS, agent: await this.agentSettings.forUser(ownerId) });
    const a = jsonIn<{ title?: unknown; style?: unknown; structure?: unknown; drop_at?: unknown; notes?: unknown }>(text);
    if (typeof a?.style !== "string" || typeof a.structure !== "string") throw new BadGatewayException("Claude did not return a Suno prompt; try again");
    const dropAt = typeof a.drop_at === "number" && a.drop_at >= 0 ? Math.min(a.drop_at, duration || a.drop_at) : null;
    const suno: SunoPrompt = {
      title: typeof a.title === "string" ? a.title.slice(0, 80) : project.name,
      style: a.style.trim().slice(0, MAX_STYLE),
      structure: a.structure.trim().slice(0, MAX_STRUCTURE),
      dropAt,
      notes: typeof a.notes === "string" ? a.notes.trim().slice(0, 400) : "",
      createdAt: new Date().toISOString(),
    };
    await this.projects.setSunoPrompt(project.id, suno);
    return suno;
  }
}
