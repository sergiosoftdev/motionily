import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { BricksService } from "../bricks/bricks.service";
import { BrickSlot, SLOT_CARDINALITY, SlotCardinality } from "../bricks/brick.enums";
import { Build, Feedback, FeedbackKind, Project, ProjectDocument, type AgentRunUsage, type FootageClip, type PostCopyDraft, type SunoPrompt } from "./project.schema";
import type { AssetCredit } from "../assets/asset-types";
import { removeMedia } from "../media";
import type { CreateFeedbackDto, CreateProjectDto, SaveSceneDto, SetSlotDto, UpdateProjectDto } from "./projects.dto";

type KitPayload = { defaults?: Partial<Build> };

const NEUTRAL_BASE = "motion_style/apple";

@Injectable()
export class ProjectsService {
  constructor(
    @InjectModel(Project.name) private readonly projects: Model<Project>,
    @InjectModel(Feedback.name) private readonly feedback: Model<Feedback>,
    private readonly bricks: BricksService,
  ) {}

  list(ownerId: Types.ObjectId, brandId?: Types.ObjectId) {
    return this.projects
      .find(brandId ? { ownerId, brandId, hidden: { $ne: true } } : { ownerId, hidden: { $ne: true } }, { name: 1, build: 1, format: 1, brandId: 1, updatedAt: 1, createdAt: 1 })
      .sort({ updatedAt: -1 })
      .lean();
  }

  setLiveRun(id: string, liveRun: { status: string; startedAt: string; pids: number[] } | null) {
    return this.projects.updateOne({ _id: id }, { $set: { liveRun } });
  }

  setBuildPlan(id: string, buildPlan: { plan: Record<string, unknown>; done: string[] } | null) {
    return this.projects.updateOne({ _id: id }, { $set: { buildPlan } });
  }

  markBeatDone(id: string, group: string) {
    return this.projects.updateOne({ _id: id }, { $addToSet: { "buildPlan.done": group } });
  }

  /** The scene as it is saved now (the build may have changed it since the run started). */
  /** What the sound pass reads: the cut and the brief that sets its tone. */
  async soundInputOf(id: string) {
    const p = await this.projects.findById(id, { scene: 1, brief: 1 }).lean();
    return { scene: (p?.scene ?? null) as Record<string, unknown> | null, brief: p?.brief ?? "" };
  }

  async buildPlanOf(id: string) {
    return (await this.projects.findById(id, { buildPlan: 1 }).lean())?.buildPlan ?? null;
  }

  trackPid(id: string, pid: number, add: boolean) {
    return this.projects.updateOne({ _id: id }, add ? { $addToSet: { "liveRun.pids": pid } } : { $pull: { "liveRun.pids": pid } });
  }

  liveRuns() {
    // Running, or interrupted with agents that may not have died yet.
    return this.projects.find({ $or: [{ "liveRun.status": "running" }, { "liveRun.pids.0": { $exists: true } }] }, { liveRun: 1, agentRuns: 1 }).lean();
  }

  async liveRunOf(id: string) {
    return (await this.projects.findById(id, { liveRun: 1 }).lean())?.liveRun ?? null;
  }

  /** Append one agent run's usage (keeps the last 50). */
  async logAgentRun(id: string, usage: AgentRunUsage) {
    await this.projects.updateOne({ _id: id }, { $push: { agentRuns: { $each: [usage], $slice: -50 } } });
  }

  /** Remember an imported photo's attribution (once per image). */
  async addImageCredit(id: string, credit: AssetCredit) {
    await this.projects.updateOne({ _id: id, "imageCredits.pageUrl": { $ne: credit.pageUrl } }, { $push: { imageCredits: credit } });
  }

