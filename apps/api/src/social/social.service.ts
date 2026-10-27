import { BadGatewayException, BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { randomBytes } from "node:crypto";
import { Model, Types } from "mongoose";
import { SOCIAL_LABEL, SOCIAL_PLATFORMS, SocialPlatform, type PostLink, type PostMetrics, type PostPerformance, type SocialAccount } from "./types";
import { Post, PostStatus, type PostDocument } from "../posts/post.schema";
import { Project } from "../projects/project.schema";
import { User } from "../users/user.schema";
import { seal, unseal, type Sealed } from "../voice/secrets";
import {
  igMe,
  igMetrics,
  igRefresh,
  igVideos,
  SocialError,
  tiktokAuthorizeUrl,
  tiktokExchange,
  tiktokMe,
  tiktokMetrics,
  tiktokRefresh,
  tiktokVideos,
  youtubeAuthorizeUrl,
  youtubeExchange,
  youtubeMe,
  youtubeMetrics,
  youtubeRefresh,
  youtubeVideos,
  type GoogleApp,
  type PublishedVideo,
  type TikTokApp,
  type Tokens,
} from "./platforms";

const DAY = 86_400_000;
/** Posts keep being measured this long after they go out (views settle within weeks). */
const TRACK_DAYS = 90;
/** A published video belongs to a post when it went out this close to when the post was marked posted. */
const MATCH_WINDOW = 2 * DAY;
/** Within this, a lone candidate is the post even if its caption was edited on the app (one with no word in common is another video). */
const LONE_MATCH = 12 * 60 * 60 * 1000;
const LONE_OVERLAP = 0.1;
/** Share of caption words in common from which two captions are the same post. */
const CAPTION_MATCH = 0.3;
/** Instagram long-lived tokens are refreshed when older than this (they last 60 days). */
const IG_REFRESH_AFTER = 7 * DAY;
/** Refresh OAuth tokens this long before they expire. */
const EXPIRY_MARGIN = 60_000;
/** An OAuth login started in Settings has this long to come back. */
const STATE_TTL = 15 * 60_000;

type InstagramAuth = { token: string; refreshedAt: string };
type TikTokAuth = TikTokApp & Partial<Tokens>;
type YouTubeAuth = GoogleApp & Partial<Tokens> & { uploads?: string | null };
type Auth = { instagram?: InstagramAuth; tiktok?: TikTokAuth; youtube?: YouTubeAuth };
type AccountState = { handle: string | null; connected: boolean; error: string | null };

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
function captionOverlap(a: string, b: string) {
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}

/** The published video that is this post: close in time, and the same caption unless it is the only one. */
export function matchVideo(when: Date, caption: string, videos: PublishedVideo[], taken: Set<string>): PublishedVideo | null {
  const near = videos
    .filter((v) => !taken.has(v.id) && v.publishedAt && Math.abs(Date.parse(v.publishedAt) - when.getTime()) <= MATCH_WINDOW)
    .map((v) => ({ v, sim: captionOverlap(caption, v.caption), dt: Math.abs(Date.parse(v.publishedAt!) - when.getTime()) }))
    .sort((a, b) => b.sim - a.sim || a.dt - b.dt);
  const best = near[0];
  if (!best) return null;
  if (best.sim >= CAPTION_MATCH) return best.v;
  const related = !words(caption).size || !words(best.v.caption).size || best.sim >= LONE_OVERLAP;
  return near.length === 1 && best.dt <= LONE_MATCH && related ? best.v : null;
}

/** The platform's id for a pasted link (Instagram's comes from its permalink, looked up on the account). */
export function idFromUrl(platform: SocialPlatform, url: string): string | null {
  const u = url.trim();
  if (platform === SocialPlatform.TikTok) return /\/video\/(\d+)/.exec(u)?.[1] ?? (/^\d{8,}$/.test(u) ? u : null);
  if (platform === SocialPlatform.YouTube) return /(?:shorts\/|[?&]v=|youtu\.be\/)([\w-]{11})/.exec(u)?.[1] ?? (/^[\w-]{11}$/.test(u) ? u : null);
  return /instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/([\w-]+)/.exec(u)?.[1] ?? null;
}

/**
 * The user's Instagram, TikTok and YouTube accounts (their own developer apps; tokens encrypted at
 * rest) and the numbers of every video they posted from the calendar: each post is matched to its
 * published copy, then measured every few hours for TRACK_DAYS.
 */
@Injectable()
export class SocialService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Social");
  private readonly pending = new Map<string, { userId: string; platform: SocialPlatform; expires: number }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(Project.name) private readonly projects: Model<Project>,
  ) {}

  onModuleInit() {
    const hours = Number(process.env.SOCIAL_SYNC_HOURS ?? 6);
    if (!(hours > 0)) return;
    this.timer = setInterval(() => void this.syncAll(), hours * 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ── accounts ──

  async accounts(userId: Types.ObjectId): Promise<SocialAccount[]> {
    const u = await this.users.findById(userId, { socialAccounts: 1 }).lean();
    const states = (u?.socialAccounts ?? {}) as Record<string, AccountState>;
    return SOCIAL_PLATFORMS.map((platform) => ({ platform, connected: !!states[platform]?.connected, handle: states[platform]?.handle ?? null, error: states[platform]?.error ?? null }));
  }

  async connectInstagram(userId: Types.ObjectId, token: string) {
    const t = token.trim();
    const me = await this.guard(() => igMe(t));
    await this.store(userId, SocialPlatform.Instagram, { token: t, refreshedAt: new Date().toISOString() } satisfies InstagramAuth, { handle: me.handle, connected: true, error: null });
    return this.accounts(userId);
  }

  /** Saves the TikTok app and returns where to log in; the user pastes back the URL TikTok sends them to. */
  async startTikTok(userId: Types.ObjectId, app: TikTokApp) {
    await this.store(userId, SocialPlatform.TikTok, app satisfies TikTokAuth, { handle: null, connected: false, error: null });
    return { authorizeUrl: tiktokAuthorizeUrl(app, this.newState(userId, SocialPlatform.TikTok)) };
  }

  async finishTikTok(userId: Types.ObjectId, returned: string) {
    let q: URLSearchParams;
    try {
      q = new URL(returned.trim()).searchParams;
    } catch {
      throw new BadRequestException("paste the whole address TikTok sent you to, starting with https://");
    }
    if (q.get("error")) throw new BadRequestException(`TikTok: ${q.get("error_description") ?? q.get("error")}`);
    const code = q.get("code");
    if (!code) throw new BadRequestException("that address has no ?code=: paste the one TikTok redirects to after you allow access");
    this.takeState(q.get("state"), userId, SocialPlatform.TikTok);
    const auth = (await this.auth(userId)).tiktok;
    if (!auth) throw new BadRequestException("start the TikTok connection again from Settings");
    const tokens = await this.guard(() => tiktokExchange(auth, code));
    const me = await this.guard(() => tiktokMe(tokens.accessToken));
    await this.store(userId, SocialPlatform.TikTok, { ...auth, ...tokens } satisfies TikTokAuth, { handle: me.handle, connected: true, error: null });
    return this.accounts(userId);
  }

  async startYouTube(userId: Types.ObjectId, app: GoogleApp) {
    await this.store(userId, SocialPlatform.YouTube, app satisfies YouTubeAuth, { handle: null, connected: false, error: null });
    return { authorizeUrl: youtubeAuthorizeUrl(app, this.newState(userId, SocialPlatform.YouTube)) };
  }

  /** Google's redirect back to the API (no Motionily session there: the state says whose it is). */
  async finishYouTube(code: string, state: string) {
    const entry = this.takeState(state, null, SocialPlatform.YouTube);
    const userId = new Types.ObjectId(entry.userId);
    const auth = (await this.auth(userId)).youtube;
    if (!auth) throw new BadRequestException("start the YouTube connection again from Settings");
    const tokens = await this.guard(() => youtubeExchange(auth, code));
    const me = await this.guard(() => youtubeMe(tokens.accessToken));
    await this.store(userId, SocialPlatform.YouTube, { ...auth, ...tokens, refreshToken: tokens.refreshToken ?? auth.refreshToken ?? null, uploads: me.uploads } satisfies YouTubeAuth, {
      handle: me.handle,
      connected: true,
      error: null,
    });
    return me.handle;
  }

  async disconnect(userId: Types.ObjectId, platform: SocialPlatform) {
    await this.users.updateOne({ _id: userId }, { $unset: { [`socialAuth.${platform}`]: 1, [`socialAccounts.${platform}`]: 1 } });
    return this.accounts(userId);
  }

  // ── posts ──

  /** Link a post to its published copy by the URL the user pasted, then measure it. */
  async link(userId: Types.ObjectId, postId: string, platform: SocialPlatform, url: string) {
    const post = await this.post(userId, postId);
    if (!(post.platforms as string[]).includes(platform)) throw new BadRequestException(`this post does not go to ${SOCIAL_LABEL[platform]}`);
    let id = idFromUrl(platform, url);
    if (!id) throw new BadRequestException(`that is not a ${SOCIAL_LABEL[platform]} video link`);
    const auth = await this.auth(userId);
    const token = await this.token(userId, platform, auth);
    if (platform === SocialPlatform.Instagram) {
      const found = (await this.guard(() => igVideos(token))).find((v) => v.url && idFromUrl(platform, v.url) === id);
      if (!found) throw new BadRequestException("that reel is not among the latest 50 of the connected Instagram account");
      id = found.id;
    }
    setLink(post, { platform, id, url: url.trim(), publishedAt: null });
    post.status = PostStatus.Posted;
    post.postedAt ??= new Date();
    await post.save();
    await this.syncPosts(userId, [post]);
    return this.post(userId, postId);
  }

  async unlink(userId: Types.ObjectId, postId: string, platform: SocialPlatform) {
    const post = await this.post(userId, postId);
    post.links = (post.links ?? []).filter((l) => l.platform !== platform);
    post.metrics = (post.metrics ?? []).filter((m) => m.platform !== platform);
    post.markModified("links");
    post.markModified("metrics");
    await post.save();
    return post;
  }

  /** Refresh the numbers of one post, or of everything posted in the last TRACK_DAYS. */
  async sync(userId: Types.ObjectId, postId?: string) {
    const posts = postId
      ? [await this.post(userId, postId)]
      : await this.posts.find({ ownerId: userId, status: PostStatus.Posted, postedAt: { $gte: new Date(Date.now() - TRACK_DAYS * DAY) } });
    return this.syncPosts(userId, posts);
  }

  /** The background pass over every user with a connected account. */
  async syncAll() {
    const users = await this.users.find({ socialAccounts: { $exists: true } }, { _id: 1 }).lean();
    for (const u of users) {
      try {
        await this.sync(u._id as Types.ObjectId);
      } catch (e) {
        this.log.warn(`sync for ${String(u._id)}: ${(e as Error).message}`);
      }
    }
  }

  /** Every posted video of one project with its numbers. */
  async performance(userId: Types.ObjectId, projectId: string): Promise<PostPerformance[]> {
    if (!Types.ObjectId.isValid(projectId)) throw new NotFoundException("project not found");
    const project = await this.projects.findOne({ _id: projectId, ownerId: userId }, { sceneRevision: 1 }).lean();
    if (!project) throw new NotFoundException("project not found");
    const posts = await this.posts.find({ ownerId: userId, projectId: new Types.ObjectId(projectId), status: PostStatus.Posted }).sort({ postedAt: -1 }).lean();
    return posts.map((p) => ({
      postId: String(p._id),
      postedAt: p.postedAt?.toISOString() ?? null,
      outdated: !!p.video && project.sceneRevision > p.video.sceneRevision,
      links: p.links ?? [],
      metrics: p.metrics ?? [],
    }));
  }

  private async syncPosts(userId: Types.ObjectId, posts: PostDocument[]) {
    const errors: string[] = [];
    const auth = await this.auth(userId);
    const states = await this.states(userId);
    for (const platform of SOCIAL_PLATFORMS) {
      const mine = posts.filter((p) => p.status === PostStatus.Posted && (p.platforms as string[]).includes(platform));
      if (!mine.length || !states[platform]?.connected) continue;
      try {
        const token = await this.token(userId, platform, auth);
        let videos: PublishedVideo[] | null = null;
        const taken = new Set((await this.posts.find({ ownerId: userId, "links.platform": platform }, { links: 1 }).lean()).flatMap((p) => (p.links ?? []).filter((l) => l.platform === platform).map((l) => l.id)));
        for (const post of mine) {
          let link = (post.links ?? []).find((l) => l.platform === platform);
          if (!link) {
            videos ??= await this.videos(platform, token, auth);
            const caption = post.copy.find((c) => (c.platform as string) === platform)?.caption ?? "";
            const v = matchVideo(post.postedAt ?? post.scheduledAt, caption, videos, taken);
            if (!v) continue;
            link = { platform, id: v.id, url: v.url, publishedAt: v.publishedAt };
            taken.add(v.id);
            setLink(post, link);
          }
          setMetrics(post, await this.metrics(platform, token, link));
          await post.save();
        }
        if (states[platform]?.error) await this.setState(userId, platform, { ...states[platform]!, error: null });
      } catch (e) {
        if (!(e instanceof SocialError)) throw e;
        errors.push(e.message);
        if (e.expired) await this.setState(userId, platform, { ...states[platform]!, connected: false, error: `${SOCIAL_LABEL[platform]} needs connecting again: ${e.message}` });
      }
    }
    return { synced: posts.length, errors };
  }

  private videos(platform: SocialPlatform, token: string, auth: Auth) {
    if (platform === SocialPlatform.Instagram) return igVideos(token);
    if (platform === SocialPlatform.TikTok) return tiktokVideos(token);
    return auth.youtube?.uploads ? youtubeVideos(token, auth.youtube.uploads) : Promise.resolve([]);
  }

  private metrics(platform: SocialPlatform, token: string, link: PostLink): Promise<PostMetrics> {
    if (platform === SocialPlatform.Instagram) return igMetrics(token, link.id);
    if (platform === SocialPlatform.TikTok) return tiktokMetrics(token, link.id);
    return youtubeMetrics(token, link.id, link.publishedAt);
  }

  /** A valid access token for the platform, refreshed (and stored) when it is about to lapse. */
  private async token(userId: Types.ObjectId, platform: SocialPlatform, auth: Auth): Promise<string> {
    const now = Date.now();
    if (platform === SocialPlatform.Instagram) {
      const a = auth.instagram;
      if (!a) throw new BadRequestException("connect Instagram first in Settings");
      if (now - Date.parse(a.refreshedAt) > IG_REFRESH_AFTER) {
        a.token = await igRefresh(a.token);
        a.refreshedAt = new Date().toISOString();
        await this.storeAuth(userId, platform, a);
      }
      return a.token;
    }
    const a = platform === SocialPlatform.TikTok ? auth.tiktok : auth.youtube;
    if (!a?.accessToken) throw new BadRequestException(`connect ${SOCIAL_LABEL[platform]} first in Settings`);
    if (a.expiresAt && Date.parse(a.expiresAt) - EXPIRY_MARGIN > now) return a.accessToken;
    if (!a.refreshToken) throw new SocialError(`${platform}: the login expired`, 401, true);
    const fresh = platform === SocialPlatform.TikTok ? await tiktokRefresh(a as TikTokApp, a.refreshToken) : await youtubeRefresh(a as GoogleApp, a.refreshToken);
    Object.assign(a, fresh, { refreshToken: fresh.refreshToken ?? a.refreshToken });
    await this.storeAuth(userId, platform, a);
    return a.accessToken!;
  }

  // ── storage ──

  private async post(userId: Types.ObjectId, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("post not found");
    const post = await this.posts.findOne({ _id: id, ownerId: userId });
    if (!post) throw new NotFoundException("post not found");
    return post;
  }

  private async auth(userId: Types.ObjectId): Promise<Auth> {
    const u = await this.users.findById(userId).select("+socialAuth").lean();
    const out: Auth = {};
    for (const [platform, sealed] of Object.entries((u?.socialAuth ?? {}) as Record<string, Sealed>)) {
      try {
        (out as Record<string, unknown>)[platform] = JSON.parse(unseal(sealed));
      } catch {
        // Sealed with another key: as if not connected.
      }
    }
    return out;
  }

  private async states(userId: Types.ObjectId) {
    const u = await this.users.findById(userId, { socialAccounts: 1 }).lean();
    return (u?.socialAccounts ?? {}) as Record<string, AccountState>;
  }

  private storeAuth(userId: Types.ObjectId, platform: SocialPlatform, auth: object) {
    return this.users.updateOne({ _id: userId }, { $set: { [`socialAuth.${platform}`]: seal(JSON.stringify(auth)) } });
  }

  private setState(userId: Types.ObjectId, platform: SocialPlatform, state: AccountState) {
    return this.users.updateOne({ _id: userId }, { $set: { [`socialAccounts.${platform}`]: state } });
  }

  private async store(userId: Types.ObjectId, platform: SocialPlatform, auth: object, state: AccountState) {
    await this.storeAuth(userId, platform, auth);
    await this.setState(userId, platform, state);
  }

  private newState(userId: Types.ObjectId, platform: SocialPlatform) {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    const state = randomBytes(16).toString("hex");
    this.pending.set(state, { userId: String(userId), platform, expires: now + STATE_TTL });
    return state;
  }

  private takeState(state: string | null, userId: Types.ObjectId | null, platform: SocialPlatform) {
    const entry = state ? this.pending.get(state) : undefined;
    if (!entry || entry.expires < Date.now() || entry.platform !== platform || (userId && entry.userId !== String(userId)))
      throw new BadRequestException(`that ${SOCIAL_LABEL[platform]} login is not the one started here (or it is older than 15 minutes): start again from Settings`);
    this.pending.delete(state!);
    return entry;
  }

  /** Platform refusals as the user's to fix (400, never 401: that would sign them out of Motionily). */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof SocialError)) throw e;
      if (e.status === HttpStatus.TOO_MANY_REQUESTS) throw new HttpException(e.message, HttpStatus.TOO_MANY_REQUESTS);
      if (e.status >= 500) throw new BadGatewayException(e.message);
      throw new BadRequestException(e.message);
    }
  }
}

function setLink(post: PostDocument, link: PostLink) {
  post.links = [...(post.links ?? []).filter((l) => l.platform !== link.platform), link];
  post.markModified("links");
}

function setMetrics(post: PostDocument, m: PostMetrics) {
  post.metrics = [...(post.metrics ?? []).filter((x) => x.platform !== m.platform), m];
  post.markModified("metrics");
}
