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
