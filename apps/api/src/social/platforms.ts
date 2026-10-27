/**
 * Instagram, TikTok and YouTube over plain HTTP with the user's own developer apps and tokens: the
 * listing of their posted videos and each video's numbers. Hosts come from env so tests point them
 * at a fake server.
 */
import { SocialPlatform, type PostMetrics } from "./types";

const IG_VERSION = "v25.0";
const igUrl = () => process.env.SOCIAL_INSTAGRAM_API_URL ?? "https://graph.instagram.com";
const ttUrl = () => process.env.SOCIAL_TIKTOK_API_URL ?? "https://open.tiktokapis.com";
const ytUrl = () => process.env.SOCIAL_YOUTUBE_API_URL ?? "https://www.googleapis.com";
const ytaUrl = () => process.env.SOCIAL_YOUTUBE_ANALYTICS_URL ?? "https://youtubeanalytics.googleapis.com";
const googleTokenUrl = () => process.env.SOCIAL_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";

export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_SCOPES = "user.info.basic,video.list";
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const YOUTUBE_SCOPES = "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly";

/** A platform's own refusal (status from it), worded for the user. */
export class SocialError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The token is no longer valid: the user has to connect again. */
    readonly expired = false,
  ) {
    super(message);
  }
}

/** A video on the user's account, to match against the posts they marked posted. */
export type PublishedVideo = { id: string; url: string | null; publishedAt: string | null; caption: string; duration: number | null };

/** OAuth tokens as the platforms hand them out. */
export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: string | null };

async function json(platform: SocialPlatform, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new SocialError(`could not reach ${platform}: ${(e as Error).message}`, 502);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // TikTok answers 200 with `error.code` other than "ok".
  const ttError = body.error as { code?: string; message?: string } | undefined;
  if (!res.ok || (platform === SocialPlatform.TikTok && ttError?.code && ttError.code !== "ok")) {
    const err = body.error as { message?: string; code?: number | string; status?: string } | string | undefined;
    const message = typeof err === "string" ? (body.error_description as string | undefined) ?? err : err?.message ?? res.statusText;
    const expired = res.status === 401 || (typeof err === "object" && (err?.code === 190 || err?.code === "access_token_invalid" || err?.status === "UNAUTHENTICATED")) || err === "invalid_grant";
    throw new SocialError(`${platform}: ${message}`, res.ok ? 400 : res.status, expired);
  }
  return body;
}

const n = (v: unknown): number | null => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const emptyMetrics = (platform: SocialPlatform): PostMetrics => ({
  platform,
  fetchedAt: new Date().toISOString(),
  views: null,
  reach: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  avgWatch: null,
  skipRate: null,
  retention: null,
  duration: null,
});

// ── Instagram (Instagram API with Instagram Login: a long-lived token of a professional account) ──

export async function igMe(token: string) {
  const me = await json(SocialPlatform.Instagram, `${igUrl()}/${IG_VERSION}/me?${new URLSearchParams({ fields: "user_id,username", access_token: token })}`);
  return { id: String(me.user_id ?? me.id), handle: String(me.username ?? "") };
}

/** Long-lived tokens last 60 days; refreshing gives another 60. */
export async function igRefresh(token: string) {
  const r = await json(SocialPlatform.Instagram, `${igUrl()}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token })}`);
  return String(r.access_token);
}

/** The account's latest reels. */
export async function igVideos(token: string): Promise<PublishedVideo[]> {
  const r = await json(SocialPlatform.Instagram, `${igUrl()}/${IG_VERSION}/me/media?${new URLSearchParams({ fields: "id,caption,media_product_type,media_type,timestamp,permalink", limit: "50", access_token: token })}`);
  return ((r.data as Record<string, unknown>[] | undefined) ?? [])
    .filter((m) => m.media_product_type === "REELS" || m.media_type === "VIDEO")
    .map((m) => ({ id: String(m.id), url: (m.permalink as string) ?? null, publishedAt: (m.timestamp as string) ?? null, caption: String(m.caption ?? ""), duration: null }));
}

const IG_CORE = ["views", "reach", "likes", "comments", "shares", "saved"];
/** Metrics Meta marks "in development": asked for, but a refusal of them does not lose the rest. */
const IG_EXTRA = ["ig_reels_avg_watch_time", "reels_skip_rate"];

