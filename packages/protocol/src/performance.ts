/**
 * How a posted video did: the numbers each platform gives back for one post, and where its audience
 * leaves, mapped onto the scene so the editor and the agent point at the same moments.
 *
 * What each platform reports (official APIs): Instagram views, reach, likes, comments, shares, saves,
 * average watch time and the share of views skipped in the first 3 s; TikTok views, likes, comments
 * and shares; YouTube views, likes, comments, average view duration and the retention curve (100
 * points along the video).
 */

export const SocialPlatform = { Instagram: "instagram", TikTok: "tiktok", YouTube: "youtube" } as const;
export type SocialPlatform = (typeof SocialPlatform)[keyof typeof SocialPlatform];
export const SOCIAL_PLATFORMS: SocialPlatform[] = [SocialPlatform.Instagram, SocialPlatform.TikTok, SocialPlatform.YouTube];
export const SOCIAL_LABEL: Record<SocialPlatform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube Shorts" };

/** A post's published copy on one platform. */
export type PostLink = { platform: SocialPlatform; id: string; url: string | null; publishedAt: string | null };

/** One platform's numbers for one post. Null where the platform does not report it (or not yet). */
export type PostMetrics = {
  platform: SocialPlatform;
  fetchedAt: string;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  /** Seconds the average view lasted. */
  avgWatch: number | null;
  /** Share (0..1) of views that left within the first 3 s (Instagram). */
  skipRate: number | null;
  /** Share of viewers still watching at each 1% of the video, 100 values (YouTube); can pass 1 with rewatches. */
  retention: number[] | null;
  /** Length of the published video in seconds, when the platform reports it. */
  duration: number | null;
};

/** A connected account as Settings shows it. */
export type SocialAccount = { platform: SocialPlatform; connected: boolean; handle: string | null; error: string | null };

/** A video on one of the user's connected accounts, and the video made here it is linked to (if any). */
export type PublishedVideo = {
  platform: SocialPlatform;
  id: string;
  url: string | null;
  caption: string;
  publishedAt: string | null;
  thumbnail: string | null;
  linked: { projectId: string; name: string } | null;
};

/** One posted video with its numbers, for the video's own page and its agent. */
export type PostPerformance = {
  postId: string;
  postedAt: string | null;
  /** The video was edited after the posted file was rendered: the numbers are for that earlier cut. */
  outdated: boolean;
  links: PostLink[];
  metrics: PostMetrics[];
};

/** Skips in the first 3 s land here (Instagram counts a skip before 3 s). */
export const SKIP_WINDOW = 3;
/** Drops in the retention curve smaller than this (points of the audience, 0..1) are noise. */
const MIN_DROP = 0.04;
/** Width of the window (share of the video) a drop is measured over. */
const DROP_SPAN = 0.05;

/** A moment the audience leaves: when, how many (share of the audience, 0..1) and what tells it. */
export type AudienceDrop = { t: number; share: number; why: string };

/**
 * Where viewers leave this video, as times on the scene: the steepest falls of the retention curve
 * (YouTube), the average view's end and the 3-second skip (Instagram). `duration` is the scene's.
 */
