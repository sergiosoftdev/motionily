import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";
import { BrickSlot } from "../bricks/brick.enums";

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
export enum VideoFormat {
  Vertical = "vertical_9_16",
  Horizontal = "horizontal_16_9",
  Square = "square_1_1",
  Portrait = "portrait_4_5",
}

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
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) build: Build;
  @Prop({ required: true, enum: VideoFormat, type: String, default: VideoFormat.Vertical }) format: VideoFormat;
  /** Engine scene (see crates/scene). Null until the agent builds the first cut. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) scene: Record<string, unknown> | null;
  /** Voice-over / music uploaded by the user. Served from /media/:file. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) audio: { file: string; name: string; mime: string } | null;
  /** Bumped on every scene save; clients send it back to avoid overwriting newer edits. */
  @Prop({ default: 0 }) sceneRevision: number;
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
