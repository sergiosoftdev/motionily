import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";

export enum PrefabKind {
  /** A thing: camilla, desk, phone… */
  Object = "object",
  /** A rigged procedural character. */
  Character = "character",
  /** A whole space: clinic with boxes, office floor… */
  Space = "space",
}

/**
 * A procedural 3D tree (see crates/scene/src/node3d.rs) saved by the agent once
 * and reused by name in every project of the same user. Clones keep `parent`.
 */
@Schema({ timestamps: true })
export class Prefab {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId: Types.ObjectId;
  @Prop({ required: true }) name: string;
  @Prop({ default: "" }) description: string;
  @Prop({ required: true, enum: PrefabKind, type: String }) kind: PrefabKind;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) node: Record<string, unknown>;
  /** Prefab this one was cloned from. */
  @Prop() parent?: string;
  @Prop({ default: 1 }) version: number;
}

export type PrefabDocument = HydratedDocument<Prefab>;
export const PrefabSchema = SchemaFactory.createForClass(Prefab);
PrefabSchema.index({ ownerId: 1, name: 1 }, { unique: true });
