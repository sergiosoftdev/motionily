import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema } from "mongoose";
import type { Sealed } from "../voice/secrets";

export enum AuthProvider {
  /** Simulated Google login for development. */
  Mock = "mock",
  Google = "google",
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true }) email: string;
  @Prop({ required: true }) name: string;
  @Prop() avatarUrl?: string;
  @Prop({ required: true, enum: AuthProvider, type: String }) provider: AuthProvider;
  /** Google `sub`, once real OAuth is wired. */
  @Prop({ sparse: true, unique: true }) googleId?: string;
  /** The user's own ElevenLabs API key, encrypted; never sent back (only `elevenLabsHint`, its last characters). */
  @Prop({ type: MongooseSchema.Types.Mixed, select: false }) elevenLabsKey?: Sealed | null;
  @Prop() elevenLabsHint?: string;
  /** The user's keys for asset sources (Pexels, Pixabay, Brave, OpenAI), encrypted; never sent back. */
  @Prop({ type: MongooseSchema.Types.Mixed, select: false }) providerKeys?: Record<string, Sealed>;
  /** Last characters of each connected key, shown in Settings. */
  @Prop({ type: MongooseSchema.Types.Mixed }) providerHints?: Record<string, string>;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
