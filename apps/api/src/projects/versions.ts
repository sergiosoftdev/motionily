import { Body, Controller, Get, Injectable, NotFoundException, Param, Post } from "@nestjs/common";
import { InjectModel, Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { Model, Schema as MongooseSchema, Types } from "mongoose";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { Project } from "./project.schema";

/** Automatic versions are kept at most this often (seconds), so autosave does not fill the history. */
const AUTO_EVERY_S = 60;
/** Versions kept per video (oldest automatic ones go first; named ones count too). */
const MAX_VERSIONS = 60;

/** A past scene of a video: every minute of editing, and every snapshot the user or agent names. */
@Schema({ timestamps: true, collection: "scene_versions" })
export class SceneVersion {
  @Prop({ type: Types.ObjectId, required: true, index: true }) projectId: Types.ObjectId;
  @Prop({ required: true }) revision: number;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) scene: Record<string, unknown>;
  /** Named by the user or an agent ("before the color pass"); empty for automatic ones. */
  @Prop({ default: "" }) label: string;
  @Prop({ default: 0 }) layers: number;
  @Prop({ default: 0 }) duration: number;
}
export const SceneVersionSchema = SchemaFactory.createForClass(SceneVersion);

class SnapshotDto {
  @IsOptional() @IsString() @MaxLength(120) label?: string;
}

const summary = (scene: Record<string, unknown> | null | undefined) => ({
  layers: Array.isArray(scene?.layers) ? (scene!.layers as unknown[]).length : 0,
  duration: typeof scene?.duration === "number" ? scene.duration : 0,
});

@Injectable()
export class VersionsService {
  constructor(
    @InjectModel(SceneVersion.name) private readonly versions: Model<SceneVersion>,
    @InjectModel(Project.name) private readonly projects: Model<Project>,
  ) {}

  /** Before a save replaces the scene: keep it, unless an automatic version was kept less than a minute ago. */
  async keepBeforeSave(projectId: Types.ObjectId, scene: Record<string, unknown> | null, revision: number) {
    if (!scene) return;
    const last = await this.versions.findOne({ projectId, label: "" }, { createdAt: 1 }).sort({ createdAt: -1 }).lean<{ createdAt?: Date }>();
    if (last?.createdAt && Date.now() - new Date(last.createdAt).getTime() < AUTO_EVERY_S * 1000) return;
    await this.save(projectId, scene, revision, "");
  }

  private async save(projectId: Types.ObjectId, scene: Record<string, unknown>, revision: number, label: string) {
    const created = await this.versions.create({ projectId, scene, revision, label, ...summary(scene) });
    const all = await this.versions.find({ projectId }, { _id: 1, label: 1 }).sort({ createdAt: -1 }).lean();
    // Over the cap: automatic versions go first, oldest first.
    const extra = all.length - MAX_VERSIONS;
    if (extra > 0) {
      const drop = [...all].reverse().filter((v) => !v.label).slice(0, extra).map((v) => v._id);
      if (drop.length) await this.versions.deleteMany({ _id: { $in: drop } });
    }
    return created;
  }

  private async project(ownerId: Types.ObjectId, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("project not found");
    const p = await this.projects.findOne({ _id: id, ownerId }, { scene: 1, sceneRevision: 1 }).lean();
    if (!p) throw new NotFoundException("project not found");
    return p;
  }

  async list(ownerId: Types.ObjectId, id: string) {
    const p = await this.project(ownerId, id);
    const rows = await this.versions.find({ projectId: p._id }, { scene: 0 }).sort({ createdAt: -1 }).lean<{ _id: Types.ObjectId; revision: number; label: string; layers: number; duration: number; createdAt: Date }[]>();
    return rows.map((v) => ({ id: String(v._id), revision: v.revision, label: v.label, layers: v.layers, duration: v.duration, at: v.createdAt }));
  }

  async snapshot(ownerId: Types.ObjectId, id: string, label?: string) {
    const p = await this.project(ownerId, id);
    if (!p.scene) throw new NotFoundException("this video has no scene yet");
    const v = await this.save(p._id, p.scene as Record<string, unknown>, p.sceneRevision ?? 0, label?.trim() || "Snapshot");
    return { id: String(v._id), revision: v.revision, label: v.label };
  }

  /** The scene of a version (the editor loads it; its next save makes it the current one). */
  async scene(ownerId: Types.ObjectId, id: string, versionId: string) {
    const p = await this.project(ownerId, id);
    if (!Types.ObjectId.isValid(versionId)) throw new NotFoundException("version not found");
    const v = await this.versions.findOne({ _id: versionId, projectId: p._id }).lean();
    if (!v) throw new NotFoundException("version not found");
    return { id: versionId, revision: v.revision, label: v.label, scene: v.scene };
  }
}

/** A video's version history: automatic every minute of editing, plus named snapshots. */
@Controller("projects")
export class VersionsController {
  constructor(private readonly versions: VersionsService) {}

  @Get(":id/versions")
  list(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.versions.list(user.id, id);
  }

  @Post(":id/versions")
  snapshot(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: SnapshotDto) {
    return this.versions.snapshot(user.id, id, dto.label);
  }

  @Get(":id/versions/:versionId")
  scene(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("versionId") versionId: string) {
    return this.versions.scene(user.id, id, versionId);
  }
}
