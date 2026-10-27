import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Post, PostStatus } from "../posts/post.schema";
import { Project } from "../projects/project.schema";
import { SOCIAL_LABEL, type SocialPlatform } from "../social/types";
import { Series, type SeriesDocument, type SeriesPerformance } from "./series.schema";

/** A series as clients see it (mirrors Series in @motionily/protocol). */
export type SeriesView = {
  id: string;
  name: string;
  note: string;
  sourceProjectId: string | null;
  sourceName: string | null;
  format: string;
  blueprint: Record<string, unknown>;
  performance: SeriesPerformance[];
  episodes: number;
  createdAt: string;
};

@Injectable()
export class SeriesService {
  constructor(
    @InjectModel(Series.name) private readonly series: Model<Series>,
    @InjectModel(Project.name) private readonly projects: Model<Project>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
  ) {}

  async list(ownerId: Types.ObjectId, brandId?: string): Promise<SeriesView[]> {
    const filter = brandId && Types.ObjectId.isValid(brandId) ? { ownerId, brandId: new Types.ObjectId(brandId) } : { ownerId };
    return this.views(await this.series.find(filter).sort({ createdAt: -1 }));
  }

  async get(ownerId: Types.ObjectId, id: string): Promise<SeriesDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("series not found");
    const s = await this.series.findOne({ _id: id, ownerId });
    if (!s) throw new NotFoundException("series not found");
    return s;
  }

  async view(s: SeriesDocument) {
    return (await this.views([s]))[0]!;
  }

  /** Save `projectId`'s structure as a series, with how it did if it was posted. */
  async create(ownerId: Types.ObjectId, projectId: string, body: { name: string; note?: string; blueprint: Record<string, unknown> }) {
    const project = await this.project(ownerId, projectId);
    if (!Array.isArray(body.blueprint.beats)) throw new BadRequestException("the blueprint has no beats: measure it with seriesBlueprint(scene)");
    const s = await this.series.create({
      ownerId,
      brandId: project.brandId,
      name: body.name.trim(),
      note: body.note?.trim() ?? "",
      sourceProjectId: project._id,
      sourceName: project.name,
      format: project.format,
      blueprint: body.blueprint,
      performance: await this.performance(ownerId, project._id),
    });
    return this.view(s);
  }

  async update(ownerId: Types.ObjectId, id: string, patch: { name?: string; note?: string }) {
    const s = await this.get(ownerId, id);
    if (patch.name !== undefined) s.name = patch.name.trim();
    if (patch.note !== undefined) s.note = patch.note.trim();
    await s.save();
    return this.view(s);
  }

  /** The series goes; its episodes stay as ordinary videos. */
  async remove(ownerId: Types.ObjectId, id: string) {
    const s = await this.get(ownerId, id);
    await this.projects.updateMany({ ownerId, seriesId: s._id }, { $set: { seriesId: null } });
    await s.deleteOne();
  }

  /** The series a video is an episode of (null when it is not one). */
  async ofProject(ownerId: Types.ObjectId, projectId: string) {
    const project = await this.project(ownerId, projectId);
    if (!project.seriesId) return null;
    const s = await this.series.findOne({ _id: project.seriesId, ownerId });
    return s ? this.view(s) : null;
  }

  /** The series a new video joins: theirs, and its format unless another is asked for. */
  async forNewEpisode(ownerId: Types.ObjectId, seriesId: string) {
    const s = await this.get(ownerId, seriesId).catch(() => {
      throw new BadRequestException("that series does not exist");
    });
    return { seriesId: s._id, format: s.format };
  }

  private async project(ownerId: Types.ObjectId, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("project not found");
    const p = await this.projects.findOne({ _id: id, ownerId });
    if (!p) throw new NotFoundException("project not found");
    return p;
  }

  /** The best numbers per platform of the project's posted copies. */
  private async performance(ownerId: Types.ObjectId, projectId: Types.ObjectId): Promise<SeriesPerformance[]> {
    const posts = await this.posts.find({ ownerId, projectId, status: PostStatus.Posted }, { metrics: 1 }).lean();
    const best = new Map<string, SeriesPerformance>();
    for (const m of posts.flatMap((p) => p.metrics ?? [])) {
      const label = SOCIAL_LABEL[m.platform as SocialPlatform] ?? m.platform;
      const prev = best.get(label);
      if (!prev || (m.views ?? 0) > (prev.views ?? 0)) best.set(label, { platform: label, views: m.views, avgWatch: m.avgWatch, skipRate: m.skipRate, duration: m.duration });
    }
    return [...best.values()];
  }

  private async views(list: SeriesDocument[]): Promise<SeriesView[]> {
    const ids = list.map((s) => s._id);
    const counts = ids.length ? await this.projects.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { seriesId: { $in: ids } } }, { $group: { _id: "$seriesId", n: { $sum: 1 } } }]) : [];
    const n = new Map(counts.map((c) => [String(c._id), c.n]));
    return list.map((s) => ({
      id: String(s._id),
      name: s.name,
      note: s.note,
      sourceProjectId: s.sourceProjectId ? String(s.sourceProjectId) : null,
      sourceName: s.sourceName,
      format: s.format,
      blueprint: s.blueprint,
      performance: s.performance ?? [],
      episodes: n.get(String(s._id)) ?? 0,
      createdAt: (s as unknown as { createdAt: Date }).createdAt.toISOString(),
    }));
  }
}
