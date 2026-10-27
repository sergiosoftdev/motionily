import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";
import { VideoFormat } from "../projects/project.schema";

/** How the source video did when it was posted: the best numbers per platform (mirrors SeriesPerformance in @motionily/protocol). */
export type SeriesPerformance = { platform: string; views: number | null; avgWatch: number | null; skipRate: number | null; duration: number | null };

/**
 * A series template: the structure of a video that worked (beats and their timing, rhythm,
 * captions, type, palette, sound, voice pace), measured from its scene by the client
 * (`seriesBlueprint` in @motionily/protocol), to make more episodes with other content.
 */
@Schema({ timestamps: true })
export class Series {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Brand", index: true }) brandId?: Types.ObjectId;
  @Prop({ required: true, trim: true }) name: string;
  /** Why it worked / what to keep, in the user's words. */
  @Prop({ default: "" }) note: string;
  @Prop({ type: Types.ObjectId, ref: "Project", default: null }) sourceProjectId: Types.ObjectId | null;
  @Prop({ type: String, default: null }) sourceName: string | null;
  @Prop({ required: true, enum: VideoFormat, type: String }) format: VideoFormat;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) blueprint: Record<string, unknown>;
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) performance: SeriesPerformance[];
}

export type SeriesDocument = HydratedDocument<Series>;
export const SeriesSchema = SchemaFactory.createForClass(Series);
