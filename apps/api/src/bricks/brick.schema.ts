import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";
import { BrickSlot, BrickVisibility, EngineSupport, ParamType } from "./brick.enums";

@Schema({ _id: false })
export class ParamSpec {
  @Prop({ required: true }) key: string;
  @Prop({ required: true }) label: string;
  @Prop({ required: true, enum: ParamType, type: String }) type: ParamType;
  @Prop({ type: MongooseSchema.Types.Mixed }) default?: unknown;
  @Prop() min?: number;
  @Prop() max?: number;
  @Prop({ type: [String] }) options?: string[];
}
const ParamSpecSchema = SchemaFactory.createForClass(ParamSpec);

/**
 * A Lego brick. `key` is "slot/name" and stays stable across versions so the
 * agent and saved projects can reference it by name.
 */
@Schema({ timestamps: true })
export class Brick {
  @Prop({ required: true }) key: string;
  @Prop({ required: true, enum: BrickSlot, type: String, index: true }) slot: BrickSlot;
  @Prop({ required: true }) name: string;
  @Prop({ default: "" }) description: string;
  @Prop({ type: [String], default: [] }) tags: string[];
  /** Motion style keys this brick snaps onto. Empty means it fits every style. */
  @Prop({ type: [String], default: [] }) fits: string[];
  /** Slot-specific data: colors, keyframes, default bricks of a kit, glTF url… */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) payload: Record<string, unknown>;
  @Prop({ type: [ParamSpecSchema], default: [] }) params: ParamSpec[];
  @Prop({ required: true, enum: EngineSupport, type: String, default: EngineSupport.Planned }) engine: EngineSupport;
  @Prop({ required: true, enum: BrickVisibility, type: String, default: BrickVisibility.Official })
  visibility: BrickVisibility;
  @Prop({ type: Types.ObjectId, ref: "User" }) ownerId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Project" }) projectId?: Types.ObjectId;
  @Prop({ default: 1 }) version: number;
}

export type BrickDocument = HydratedDocument<Brick>;
export const BrickSchema = SchemaFactory.createForClass(Brick);
// Official keys are global; private keys only need to be unique within their project.
BrickSchema.index({ key: 1, projectId: 1 }, { unique: true });
