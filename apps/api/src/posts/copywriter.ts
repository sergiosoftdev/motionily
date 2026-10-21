import { BadGatewayException, Injectable } from "@nestjs/common";
import type { Types } from "mongoose";
import { askClaude, jsonIn } from "../common/claude-once";
import { AgentEffort, AgentModel } from "../projects/projects.dto";
import { ProjectsService } from "../projects/projects.service";
import { BrandsService } from "../brands/brands.service";
import type { PostCopy } from "./post.schema";
import { MAX_CAPTION, MAX_HASHTAGS, type WriteCopyDto } from "./posts.dto";

const COPY_TIMEOUT_MS = 120_000;
/** How much of each input the copywriter reads. */
const BRIEF_CHARS = 1500;
const SCRIPT_CHARS = 3000;
const NOTES_CHARS = 800;

const SYSTEM = `You write the social media copy for a short video made in Motionily: the caption and the hashtags
for each platform asked. Answer ONLY with JSON: {"copy":[{"platform":"instagram","caption":"…","hashtags":["…"]}]}.
- Write in the language of the video's voice-over and on-screen text (the brief may be in another language).
- Only what the video itself says: never invent facts, numbers, dates or claims.
- instagram (Reels): the first line is a hook that works on its own before "more" (under 125 characters), then
  2-4 short lines that add context or a reason to watch to the end, then one call to action (follow, save or share).
- tiktok: one or two short lines (under 150 characters in total) with the words people would search for.
- Natural, spoken tone. At most one or two emojis, and only if they fit the video's tone (none for serious topics).
- 3-5 hashtags per platform: one or two broad ones and the rest specific to the topic. Without "#", no spaces or
  punctuation. Never fyp, foryou, viral or similar filler.`;

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
    const { text } = await askClaude({ prompt, system: SYSTEM, model: AgentModel.Sonnet, effort: AgentEffort.Low, timeoutMs: COPY_TIMEOUT_MS });
    const answer = jsonIn<{ copy?: { platform?: string; caption?: unknown; hashtags?: unknown }[] }>(text);
    const copy = dto.platforms.map((platform) => {
      const c = answer?.copy?.find((x) => x.platform === platform);
      return { platform, caption: typeof c?.caption === "string" ? c.caption.trim().slice(0, MAX_CAPTION) : "", hashtags: cleanHashtags(c?.hashtags) };
    });
    if (copy.every((c) => !c.caption)) throw new BadGatewayException("the copywriter did not return any caption; try again");
    return copy;
  }
}

/** "#History", "history!" → "History"; drops empties and repeats. */
function cleanHashtags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags = raw.map((t) => String(t).replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean);
  return [...new Map(tags.map((t) => [t.toLowerCase(), t])).values()].slice(0, MAX_HASHTAGS);
}
