import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";

/**
 * A synthesized sound effect in the user's library (recipe + rendered WAV), reused across
 * every video like prefabs. The recipe format lives in apps/web/src/audio/synth.ts.
 */
@Schema({ timestamps: true })
export class Sound {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId: Types.ObjectId;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) category: string;
  @Prop({ default: "" }) description: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) recipe: Record<string, unknown>;
  /** Rendered WAV in the media folder. */
  @Prop({ required: true }) file: string;
  @Prop({ required: true }) duration: number;
}

export type SoundDocument = HydratedDocument<Sound>;
export const SoundSchema = SchemaFactory.createForClass(Sound);
SoundSchema.index({ ownerId: 1, name: 1 }, { unique: true });