export async function igMetrics(token: string, id: string): Promise<PostMetrics> {
  const ask = (metrics: string[]) => json(SocialPlatform.Instagram, `${igUrl()}/${IG_VERSION}/${id}/insights?${new URLSearchParams({ metric: metrics.join(","), access_token: token })}`);
  let r: Record<string, unknown>;
  try {
    r = await ask([...IG_CORE, ...IG_EXTRA]);
  } catch (e) {
    if (!(e instanceof SocialError) || e.expired) throw e;
    r = await ask(IG_CORE);
  }
  const v: Record<string, number | null> = {};
  for (const m of (r.data as { name: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[] | undefined) ?? [])
    v[m.name] = n(m.values?.[0]?.value ?? m.total_value?.value);
  const avg = v.ig_reels_avg_watch_time ?? null;
  const skip = v.reels_skip_rate ?? null;
  return {
    ...emptyMetrics(SocialPlatform.Instagram),
    views: v.views ?? null,
    reach: v.reach ?? null,
    likes: v.likes ?? null,
    comments: v.comments ?? null,
    shares: v.shares ?? null,
    saves: v.saved ?? null,
    // Milliseconds and a percentage.
    avgWatch: avg === null ? null : avg / 1000,
    skipRate: skip === null ? null : skip / 100,
  };
}

// ── TikTok (Login Kit + Display API: the user's own app, the code pasted back from its redirect) ──

export type TikTokApp = { clientKey: string; clientSecret: string; redirectUri: string };

export function tiktokAuthorizeUrl(app: TikTokApp, state: string) {
  return `${TIKTOK_AUTHORIZE_URL}?${new URLSearchParams({ client_key: app.clientKey, scope: TIKTOK_SCOPES, response_type: "code", redirect_uri: app.redirectUri, state })}`;
}

async function tiktokToken(app: TikTokApp, grant: Record<string, string>): Promise<Tokens> {
  const r = await json(SocialPlatform.TikTok, `${ttUrl()}/v2/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: app.clientKey, client_secret: app.clientSecret, ...grant }),
  });
  if (!r.access_token) throw new SocialError(`tiktok: ${(r.error_description as string) ?? "no token in the answer"}`, 400, grant.grant_type === "refresh_token");
  return { accessToken: String(r.access_token), refreshToken: (r.refresh_token as string) ?? null, expiresAt: new Date(Date.now() + (n(r.expires_in) ?? 0) * 1000).toISOString() };
}

export const tiktokExchange = (app: TikTokApp, code: string) => tiktokToken(app, { code, grant_type: "authorization_code", redirect_uri: app.redirectUri });
export const tiktokRefresh = (app: TikTokApp, refreshToken: string) => tiktokToken(app, { grant_type: "refresh_token", refresh_token: refreshToken });

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });

export async function tiktokMe(token: string) {
  const r = await json(SocialPlatform.TikTok, `${ttUrl()}/v2/user/info/?fields=open_id,display_name`, { headers: auth(token) });
  const user = ((r.data as { user?: Record<string, unknown> } | undefined)?.user ?? {}) as Record<string, unknown>;
  return { id: String(user.open_id ?? ""), handle: String(user.display_name ?? "") };
}

const TT_FIELDS = "id,create_time,title,video_description,duration,share_url,view_count,like_count,comment_count,share_count";
type TikTokVideo = Record<string, unknown>;
const ttVideo = (v: TikTokVideo): PublishedVideo => ({
  id: String(v.id),
  url: (v.share_url as string) ?? null,
  publishedAt: n(v.create_time) === null ? null : new Date(n(v.create_time)! * 1000).toISOString(),
  caption: String(v.video_description ?? v.title ?? ""),
  duration: n(v.duration),
});

/** The latest public videos (20, the most one page holds). */
export async function tiktokVideos(token: string): Promise<PublishedVideo[]> {
  const r = await json(SocialPlatform.TikTok, `${ttUrl()}/v2/video/list/?fields=${TT_FIELDS}`, { method: "POST", headers: auth(token), body: JSON.stringify({ max_count: 20 }) });
  return (((r.data as { videos?: TikTokVideo[] } | undefined)?.videos ?? []) as TikTokVideo[]).map(ttVideo);
}

export async function tiktokMetrics(token: string, id: string): Promise<PostMetrics> {
  const r = await json(SocialPlatform.TikTok, `${ttUrl()}/v2/video/query/?fields=${TT_FIELDS}`, { method: "POST", headers: auth(token), body: JSON.stringify({ filters: { video_ids: [id] } }) });
  const v = ((r.data as { videos?: TikTokVideo[] } | undefined)?.videos ?? [])[0];
  if (!v) throw new SocialError("tiktok: the video is not on the connected account (deleted or private?)", 404);
  return { ...emptyMetrics(SocialPlatform.TikTok), views: n(v.view_count), likes: n(v.like_count), comments: n(v.comment_count), shares: n(v.share_count), duration: n(v.duration) };
}

// ── YouTube (an OAuth client of the user's Google Cloud project; Data API + Analytics API) ──

export type GoogleApp = { clientId: string; clientSecret: string; redirectUri: string };

export function youtubeAuthorizeUrl(app: GoogleApp, state: string) {
  return `${GOOGLE_AUTHORIZE_URL}?${new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  })}`;
}

async function googleToken(app: GoogleApp, grant: Record<string, string>): Promise<Tokens> {
  const r = await json(SocialPlatform.YouTube, googleTokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...grant }),
  });
  return { accessToken: String(r.access_token), refreshToken: (r.refresh_token as string) ?? null, expiresAt: new Date(Date.now() + (n(r.expires_in) ?? 0) * 1000).toISOString() };
}

export const youtubeExchange = (app: GoogleApp, code: string) => googleToken(app, { code, grant_type: "authorization_code", redirect_uri: app.redirectUri });
export const youtubeRefresh = (app: GoogleApp, refreshToken: string) => googleToken(app, { grant_type: "refresh_token", refresh_token: refreshToken });

export async function youtubeMe(token: string) {
  const r = await json(SocialPlatform.YouTube, `${ytUrl()}/youtube/v3/channels?part=snippet,contentDetails&mine=true`, { headers: auth(token) });
  const ch = ((r.items as Record<string, unknown>[] | undefined) ?? [])[0];
  if (!ch) throw new SocialError("youtube: this Google account has no YouTube channel", 400);
  const snippet = ch.snippet as { title?: string; customUrl?: string } | undefined;
  const uploads = (ch.contentDetails as { relatedPlaylists?: { uploads?: string } } | undefined)?.relatedPlaylists?.uploads ?? null;
  return { id: String(ch.id), handle: snippet?.customUrl ?? snippet?.title ?? "", uploads };
}

/** "PT1M2S" → 62 */
export function isoSeconds(d: unknown): number | null {
  const m = typeof d === "string" ? /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d) : null;
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}

/** The channel's latest uploads (one page of 50). */
export async function youtubeVideos(token: string, uploads: string): Promise<PublishedVideo[]> {
  const r = await json(SocialPlatform.YouTube, `${ytUrl()}/youtube/v3/playlistItems?${new URLSearchParams({ part: "snippet,contentDetails", playlistId: uploads, maxResults: "50" })}`, { headers: auth(token) });
  return ((r.items as Record<string, unknown>[] | undefined) ?? []).map((it) => {
    const s = (it.snippet ?? {}) as { title?: string; description?: string; publishedAt?: string };
    const c = (it.contentDetails ?? {}) as { videoId?: string; videoPublishedAt?: string };
    const id = String(c.videoId);
    return { id, url: `https://youtube.com/shorts/${id}`, publishedAt: c.videoPublishedAt ?? s.publishedAt ?? null, caption: [s.title, s.description].filter(Boolean).join("\n"), duration: null };
  });
}