export function audienceDrops(m: PostMetrics, duration: number, max = 3): AudienceDrop[] {
  const len = m.duration ?? duration;
  const out: AudienceDrop[] = [];
  if (m.retention?.length) {
    const r = m.retention;
    const span = Math.max(1, Math.round(r.length * DROP_SPAN));
    const falls: { i: number; drop: number }[] = [];
    for (let i = 0; i + span < r.length; i++) falls.push({ i, drop: r[i]! - r[i + span]! });
    falls.sort((a, b) => b.drop - a.drop);
    const picked: number[] = [];
    for (const f of falls) {
      if (f.drop < MIN_DROP || picked.length >= max) break;
      if (picked.some((p) => Math.abs(p - f.i) < span * 2)) continue;
      picked.push(f.i);
      out.push({ t: ((f.i + span / 2) / r.length) * len, share: f.drop, why: `retention falls ${pct(r[f.i]!)} → ${pct(r[f.i + span]!)}` });
    }
  }
  if (m.skipRate !== null && m.skipRate > 0) out.push({ t: Math.min(SKIP_WINDOW, len), share: m.skipRate, why: `${pct(m.skipRate)} skipped in the first ${SKIP_WINDOW} s` });
  if (m.avgWatch !== null && len > 0) out.push({ t: Math.min(m.avgWatch, len), share: 0, why: `the average view ends here (${pct(m.avgWatch / len)} of the video)` });
  return out.sort((a, b) => a.t - b.t);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

type SceneLike = { layers?: unknown; duration?: unknown };
type LayerLike = { id?: unknown; type?: unknown; text?: unknown; start?: unknown; end?: unknown; visible?: unknown; vis?: unknown };
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** What is on screen at `t`: the texts shown (they say what the moment is about), then the other layers by id. */
export function onScreenAt(scene: SceneLike, t: number, max = 6): string[] {
  const duration = num(scene.duration, Infinity);
  const alive = (Array.isArray(scene.layers) ? (scene.layers as LayerLike[]) : []).filter(
    (l) => l.visible !== false && l.vis !== 0 && num(l.start) <= t && (l.end == null ? duration : num(l.end)) > t,
  );
  const texts = alive.filter((l) => l.type === "text" && typeof l.text === "string").map((l) => `"${(l.text as string).replace(/\s+/g, " ").slice(0, 60)}"`);
  const others = alive.filter((l) => l.type !== "text").map((l) => String(l.id ?? l.type));
  return [...texts, ...others].slice(0, max);
}

/** "1.2K", "34K", "1.5M": counts as the apps show them. */
export function compactCount(n: number | null): string {
  if (n === null) return "–";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** One published copy of a video made here with its latest numbers: a row of the channel's dashboard. */
export type ChannelVideo = {
  postId: string;
  projectId: string;
  name: string;
  /** A still of the video (`/media/...`), once the editor took one. */
  cover: string | null;
  format: string | null;
  /** The scene's length in seconds (0 when unknown). */
  duration: number;
  platform: SocialPlatform;
  url: string | null;
  publishedAt: string | null;
  /** Null until the platform has been asked (or it gave nothing). */
  metrics: PostMetrics | null;
};

/** Share (0..1) of the video the average view watches; past 1 with rewatches. Null without numbers. */
export function watchShare(v: ChannelVideo): number | null {
  const m = v.metrics;
  const len = m?.duration ?? v.duration;
  return m?.avgWatch != null && len > 0 ? m.avgWatch / len : null;
}

/** Likes, comments, shares and saves per view. Null without views. */
export function engagementRate(m: PostMetrics | null): number | null {
  if (!m?.views) return null;
  return ((m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0)) / m.views;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
}
const present = <T>(xs: (T | null | undefined)[]) => xs.filter((x): x is T => x != null);

/** The channel's totals and typical video: what a dashboard's headline shows. */
export type ChannelSummary = {
  videos: number;
  views: number;
  medianViews: number | null;
  /** Average share of each video watched. */
  watch: number | null;
  /** Average share skipped in the first 3 s (Instagram). */
  skip: number | null;
  /** Interactions per view over every video. */
  engagement: number | null;
  shares: number;
  saves: number;
};

export function channelSummary(rows: ChannelVideo[]): ChannelSummary {
  const ms = present(rows.map((r) => r.metrics));
  const views = ms.reduce((a, m) => a + (m.views ?? 0), 0);
  const interactions = ms.reduce((a, m) => a + (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0), 0);
  return {
    videos: rows.length,
    views,
    medianViews: median(present(ms.map((m) => m.views))),
    watch: mean(present(rows.map(watchShare))),
    skip: mean(present(ms.map((m) => m.skipRate))),
    engagement: views ? interactions / views : null,
    shares: ms.reduce((a, m) => a + (m.shares ?? 0), 0),
    saves: ms.reduce((a, m) => a + (m.saves ?? 0), 0),
  };
}

/** Videos needed before comparing the best ones with the rest says anything. */
export const MIN_INSIGHT_VIDEOS = 4;

/** One thing the numbers say across videos, and what to do about it. */
export type ChannelInsight = { title: string; detail: string };

/**
 * What the best videos (top third by views) do differently from the rest: the hook (3-second skip), how
 * much of them is watched, their length, the platform, the interactions they get. Only differences big
 * enough to act on; empty with fewer than MIN_INSIGHT_VIDEOS measured videos.
 */
export function channelInsights(rows: ChannelVideo[]): ChannelInsight[] {
  const measured = rows.filter((r) => r.metrics?.views != null).sort((a, b) => b.metrics!.views! - a.metrics!.views!);
  if (measured.length < MIN_INSIGHT_VIDEOS) return [];
  const third = Math.max(1, Math.round(measured.length / 3));
  const top = measured.slice(0, third);
  const rest = measured.slice(third);
  const avg = (xs: ChannelVideo[], f: (r: ChannelVideo) => number | null | undefined) => mean(present(xs.map(f)));
  const out: ChannelInsight[] = [];

  const [ts, rs] = [avg(top, (r) => r.metrics!.skipRate), avg(rest, (r) => r.metrics!.skipRate)];
  if (ts !== null && rs !== null && rs - ts >= 0.08)
    out.push({ title: "The hook decides it", detail: `Your best videos lose ${pct(ts)} of viewers in the first 3 s; the rest lose ${pct(rs)}. Open on the payoff or a question: frame 0 and the first line matter most.` });
  else if (ts !== null && ts >= 0.5)
    out.push({ title: "Most viewers swipe in the first 3 s", detail: `Even your best videos lose ${pct(ts)} before 3 s. Try a stronger first frame: motion right away, text that states the promise.` });

  const [tw, rw] = [avg(top, watchShare), avg(rest, watchShare)];
  if (tw !== null && rw !== null && tw - rw >= 0.1) out.push({ title: "Watched to the end, shown to more", detail: `Viewers watch ${pct(tw)} of your best videos and ${pct(rw)} of the rest. Cut where it sags; get to the point sooner.` });

  const len = (r: ChannelVideo) => r.metrics?.duration ?? (r.duration || null);
  const [tl, rl] = [avg(top, len), avg(rest, len)];
  if (tl !== null && rl !== null && Math.abs(tl - rl) >= Math.max(4, 0.25 * Math.min(tl, rl)))
    out.push(
      tl < rl
        ? { title: "Shorter does better", detail: `Your best videos run ${secs(tl)} on average; the rest ${secs(rl)}. Aim near ${secs(tl)}.` }
        : { title: "Longer does better here", detail: `Your best videos run ${secs(tl)} on average; the rest ${secs(rl)}. Your audience stays for depth: don't cut too short.` },
    );

  const byPlatform = SOCIAL_PLATFORMS.map((p) => ({ p, views: median(measured.filter((r) => r.platform === p).map((r) => r.metrics!.views!)), n: measured.filter((r) => r.platform === p).length })).filter(
    (x) => x.views !== null && x.n >= 2,
  );
  if (byPlatform.length >= 2) {
    byPlatform.sort((a, b) => b.views! - a.views!);
    const [best, worst] = [byPlatform[0]!, byPlatform.at(-1)!];
    if (best.views! >= 2 * Math.max(1, worst.views!))
      out.push({ title: `${SOCIAL_LABEL[best.p]} is where you grow`, detail: `A typical video gets ${compactCount(best.views)} views on ${SOCIAL_LABEL[best.p]} and ${compactCount(worst.views)} on ${SOCIAL_LABEL[worst.p]}. Post there first.` });
  }

  const shares = (r: ChannelVideo) => (r.metrics?.views ? (r.metrics.shares ?? 0) / r.metrics.views : null);
  const [tsh, rsh] = [avg(top, shares), avg(rest, shares)];
  if (tsh !== null && rsh !== null && tsh >= 2 * rsh && tsh > 0.005)
    out.push({ title: "Shares drive the reach", detail: `Your best videos get ${(tsh * 1000).toFixed(1)} shares per 1,000 views, the rest ${(rsh * 1000).toFixed(1)}. Give people a reason to send it: a tip, a surprising number, something to tag a friend in.` });

  return out;
}

const secs = (v: number) => `${Math.round(v)} s`;