  async get(ownerId: Types.ObjectId, id: string): Promise<ProjectDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("project not found");
    const project = await this.projects.findOne({ _id: id, ownerId });
    if (!project) throw new NotFoundException("project not found");
    return project;
  }

  /** Opening the box: the motion style fills every slot with its default bricks. */
  async create(ownerId: Types.ObjectId, dto: CreateProjectDto) {
    // A neutral base the agent replaces with its own art direction.
    const kit = await this.bricks.get(dto.motionStyle ?? NEUTRAL_BASE);
    if (kit.slot !== BrickSlot.MotionStyle) {
      throw new BadRequestException(`'${dto.motionStyle}' is not a motion style`);
    }
    const build = this.buildFromKit(kit.key, kit.payload as KitPayload);
    await this.assertBricksExist(build);
    const brandId = dto.brandId ? new Types.ObjectId(dto.brandId) : undefined;
    return this.projects.create({ ownerId, name: dto.name, brief: dto.brief ?? "", wantsScript: dto.wantsScript ?? false, voiceScript: dto.voiceScript ?? "", references: dto.references ?? [], build, format: dto.format, brandId });
  }

  /** The user's hidden workshop video, where the agent edits prefabs with a live preview. */
  async workshop(ownerId: Types.ObjectId, brandId: Types.ObjectId) {
    const found = await this.projects.findOne({ ownerId, hidden: true });
    if (found) return found;
    const kit = await this.bricks.get("motion_style/cartoon");
    const build = this.buildFromKit(kit.key, kit.payload as KitPayload);
    return this.projects.create({ ownerId, brandId, name: "Prefab workshop", hidden: true, build, brief: "Prefab workshop" });
  }

  /** Give videos without a project to `brandId`. */
  async adoptOrphans(ownerId: Types.ObjectId, brandId: Types.ObjectId) {
    await this.projects.updateMany({ ownerId, brandId: { $exists: false } }, { $set: { brandId } });
  }

  async countByBrand(ownerId: Types.ObjectId) {
    const rows = await this.projects.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { ownerId, hidden: { $ne: true } } }, { $group: { _id: "$brandId", n: { $sum: 1 } } }]);
    return new Map(rows.filter((r) => r._id).map((r) => [r._id.toString(), r.n]));
  }

  countInBrand(ownerId: Types.ObjectId, brandId: string) {
    return Types.ObjectId.isValid(brandId) ? this.projects.countDocuments({ ownerId, brandId: new Types.ObjectId(brandId) }) : Promise.resolve(0);
  }

  async update(ownerId: Types.ObjectId, id: string, dto: UpdateProjectDto) {
    const project = await this.get(ownerId, id);
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.brief !== undefined) project.brief = dto.brief;
    if (dto.wantsScript !== undefined) project.wantsScript = dto.wantsScript;
    if (dto.voiceScript !== undefined) project.voiceScript = dto.voiceScript;
    if (dto.references !== undefined) project.references = dto.references;
    if (dto.format !== undefined) project.format = dto.format;
    if (dto.postCopy !== undefined) project.postCopy = dto.postCopy;
    return project.save();
  }

  async remove(ownerId: Types.ObjectId, id: string) {
    const project = await this.get(ownerId, id);
    await Promise.all([project.deleteOne(), this.feedback.deleteMany({ projectId: project._id })]);
    // Imported material lives on in the user's library; only this video's own uploads go.
    const files = [
      ...(project.footage ?? []).flatMap((c) => [c.file, c.poster ?? ""]),
      project.music?.file ?? "",
    ].filter(Boolean);
    await Promise.all(files.map((f) => removeMedia(f.replace(/^\/media\//, ""))));
  }

  /** Snap a brick (or several) into one slot. Records the choice as feedback for the agent. */
  async setSlot(ownerId: Types.ObjectId, id: string, slot: BrickSlot, dto: SetSlotDto, recordFeedback = true) {
    if (!Object.values(BrickSlot).includes(slot)) throw new BadRequestException(`unknown slot '${slot}'`);
    const project = await this.get(ownerId, id);
    const value = normalizeSlotValue(slot, dto.value);

    for (const key of [value].flat()) {
      if (key === null) continue;
      const brick = await this.bricks.get(key, project._id);
      if (brick.slot !== slot) throw new BadRequestException(`'${key}' is a ${brick.slot} brick, not ${slot}`);
    }

    let build: Build = { ...project.build, [slot]: value };
    if (slot === BrickSlot.MotionStyle && dto.applyKitDefaults) {
      const kit = await this.bricks.get(value as string);
      build = this.buildFromKit(kit.key, kit.payload as KitPayload);
    }
    project.build = build;
    project.markModified("build");
    await project.save();
    if (recordFeedback) await this.feedback.create({ projectId: project._id, kind: FeedbackKind.BrickChosen, slot, value });
    return project;
  }

  /** Brick keys in the build that do not fit the chosen motion style. Shown dimmed, never blocked. */
  async misfits(project: ProjectDocument): Promise<string[]> {
    const style = project.build[BrickSlot.MotionStyle];
    const keys = Object.entries(project.build)
      .filter(([slot]) => slot !== BrickSlot.MotionStyle)
      .flatMap(([, v]) => [v].flat())
      .filter((k): k is string => typeof k === "string");
    const out: string[] = [];
    for (const key of keys) {
      const brick = await this.bricks.get(key, project._id).catch(() => null);
      if (brick && brick.fits.length > 0 && !brick.fits.includes(style)) out.push(key);
    }
    return out;
  }

  async saveScene(ownerId: Types.ObjectId, id: string, dto: SaveSceneDto) {
    const project = await this.get(ownerId, id);
    const updated = await this.projects.findOneAndUpdate(
      { _id: project._id, sceneRevision: dto.baseRevision },
      { $set: { scene: dto.scene }, $inc: { sceneRevision: 1 } },
      { returnDocument: "after" },
    );
    if (!updated) {
      throw new ConflictException(`scene changed since revision ${dto.baseRevision}; now ${project.sceneRevision}`);
    }
    return { sceneRevision: updated.sceneRevision };
  }

  async addFeedback(ownerId: Types.ObjectId, id: string, dto: CreateFeedbackDto) {
    const project = await this.get(ownerId, id);
    if (dto.kind === FeedbackKind.Comment && !dto.text?.trim()) {
      throw new BadRequestException("a comment needs text");
    }
    return this.feedback.create({ projectId: project._id, kind: dto.kind, text: dto.text?.trim(), at: dto.at, layerId: dto.layerId });
  }

  listFeedback(projectId: Types.ObjectId) {
    return this.feedback.find({ projectId }).sort({ createdAt: 1 }).lean();
  }

  /** Agent side: everything the user said since the last call, marked as read. */
  async consumeFeedback(ownerId: Types.ObjectId, id: string) {
    const project = await this.get(ownerId, id);
    const pending = await this.feedback.find({ projectId: project._id, consumedAt: null }).sort({ createdAt: 1 }).lean();
    if (pending.length) {
      await this.feedback.updateMany({ _id: { $in: pending.map((f) => f._id) } }, { $set: { consumedAt: new Date() } });
    }
    return pending;
  }

  async setAudio(ownerId: Types.ObjectId, id: string, audio: Project["audio"]) {
    const project = await this.get(ownerId, id);
    const previous = project.audio?.file;
    project.audio = audio;
    project.markModified("audio");
    await project.save();
    return { project, previous };
  }

  /** Replaces the video's music file; returns the one it replaces, to delete. */
  async setMusic(ownerId: Types.ObjectId, id: string, music: Project["music"]) {
    const project = await this.get(ownerId, id);
    const previous = project.music?.file;
    project.music = music;
    project.markModified("music");
    await project.save();
    return { project, previous };
  }

  async setSunoPrompt(id: string, suno: SunoPrompt) {
    await this.projects.updateOne({ _id: id }, { $set: { sunoPrompt: suno } });
  }

  /** Keep a copy draft per platform: new drafts replace the platforms they cover. */
  async savePostCopy(id: string, copy: PostCopyDraft[]) {
    const project = await this.projects.findById(id, { postCopy: 1 }).lean();
    const kept = (project?.postCopy ?? []).filter((c) => !copy.some((n) => n.platform === c.platform));
    await this.projects.updateOne({ _id: id }, { $set: { postCopy: [...kept, ...copy] } });
  }

  /** Adds an uploaded clip as c1, c2… */
  async addFootage(ownerId: Types.ObjectId, id: string, clip: Omit<FootageClip, "id">) {
    const project = await this.get(ownerId, id);
    const taken = (project.footage ?? []).map((c) => Number(c.id.slice(1)) || 0);
    project.footage = [...(project.footage ?? []), { id: `c${Math.max(0, ...taken) + 1}`, ...clip }];
    project.markModified("footage");
    await project.save();
    return project;
  }

  async setFootageWords(ownerId: Types.ObjectId, id: string, clipId: string, words: FootageClip["words"]) {
    const project = await this.get(ownerId, id);
    const clip = (project.footage ?? []).find((c) => c.id === clipId);
    if (!clip) throw new NotFoundException(`no clip '${clipId}' in this video`);
    clip.words = words;
    project.markModified("footage");
    await project.save();
    return project;
  }

  /** Drops a clip; returns it so its files can be deleted. */
  async removeFootage(ownerId: Types.ObjectId, id: string, clipId: string) {
    const project = await this.get(ownerId, id);
    const clip = (project.footage ?? []).find((c) => c.id === clipId);
    if (!clip) throw new NotFoundException(`no clip '${clipId}' in this video`);
    project.footage = project.footage.filter((c) => c.id !== clipId);
    project.markModified("footage");
    await project.save();
    return { project, clip };
  }

  private buildFromKit(kitKey: string, payload: KitPayload): Build {
    const d = payload.defaults ?? {};
    const required = [
      BrickSlot.Palette,
      BrickSlot.Composition,
      BrickSlot.Typography,
      BrickSlot.RenderStyle,
      BrickSlot.Captions,
    ] as const;
    for (const slot of required) {
      if (typeof d[slot] !== "string") throw new BadRequestException(`motion style '${kitKey}' has no default ${slot}`);
    }
    return {
      [BrickSlot.MotionStyle]: kitKey,
      [BrickSlot.Palette]: d[BrickSlot.Palette]!,
      [BrickSlot.Composition]: d[BrickSlot.Composition]!,
      [BrickSlot.Typography]: d[BrickSlot.Typography]!,
      [BrickSlot.RenderStyle]: d[BrickSlot.RenderStyle]!,
      [BrickSlot.Captions]: d[BrickSlot.Captions]!,
      [BrickSlot.Scenario]: d[BrickSlot.Scenario] ?? null,
      [BrickSlot.Character]: d[BrickSlot.Character] ?? [],
      [BrickSlot.Animation]: d[BrickSlot.Animation] ?? [],
      [BrickSlot.Transition]: d[BrickSlot.Transition] ?? [],
    };
  }

  private async assertBricksExist(build: Build) {
    for (const key of Object.values(build).flat()) {
      if (typeof key === "string") await this.bricks.get(key);
    }
  }
}

function normalizeSlotValue(slot: BrickSlot, value: unknown): string | string[] | null {
  switch (SLOT_CARDINALITY[slot]) {
    case SlotCardinality.One:
      if (typeof value !== "string") throw new BadRequestException(`${slot} needs exactly one brick key`);
      return value;
    case SlotCardinality.Optional:
      if (value !== null && typeof value !== "string") throw new BadRequestException(`${slot} takes one brick key or null`);
      return value;
    case SlotCardinality.Many:
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new BadRequestException(`${slot} takes a list of brick keys`);
      }
      return [...new Set(value as string[])];
  }
}