const day = (iso: string) => iso.slice(0, 10);

export async function youtubeMetrics(token: string, id: string, publishedAt: string | null): Promise<PostMetrics> {
  const r = await json(SocialPlatform.YouTube, `${ytUrl()}/youtube/v3/videos?${new URLSearchParams({ part: "statistics,contentDetails", id })}`, { headers: auth(token) });
  const v = ((r.items as Record<string, unknown>[] | undefined) ?? [])[0];
  if (!v) throw new SocialError("youtube: the video is not on the connected channel (deleted or private?)", 404);
  const s = (v.statistics ?? {}) as Record<string, unknown>;
  const out: PostMetrics = {
    ...emptyMetrics(SocialPlatform.YouTube),
    views: n(s.viewCount),
    likes: n(s.likeCount),
    comments: n(s.commentCount),
    duration: isoSeconds((v.contentDetails as { duration?: string } | undefined)?.duration),
  };
  // Analytics lag a day or two behind; until then the counts above are all there is.
  const range = { ids: "channel==MINE", startDate: day(publishedAt ?? new Date(Date.now() - 90 * 86_400_000).toISOString()), endDate: day(new Date().toISOString()), filters: `video==${id}` };
  const report = (q: Record<string, string>) => json(SocialPlatform.YouTube, `${ytaUrl()}/v2/reports?${new URLSearchParams({ ...range, ...q })}`, { headers: auth(token) });
  const rows = (x: Record<string, unknown>) => (x.rows as number[][] | undefined) ?? [];
  const totals = rows(await report({ metrics: "averageViewDuration,shares" }))[0];
  if (totals) [out.avgWatch, out.shares] = [n(totals[0]), n(totals[1])];
  const curve = rows(await report({ metrics: "audienceWatchRatio", dimensions: "elapsedVideoTimeRatio" }));
  if (curve.length) out.retention = curve.sort((a, b) => a[0]! - b[0]!).map((row) => Number(row[1]));
  return out;
}
