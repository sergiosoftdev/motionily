import { BadGatewayException, Injectable } from "@nestjs/common";
import type { Types } from "mongoose";
import { askClaude, jsonIn } from "../common/claude-once";
import { AgentEffort, AgentModel } from "../projects/projects.dto";
import { ProjectsService } from "../projects/projects.service";
import { BrandsService } from "../brands/brands.service";
import type { PostCopy } from "./post.schema";
import { MAX_CAPTION, MAX_HASHTAGS, type WriteCopyDto } from "./posts.dto";
import { rolePrompt } from "../common/prompts";

const COPY_TIMEOUT_MS = 120_000;
/** How much of each input the copywriter reads. */
const BRIEF_CHARS = 1500;
const SCRIPT_CHARS = 3000;
const NOTES_CHARS = 800;


/** Writes the caption and hashtags for each platform from what the video says (one quick Claude answer). */
@Injectable()
export class CopywriterService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly brands: BrandsService,
  ) {}

  async write(ownerId: Types.ObjectId, dto: WriteCopyDto): Promise<PostCopy[]> {
    const project = await this.projects.get(ownerId, dto.projectId);
    const brand = project.brandId ? await this.brands.get(ownerId, String(project.brandId)).catch(() => null) : null;
    const script = project.voiceScript.replace(/\[[^\]]*\]/g, " ").replace(/[ \t]+/g, " ").trim();
    const prompt = [
      `Platforms: ${dto.platforms.join(", ")}`,
      `Video: "${project.name}"`,
      project.brief.trim() && `Brief:\n${project.brief.trim().slice(0, BRIEF_CHARS)}`,
      script && `Voice-over script:\n${script.slice(0, SCRIPT_CHARS)}`,
      brand?.notes.trim() && `About the account (${brand.name}):\n${brand.notes.trim().slice(0, NOTES_CHARS)}`,
      dto.steer?.trim() && `Change from the last draft: ${dto.steer.trim()}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { text } = await askClaude({ prompt, system: rolePrompt("copywriter"), model: AgentModel.Sonnet, effort: AgentEffort.Low, timeoutMs: COPY_TIMEOUT_MS });
    const answer = jsonIn<{ copy?: { platform?: string; caption?: unknown; hashtags?: unknown }[] }>(text);
    const copy = dto.platforms.map((platform) => {
      const c = answer?.copy?.find((x) => x.platform === platform);
      return { platform, caption: typeof c?.caption === "string" ? c.caption.trim().slice(0, MAX_CAPTION) : "", hashtags: cleanHashtags(c?.hashtags) };
    });
    if (copy.every((c) => !c.caption)) throw new BadGatewayException("the copywriter did not return any caption; try again");
    // The draft stays with the video: opening Schedule again starts from it instead of asking Claude again.
    await this.projects.savePostCopy(project.id, copy);
    return copy;
  }
}

/** "#History", "history!" → "History"; drops empties and repeats. */
function cleanHashtags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags = raw.map((t) => String(t).replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean);
  return [...new Map(tags.map((t) => [t.toLowerCase(), t])).values()].slice(0, MAX_HASHTAGS);
}
