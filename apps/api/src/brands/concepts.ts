import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { BadGatewayException, Injectable } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsEnum, Matches, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { AgentEffort, AgentModel, MAX_REFERENCES } from "../projects/projects.dto";
import { MEDIA_DIR, MEDIA_PATH } from "../media";
import { VideoFormat, type AgentRunUsage } from "../projects/project.schema";
import { usageFrom } from "../projects/generate.service";

export const MAX_CONCEPTS = 6;
const CONCEPT_TIMEOUT_MS = 180_000;

export class ConceptBeatDto {
  @IsString() at: string;
  @IsString() what: string;
}

/** One way to make the video, as the agent pitches it. */
export class ConceptDto {
  @IsString() title: string;
  @IsString() hook: string;
  @IsString() direction: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ConceptBeatDto) beats: ConceptBeatDto[];
  @IsString() voiceover: string;
  /** Full brief handed to the generator; the user can edit it. */
  @IsString() prompt: string;
}

export class ConceptsRequestDto {
  @IsString() @MinLength(3) @MaxLength(4000) idea: string;
  @IsOptional() @IsEnum(VideoFormat) format?: VideoFormat;
  @IsInt() @Min(1) @Max(MAX_CONCEPTS) count: number;
  /** When set, pitch only the concept for this angle (the client asks for each in parallel). */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_CONCEPTS - 1) angle?: number;
  /** "más humor", "menos texto"… applied to a new round. */
  @IsOptional() @IsString() @MaxLength(1000) steer?: string;
  /** Titles already shown, so a new round brings different ideas. */
  @IsOptional() @IsArray() @IsString({ each: true }) avoid?: string[];
  @IsOptional() @IsEnum(AgentModel) model?: AgentModel;
  @IsOptional() @IsEnum(AgentEffort) effort?: AgentEffort;
  /** Reference images the user attached to the idea (media paths). */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_REFERENCES) @Matches(MEDIA_PATH, { each: true }) references?: string[];
}

/** Different directions so parallel pitches don't converge on the same idea. */
const ANGLES = [
  "humor: a relatable everyday situation told with comic timing",
  "bold kinetic typography driven by the voice, punchy and rhythmic",
  "the product in action: real screens/UI walked through step by step",
  "data and proof: numbers, counters, before/after",
  "a visual metaphor that carries the whole video",
  "emotional micro-story of one person, from problem to relief",
];

type BrandContext = { name: string; notes: string; palettes: unknown[]; assets: { kind: string; name: string; description: string }[] };

const SYSTEM = `You are the creative director of Motionily, a tool where an AI agent builds motion-graphics videos
by hand (no presets: it writes every keyframe). Motionily is a MOTION GRAPHICS tool first: kinetic typography,
shapes, color blocks, icons, UI/product screens animated in 2D. 3D (procedural sets, faceless black stickmen) is an
occasional ingredient: use it in at most one concept and only when a scene with people/places truly carries the
idea or the user asks for it. Most concepts must be pure 2D motion graphics. Pitch genuinely different concepts for the user's idea: different metaphors, structures, tones and
visual worlds — never variations of one idea. Short-form rules: hook in the first 1.5 s (max 6 words), one idea
per beat, end with a clear payoff/CTA. The video is built ON TOP of the voice-over, so the script comes first.
"voiceover" is the script ready to paste in ElevenLabs v3:
- One tone tag first line only: [confident], [warm] or [playful].
- Storytelling, one short paragraph per scene, each flowing from the previous; natural spoken Spanish, irregular
  rhythm, never "Martes, diez de la mañana." openings or three punchy fragments in a row.
- Paragraph 1 = cold hook without the brand name; the brand appears in paragraph 2.
- Between scenes exactly "[long pause] [long pause]" on its own line; inside a paragraph only commas/periods.
- Numbers and times written in letters. Only true claims about the product.
- ~2.3 words per second of video. Last sentence = the CTA.
- What is said mirrors the text that will appear on screen.
Answer ONLY with JSON: {"concepts":[{"title","hook","direction","beats":[{"at":"0-1.5s","what":"…"}],"voiceover","prompt"}]}.
"direction" = art direction in 1-2 sentences (concept, palette, type, motion, camera). "prompt" = the complete brief
for the builder agent (in Spanish, 80-200 words): beats tied to the script's paragraphs, art direction, what to show
of the product. Beats' "at" follow the script timing.
All text in Spanish.`;

