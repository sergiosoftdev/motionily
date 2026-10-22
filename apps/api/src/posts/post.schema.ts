import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";

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
}

export type PostDocument = HydratedDocument<Post>;
export const PostSchema = SchemaFactory.createForClass(Post);
