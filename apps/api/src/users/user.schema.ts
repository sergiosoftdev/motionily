import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

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
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
