import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";
import { BrickSlot } from "../bricks/brick.enums";
import type { AssetCredit } from "../assets/asset-types";
import type { Direction } from "../direction/direction.controller";

/** Which brick sits in each slot. Single slots hold a key, multi slots a list. */
export type Build = {
  [BrickSlot.MotionStyle]: string;
  [BrickSlot.Palette]: string;
  [BrickSlot.Composition]: string;
  [BrickSlot.Typography]: string;
  [BrickSlot.RenderStyle]: string;
  [BrickSlot.Captions]: string;
  [BrickSlot.Scenario]: string | null;
  [BrickSlot.Character]: string[];
  [BrickSlot.Animation]: string[];
  [BrickSlot.Transition]: string[];
};

/** Frame shape of the video. Size is 1080 px on the short side. */
/** Tokens and cost of one agent run, from claude's final stream-json result. */
export type AgentRunUsage = {
  at: string;
  /** "generate" for a full build, "edit" for an instruction on top. */
  kind: string;
  model: string | null;
  effort: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  durationMs: number;
};

export enum VideoFormat {
  Vertical = "vertical_9_16",
  Horizontal = "horizontal_16_9",
  Square = "square_1_1",
  Portrait = "portrait_4_5",
}

/** The prompt Claude wrote for the video's background music in Suno, kept until the user asks for another. */
export type SunoPrompt = { title: string; style: string; structure: string; dropAt: number | null; notes: string; createdAt: string };

/** Caption and hashtags drafted for one platform, kept until the user asks for another draft. */
export type PostCopyDraft = { platform: string; caption: string; hashtags: string[] };

/** A clip uploaded to be edited. `id` is short (c1, c2…) so agents can name it in a cut. */
export type FootageClip = {
  id: string;
  file: string;
  name: string;
  mime: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  /** Contact sheet (/media path), 4×3 frames. */
  poster: string | null;
  /** Language spoken (ISO 639-1), for the transcription. */
  language: string;
  /** Transcript in file seconds; null until the editor transcribed the clip. */
  words: { text: string; start: number; end: number }[] | null;
};

@Schema({ timestamps: true })
export class Project {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId: Types.ObjectId;
  /** The project (brand kit) this video belongs to. */
  @Prop({ type: Types.ObjectId, ref: "Brand", index: true }) brandId?: Types.ObjectId;
  @Prop({ required: true, trim: true }) name: string;
  /** Internal videos (the prefab workshop) never show in lists. */
  @Prop({ default: false }) hidden: boolean;
  /** What the video is about, in the user's words. The agent's main input. */
  @Prop({ default: "" }) brief: string;
  /** The user wants a voice-over script (ElevenLabs format) once the video is built. */
  @Prop({ default: false }) wantsScript: boolean;
  /** Voice-over script the agent wrote for the final cut. */
  @Prop({ default: "" }) voiceScript: string;
  /** Reference images the user attached to the idea (media paths). */
  @Prop({ type: [String], default: [] }) references: string[];
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) build: Build;
  @Prop({ required: true, enum: VideoFormat, type: String, default: VideoFormat.Vertical }) format: VideoFormat;
  /** Engine scene (see crates/scene). Null until the agent builds the first cut. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) scene: Record<string, unknown> | null;
  /** Voice-over / music uploaded by the user. Served from /media/:file. */
  /** The voice-over. Generated with ElevenLabs it carries each word's timing (`words`), so captions need no transcription. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) audio: { file: string; name: string; mime: string; words?: { text: string; start: number; end: number }[]; voice?: { voiceId: string; model: string } } | null;
  /** Background music the user uploaded (the scene's `music` places it). Served from /media/:file. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) music: { file: string; name: string; mime: string; trimIn?: number; summary?: string; duration?: number } | null;
  /** Claude's Suno prompt for this video's music. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) sunoPrompt: SunoPrompt | null;
  /** Claude's latest caption and hashtags per platform (the Schedule dialog starts from them). */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) postCopy: PostCopyDraft[];
  /** The user's own clips to edit (usually someone talking to camera); `words` once the editor transcribed them. */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) footage: FootageClip[];
  /** Bumped on every scene save; clients send it back to avoid overwriting newer edits. */
  @Prop({ default: 0 }) sceneRevision: number;
  /** What each agent run cost (newest last), to see where tokens go. */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) agentRuns: AgentRunUsage[];
  /** Material the agent imported (photos, footage, logos, icon sets, generated images), with what their licenses ask to credit. */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) imageCredits: AssetCredit[];
  /** The look the agent declared for this video (set_direction): genre, concept, techniques. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) direction: Direction | null;
  /** The two creative constraints this video drew (kept across runs; redrawn on request). */
  @Prop({ type: [String], default: [] }) constraints: string[];
  /** The user starred it: agents study favorites as the user's taste (examples find). */
  @Prop({ default: false }) favorite: boolean;
  @Prop({ type: Date, default: null }) favoritedAt: Date | null;
  /**
   * The agent team working on this video right now, persisted so an API restart can neither hide a
   * running team (and let a second one start) nor leave its claude processes orphaned.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) liveRun: { status: string; startedAt: string; pids: number[] } | null;
  /** The team's plan and the beat groups already built, so an interrupted run can continue where it stopped. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) buildPlan: { plan: Record<string, unknown>; done: string[] } | null;
}

export type ProjectDocument = HydratedDocument<Project>;
export const ProjectSchema = SchemaFactory.createForClass(Project);

export enum FeedbackKind {
  Comment = "comment",
  BrickChosen = "brick_chosen",
}

/** What the user tells the agent: comments pinned to a time, or bricks they picked. */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Feedback {
  @Prop({ type: Types.ObjectId, ref: "Project", required: true, index: true }) projectId: Types.ObjectId;
  @Prop({ required: true, enum: FeedbackKind, type: String }) kind: FeedbackKind;
  @Prop() text?: string;
  /** Seconds into the video, for comments. */
  @Prop() at?: number;
  /** Scene layer the comment is about (clicked in the preview). */
  @Prop() layerId?: string;
  @Prop({ enum: BrickSlot, type: String }) slot?: BrickSlot;
  @Prop({ type: MongooseSchema.Types.Mixed }) value?: string | string[] | null;
  /** Set when the agent has read it. */
  @Prop({ type: Date, default: null }) consumedAt: Date | null;
}

export type FeedbackDocument = HydratedDocument<Feedback>;
export const FeedbackSchema = SchemaFactory.createForClass(Feedback);
