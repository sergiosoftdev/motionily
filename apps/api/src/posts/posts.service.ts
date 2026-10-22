import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Project } from "../projects/project.schema";
import { ProjectsService } from "../projects/projects.service";
import { Platform, Post, PostStatus, type PostCopy, type PostDocument, type PostVideo } from "./post.schema";
import type { CreatePostDto, ListPostsQuery, PostCopyDto, UpdatePostDto } from "./posts.dto";
import { DUE_ONLY } from "./posts.dto";

/** A post as the web shows it: with its video's name and whether the video changed after the file was rendered. */
export type PostView = {
  id: string;
  projectId: string;
  projectName: string | null;
  format: string | null;
  scheduledAt: string;
  platforms: Platform[];
  copy: PostCopy[];
  video: { url: string; mime: string; size: number; outdated: boolean } | null;
  status: PostStatus;
  postedAt: string | null;
  due: boolean;
};

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(Project.name) private readonly projectModel: Model<Project>,
    private readonly projects: ProjectsService,
  ) {}

  async create(ownerId: Types.ObjectId, dto: CreatePostDto) {
    await this.projects.get(ownerId, dto.projectId);
    const post = await this.posts.create({
      ownerId,
      projectId: new Types.ObjectId(dto.projectId),
      scheduledAt: new Date(dto.scheduledAt),
      platforms: dto.platforms,
      copy: copyFor(dto.platforms, dto.copy),
    });
    return (await this.views([post]))[0]!;
  }

  async list(ownerId: Types.ObjectId, q: ListPostsQuery) {
    const scheduledAt: Record<string, Date> = {};
    if (q.from) scheduledAt.$gte = new Date(q.from);
    if (q.to) scheduledAt.$lt = new Date(q.to);
    if (q.due === DUE_ONLY) scheduledAt.$lte = new Date();
    const filter = {
      ownerId,
      ...(q.projectId ? { projectId: new Types.ObjectId(q.projectId) } : {}),
      ...(Object.keys(scheduledAt).length ? { scheduledAt } : {}),
      ...(q.due === DUE_ONLY ? { status: PostStatus.Scheduled } : {}),
    };
    return this.views(await this.posts.find(filter).sort({ scheduledAt: 1 }).limit(500));
  }

  async get(ownerId: Types.ObjectId, id: string): Promise<PostDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("post not found");
    const post = await this.posts.findOne({ _id: id, ownerId });
    if (!post) throw new NotFoundException("post not found");
    return post;
  }

  async view(post: PostDocument) {
    return (await this.views([post]))[0]!;
  }

  async update(ownerId: Types.ObjectId, id: string, dto: UpdatePostDto) {
    const post = await this.get(ownerId, id);
    if (dto.scheduledAt) post.scheduledAt = new Date(dto.scheduledAt);
    if (dto.platforms) post.platforms = dto.platforms;
    if (dto.copy || dto.platforms) post.copy = copyFor(post.platforms, dto.copy ?? post.copy);
    if (dto.status && dto.status !== post.status) {
      post.status = dto.status;
      post.postedAt = dto.status === PostStatus.Posted ? new Date() : null;
    }
    await post.save();
    return this.view(post);
  }

  /** Attach the rendered file; returns the file it replaces, to delete. */
  async setVideo(ownerId: Types.ObjectId, id: string, video: PostVideo) {
    const post = await this.get(ownerId, id);
    const previous = post.video?.file;
    post.video = video;
    post.markModified("video");
    await post.save();
    return { post: await this.view(post), previous };
  }

  /** Deletes the post; returns its file, to delete. */
  async remove(ownerId: Types.ObjectId, id: string) {
    const post = await this.get(ownerId, id);
    await post.deleteOne();
    return post.video?.file;
  }

  private async views(posts: PostDocument[]): Promise<PostView[]> {
    const ids = [...new Set(posts.map((p) => String(p.projectId)))].map((id) => new Types.ObjectId(id));
    const projects = await this.projectModel.find({ _id: { $in: ids } }, { name: 1, format: 1, sceneRevision: 1 }).lean();
    const byId = new Map(projects.map((p) => [String(p._id), p]));
    const now = Date.now();
    return posts.map((p) => {
      const project = byId.get(String(p.projectId));
      return {
        id: String(p._id),
        projectId: String(p.projectId),
        projectName: project?.name ?? null,
        format: project?.format ?? null,
        scheduledAt: p.scheduledAt.toISOString(),
        platforms: p.platforms,
        copy: p.copy,
        video: p.video
          ? { url: `/media/${p.video.file}`, mime: p.video.mime, size: p.video.size, outdated: !!project && project.sceneRevision > p.video.sceneRevision }
          : null,
        status: p.status,
        postedAt: p.postedAt?.toISOString() ?? null,
        due: p.status === PostStatus.Scheduled && p.scheduledAt.getTime() <= now,
      };
    });
  }
}

/** One text per platform the post goes to, in the platforms' order; a platform without text gets an empty one. */
function copyFor(platforms: Platform[], copy: (PostCopy | PostCopyDto)[]): PostCopy[] {
  for (const c of copy) if (!platforms.includes(c.platform)) throw new BadRequestException(`there is text for ${c.platform}, which the post doesn't go to`);
  return platforms.map((platform) => {
    const c = copy.find((x) => x.platform === platform);
    return { platform, caption: c?.caption ?? "", hashtags: c?.hashtags ?? [] };
  });
}
