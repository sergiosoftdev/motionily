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
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