/** Asks Claude (no tools, one shot) for N different ways to make a video. */
@Injectable()
export class ConceptsService {
  async pitch(dto: ConceptsRequestDto, brand: BrandContext): Promise<{ concepts: ConceptDto[]; usage: AgentRunUsage | null }> {
    const kit = [
      `Brand/project: ${brand.name}`,
      brand.notes && `About the product: ${brand.notes}`,
      brand.palettes.length ? `Brand palettes: ${JSON.stringify(brand.palettes)}` : "",
      ...brand.assets.map((a) => `Asset (${a.kind}) "${a.name}": ${a.description || "no description"}`),
    ].filter(Boolean);
    const prompt = [
      ...(dto.angle !== undefined
        ? [
            `MANDATORY ANGLE for this concept: ${ANGLES[dto.angle % ANGLES.length]}.`,
            "Title, hook, structure, visuals and script must all come from this angle; other writers cover the other angles, so do not fall back to the obvious take.",
          ]
        : []),
      `Idea: ${dto.idea.trim()}`,
      `Format: ${dto.format ?? VideoFormat.Vertical}`,
      dto.steer?.trim() && `Steer this round: ${dto.steer.trim()}`,
      dto.avoid?.length && `Already pitched (bring different ones): ${dto.avoid.join(" | ")}`,
      ...kit,
      dto.references?.length && `The user attached ${dto.references.length} reference image(s): ${dto.references.map((_, i) => `ref-${i + 1}${extname(dto.references![i]!)}`).join(", ")} in the current folder. Read each one first and let them shape the concepts.`,
      dto.angle !== undefined
        ? "Give exactly 1 concept."
        : `Give exactly ${dto.count} concept(s), each with a different angle among: ${ANGLES.slice(0, dto.count).join(" | ")}.`,
    ]
      .filter(Boolean)
      .join("\n");
    // Pitches should feel quick: Sonnet with low effort unless the user asks to think more.
    const model = dto.model ?? AgentModel.Sonnet;
    const effort = dto.effort ?? AgentEffort.Low;
    const { text: out, usage } = await this.run(prompt, model, effort, dto.references ?? []);
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    try {
      const concepts = (JSON.parse(json) as { concepts: ConceptDto[] }).concepts;
      return { concepts: concepts.slice(0, dto.angle !== undefined ? 1 : dto.count), usage: usage && usageFrom(usage, "pitch", model, effort) };
    } catch {
      throw new BadGatewayException("the agent did not return valid concepts; try again");
    }
  }

  private run(prompt: string, model: AgentModel, effort: AgentEffort, references: string[]): Promise<{ text: string; usage: Parameters<typeof usageFrom>[0] | null }> {
    // Empty folder: no repo CLAUDE.md or tools leak into the pitch.
    const cwd = mkdtempSync(join(tmpdir(), "motionily-pitch-"));
    // Reference images go next to it so Claude can Read (see) them; nothing else is allowed.
    references.forEach((ref, i) => copyFileSync(join(MEDIA_DIR, basename(ref)), join(cwd, `ref-${i + 1}${extname(ref)}`)));
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.env.CLAUDE_BIN ?? "claude",
        // Own lean system prompt: Claude Code's default one is ~20k tokens of coding instructions.
        ["-p", prompt, "--system-prompt", SYSTEM, "--tools", references.length ? "Read" : "", "--strict-mcp-config", "--allowedTools", references.length ? "Read" : "", "--output-format", "json", "--model", model, "--effort", effort],
        { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env },
      );
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), CONCEPT_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new BadGatewayException(`claude failed: ${err.trim().slice(0, 300) || `exit ${code}`}`));
        try {
          const r = JSON.parse(out) as Parameters<typeof usageFrom>[0] & { result: string };
          resolve({ text: r.result, usage: r });
        } catch {
          resolve({ text: out, usage: null });
        }
      });
    });
  }
}
