import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";
import type { VideoFeatures } from "../social/features";
import type { MetricsCheckpoint, PostLink, PostMetrics } from "../social/types";

/** Where a video gets posted. */
export enum Platform {
  Instagram = "instagram",
  TikTok = "tiktok",
  YouTube = "youtube",
}

/** A scheduled post is due once its time passes; the user marks it posted after publishing it. */
export enum PostStatus {
  Scheduled = "scheduled",
  Posted = "posted",
}

/** The text that goes with the video on one platform. Hashtags are stored without "#". */
export type PostCopy = { platform: Platform; caption: string; hashtags: string[] };

/** The rendered video file, and the scene revision it was rendered from (to spot later edits). */
export type PostVideo = { file: string; mime: string; size: number; sceneRevision: number };

/** A video scheduled for social media: when, where, with which text, and the file to upload. */
@Schema({ timestamps: true })
export class Post {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Project", required: true, index: true }) projectId: Types.ObjectId;
  @Prop({ type: Date, required: true, index: true }) scheduledAt: Date;
  @Prop({ type: [String], enum: Platform, required: true }) platforms: Platform[];
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) copy: PostCopy[];
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) video: PostVideo | null;
  @Prop({ required: true, enum: PostStatus, type: String, default: PostStatus.Scheduled }) status: PostStatus;
  @Prop({ type: Date, default: null }) postedAt: Date | null;
  /** Where it was published, per platform: matched on the connected accounts once posted, or pasted by the user. */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) links: PostLink[];
  /** The latest numbers per platform (social/social.service.ts keeps them fresh). */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) metrics: PostMetrics[];
  /** The numbers per platform at 1, 3 and 7 days old, kept as they pass. */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) checkpoints: MetricsCheckpoint[];
  /** What the video was like when it was first measured (hook, length, pace…), to learn what works. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) features: VideoFeatures | null;
}

export type PostDocument = HydratedDocument<Post>;
export const PostSchema = SchemaFactory.createForClass(Post);
