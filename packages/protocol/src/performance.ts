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

/** What a posted video was like, read from its scene (videoFeatures in apps/api/src/social/features.ts). */
export type VideoFeatures = {
  duration: number;
  /** What it opens with: the voice's first words, else the text on screen in the first seconds. */
  hook: string;
  /** Layers that come in per minute after the first frame: how often something new happens. */
  beatsPerMin: number;
  /** Words spoken per second (0 without a voice). */
  wordsPerSec: number;
  voice: boolean;
  captions: boolean;
  music: boolean;
  genre: string | null;
  format: string | null;
  /** What comes on screen and when (no shapes), to line up with where the audience leaves. */
  timeline?: Moment[];
  /** Every second something new comes in, shapes included. */
  starts?: number[];
};

/** What an element on screen is to a viewer (momentKind in apps/api/src/social/features.ts). */
export const MomentKind = {
  Chart: "chart",
  Table: "table",
  Map: "map",
  Code: "code",
  Ui: "ui",
  Logo: "logo",
  Cta: "cta",
  Price: "price",
  Footage: "footage",
  Image: "image",
  Character: "character",
  Object3d: "object",
  Icon: "icon",
  Vector: "vector",
  Effect: "effect",
  Title: "title",
  Text: "text",
} as const;
export type MomentKind = (typeof MomentKind)[keyof typeof MomentKind];
export const MOMENT_LABEL: Record<MomentKind, string> = {
  chart: "a chart",
  table: "a table",
  map: "a map",
  code: "code",
  ui: "an app screen",
  logo: "a logo",
  cta: "a call to action",
  price: "a price",
  footage: "a video clip",
  image: "an image",
  character: "a character",
  object: "a 3D object",
  icon: "an icon",
  vector: "a drawing",
  effect: "an effect",
  title: "a big title",
  text: "a line of text",
};

/** One element on screen: from `start` to `end` (s), what it is and what it says or is called. */
export type Moment = { start: number; end: number; kind: MomentKind; label: string };

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
  /** Views when it was 3 days old (null until then, or when it was linked later). */
  views3d: number | null;
  features: VideoFeatures | null;
  /** What the video tested, if anything. */
  experiment: Experiment | null;
  /** The hook variant this copy played (videos posted with several openings). */
  variant?: string | null;
};

/** The number an experiment should move. */
export const ExperimentMetric = { Views: "views", Hook: "hook", Watch: "watch", Shares: "shares", Saves: "saves" } as const;
export type ExperimentMetric = (typeof ExperimentMetric)[keyof typeof ExperimentMetric];
export const EXPERIMENT_METRIC_LABEL: Record<ExperimentMetric, string> = {
  views: "Views",
  hook: "Hook (fewer skip in 3 s)",
  watch: "How much is watched",
  shares: "Shares",
  saves: "Saves",
};
/** The one thing a video tries differently, and the number that says whether it worked. */
export type Experiment = { change: string; metric: ExperimentMetric; setAt: string };

/** A post younger than this is still collecting views: it is shown, but not compared with older ones. */
export const MATURE_HOURS = 72;

/** Hours since it was published (Infinity when unknown: treated as old enough). */
export const ageHours = (r: ChannelVideo, now = Date.now()) => (r.publishedAt ? (now - Date.parse(r.publishedAt)) / 3_600_000 : Infinity);
export const isGrowing = (r: ChannelVideo, now = Date.now()) => ageHours(r, now) < MATURE_HOURS;
/** Views to rank videos by: at 3 days old when kept (every video at the same age), else the latest. */
export const comparableViews = (r: ChannelVideo) => r.views3d ?? r.metrics?.views ?? null;

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

/** Measured videos old enough to compare, best first. */
export function comparable(rows: ChannelVideo[], now = Date.now()): ChannelVideo[] {
  return rows.filter((r) => r.metrics?.views != null && !isGrowing(r, now)).sort((a, b) => comparableViews(b)! - comparableViews(a)!);
}

/** Videos needed before comparing the best ones with the rest says anything. */
export const MIN_INSIGHT_VIDEOS = 4;

/** How much to trust what the comparison says, by how many videos it rests on. */
export const Confidence = { Early: "early", Fair: "fair", Solid: "solid" } as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];
export const confidence = (videos: number): Confidence => (videos < 8 ? Confidence.Early : videos < 20 ? Confidence.Fair : Confidence.Solid);
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  early: "Early signal: hunches to test, not rules yet",
  fair: "Taking shape: patterns worth following",
  solid: "Solid: patterns across many videos",
};

/** One thing the numbers say across videos, and what to do about it. */
export type ChannelInsight = { title: string; detail: string };

/**
 * What the best videos (top third by views at the same age, at least two) do differently from the rest:
 * the hook (3-second skip and the opening line), how much of them is watched, their length and pace, the
 * voice, the platform and the shares. Only differences big enough to act on, among videos at least
 * MATURE_HOURS old; empty with fewer than MIN_INSIGHT_VIDEOS.
 */
export function channelInsights(rows: ChannelVideo[], now = Date.now()): ChannelInsight[] {
  const measured = comparable(rows, now);
  if (measured.length < MIN_INSIGHT_VIDEOS) return [];
  const third = Math.max(2, Math.round(measured.length / 3));
  const top = measured.slice(0, third);
  const rest = measured.slice(third);
  const avg = (xs: ChannelVideo[], f: (r: ChannelVideo) => number | null | undefined) => mean(present(xs.map(f)));
  const out: ChannelInsight[] = [];

  const [ts, rs] = [avg(top, (r) => r.metrics!.skipRate), avg(rest, (r) => r.metrics!.skipRate)];
  if (ts !== null && rs !== null && rs - ts >= 0.08)
    out.push({ title: "The hook decides it", detail: `Your best videos lose ${pct(ts)} of viewers in the first 3 s; the rest lose ${pct(rs)}. Open on the payoff or a question: frame 0 and the first line matter most.` });
  else if (ts !== null && ts >= 0.5)
    out.push({ title: "Most viewers swipe in the first 3 s", detail: `Even your best videos lose ${pct(ts)} before 3 s. Try a stronger first frame: motion right away, text that states the promise.` });

  const hookWords = (r: ChannelVideo) => (r.features?.hook ? r.features.hook.split(/\s+/).length : null);
  const [th, rh] = [avg(top, hookWords), avg(rest, hookWords)];
  if (th !== null && rh !== null && Math.abs(th - rh) >= 4)
    out.push(
      th < rh
        ? { title: "Short opening lines", detail: `Your best videos open with about ${Math.round(th)} words; the rest with ${Math.round(rh)}. Say the hook in one breath.` }
        : { title: "Openings that set it up", detail: `Your best videos open with about ${Math.round(th)} words; the rest with ${Math.round(rh)}. A full first sentence works for you.` },
    );

  const [tw, rw] = [avg(top, watchShare), avg(rest, watchShare)];
  if (tw !== null && rw !== null && tw - rw >= 0.1) out.push({ title: "Watched to the end, shown to more", detail: `Viewers watch ${pct(tw)} of your best videos and ${pct(rw)} of the rest. Cut where it sags; get to the point sooner.` });

  const len = (r: ChannelVideo) => r.metrics?.duration ?? (r.features?.duration || r.duration || null);
  const [tl, rl] = [avg(top, len), avg(rest, len)];
  if (tl !== null && rl !== null && Math.abs(tl - rl) >= Math.max(4, 0.25 * Math.min(tl, rl)))
    out.push(
      tl < rl
        ? { title: "Shorter does better", detail: `Your best videos run ${secs(tl)} on average; the rest ${secs(rl)}. Aim near ${secs(tl)}.` }
        : { title: "Longer does better here", detail: `Your best videos run ${secs(tl)} on average; the rest ${secs(rl)}. Your audience stays for depth: don't cut too short.` },
    );

  const pace = (r: ChannelVideo) => r.features?.beatsPerMin ?? null;
  const [tp, rp] = [avg(top, pace), avg(rest, pace)];
  if (tp !== null && rp !== null && tp > 0 && rp > 0 && Math.abs(tp - rp) >= Math.max(4, 0.25 * Math.min(tp, rp)))
    out.push(
      tp > rp
        ? { title: "A faster pace holds them", detail: `Something new comes in every ${secs(60 / tp)} in your best videos and every ${secs(60 / rp)} in the rest. Change the frame more often.` }
        : { title: "Calmer videos do better", detail: `Your best videos change every ${secs(60 / tp)}; the rest every ${secs(60 / rp)}. Let each idea breathe.` },
    );

  const share = (xs: ChannelVideo[], f: (v: VideoFeatures) => boolean) => {
    const known = xs.filter((r) => r.features);
    return known.length ? known.filter((r) => f(r.features!)).length / known.length : null;
  };
  const [tv, rv] = [share(top, (f) => f.voice), share(rest, (f) => f.voice)];
  if (tv !== null && rv !== null && Math.abs(tv - rv) >= 0.5)
    out.push(
      tv > rv
        ? { title: "A voice helps", detail: `${pct(tv)} of your best videos have a voice-over, against ${pct(rv)} of the rest.` }
        : { title: "Text alone works for you", detail: `Only ${pct(tv)} of your best videos have a voice-over, against ${pct(rv)} of the rest.` },
    );

  const byPlatform = SOCIAL_PLATFORMS.map((p) => {
    const mine = measured.filter((r) => r.platform === p);
    return { p, views: median(mine.map((r) => comparableViews(r)!)), n: mine.length };
  }).filter((x) => x.views !== null && x.n >= 2);
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

/** How an experiment turned out. */
export const ExperimentStatus = { Waiting: "waiting", Worked: "worked", Failed: "failed", Unclear: "unclear" } as const;
export type ExperimentStatus = (typeof ExperimentStatus)[keyof typeof ExperimentStatus];
export const EXPERIMENT_STATUS_LABEL: Record<ExperimentStatus, string> = { waiting: "Waiting", worked: "Worked", failed: "Didn't work", unclear: "No clear change" };

export type ExperimentResult = {
  projectId: string;
  name: string;
  platform: SocialPlatform;
  experiment: Experiment;
  status: ExperimentStatus;
  /** What it got and what the channel usually gets, as shown ("18% skip" against "31%"); null while waiting. */
  value: string | null;
  usual: string | null;
  /** When it can be judged (while waiting). */
  readyAt: string | null;
};

type MetricRule = {
  of: (r: ChannelVideo) => number | null;
  /** Lower is better (skips). */
  lower?: boolean;
  /** The smallest change that counts: in points for shares of the audience, relative for counts. */
  points?: number;
  relative?: number;
  show: (v: number) => string;
};
const per1k = (n: number | null | undefined, views: number | null | undefined) => (views ? ((n ?? 0) / views) * 1000 : null);
const METRIC: Record<ExperimentMetric, MetricRule> = {
  views: { of: comparableViews, relative: 0.25, show: (v) => `${compactCount(v)} views` },
  hook: { of: (r) => r.metrics?.skipRate ?? null, lower: true, points: 0.05, show: (v) => `${pct(v)} skip in 3 s` },
  watch: { of: watchShare, points: 0.08, show: (v) => `${pct(v)} watched` },
  shares: { of: (r) => per1k(r.metrics?.shares, r.metrics?.views), relative: 0.3, show: (v) => `${v.toFixed(1)} shares per 1K views` },
  saves: { of: (r) => per1k(r.metrics?.saves, r.metrics?.views), relative: 0.3, show: (v) => `${v.toFixed(1)} saves per 1K views` },
};
/** Other videos needed to say what is usual. */
const MIN_BASELINE = 2;

/**
 * Each video that tested something, judged once it is MATURE_HOURS old: its number against the median
 * of the channel's other videos old enough to compare (on the same platform when it has at least two). One result
 * per video, on its most viewed platform; newest first.
 */
export function channelExperiments(rows: ChannelVideo[], now = Date.now()): ExperimentResult[] {
  const ranked = comparable(rows, now);
  const byProject = new Map<string, ChannelVideo>();
  for (const r of rows) {
    if (!r.experiment) continue;
    const prev = byProject.get(r.projectId);
    if (!prev || (r.metrics?.views ?? -1) > (prev.metrics?.views ?? -1)) byProject.set(r.projectId, r);
  }
  const out: ExperimentResult[] = [];
  for (const r of byProject.values()) {
    const e = r.experiment!;
    const rule = METRIC[e.metric];
    const base = { projectId: r.projectId, name: r.name, platform: r.platform, experiment: e };
    if (r.metrics?.views == null || isGrowing(r, now)) {
      const born = r.publishedAt ? Date.parse(r.publishedAt) : null;
      out.push({ ...base, status: ExperimentStatus.Waiting, value: null, usual: null, readyAt: born ? new Date(born + MATURE_HOURS * 3_600_000).toISOString() : null });
      continue;
    }
    const others = ranked.filter((x) => x.projectId !== r.projectId);
    const samePlatform = others.filter((x) => x.platform === r.platform);
    const pool = (samePlatform.length >= MIN_BASELINE ? samePlatform : others).map(rule.of).filter((v): v is number => v !== null);
    const value = rule.of(r);
    const usual = median(pool);
    if (value === null || usual === null || pool.length < MIN_BASELINE) {
      out.push({ ...base, status: ExperimentStatus.Unclear, value: value === null ? null : rule.show(value), usual: null, readyAt: null });
      continue;
    }
    const diff = rule.lower ? usual - value : value - usual;
    const enough = rule.points !== undefined ? rule.points : (rule.relative ?? 0) * Math.max(Math.abs(usual), 1e-9);
    const status = diff >= enough ? ExperimentStatus.Worked : diff <= -enough ? ExperimentStatus.Failed : ExperimentStatus.Unclear;
    out.push({ ...base, status, value: rule.show(value), usual: rule.show(usual), readyAt: null });
  }
  const at = (x: ExperimentResult) => x.experiment.setAt;
  return out.sort((a, b) => at(b).localeCompare(at(a)));
}

/** What one posted video teaches: where it beat or fell short of the channel's usual, and what it did differently. */
export type ChannelLesson = {
  projectId: string;
  name: string;
  platform: SocialPlatform;
  /** Numbers clearly above the usual ("81% watched, usually 43%"), with the metric each is. */
  better: { metric: ExperimentMetric; text: string }[];
  worse: { metric: ExperimentMetric; text: string }[];
  /** How it was made differently from the others ("45 s, usually 30 s", "opens with 4 words"). */
  traits: string[];
  hook: string | null;
  /** Already says what it tested. */
  tested: boolean;
};

/** Lessons shown and handed to the agent. */
const MAX_LESSONS = 6;

/**
 * Every posted video old enough to compare, read against the others even if it never declared an
 * experiment: which numbers stand out (beyond the same margins experiments use) and which of its traits
 * differ from the rest. Correlation, not proof: the playbook says so and suggests testing the trait.
 * Videos that stand out most come first.
 */
export function channelLessons(rows: ChannelVideo[], now = Date.now()): ChannelLesson[] {
  const ranked = comparable(rows, now);
  if (ranked.length < MIN_BASELINE + 1) return [];
  const seen = new Set<string>();
  const out: (ChannelLesson & { weight: number })[] = [];
  for (const r of ranked) {
    if (seen.has(r.projectId)) continue;
    seen.add(r.projectId);
    const others = ranked.filter((x) => x.projectId !== r.projectId);
    const same = others.filter((x) => x.platform === r.platform);
    const pool = same.length >= MIN_BASELINE ? same : others;
    const better: ChannelLesson["better"] = [];
    const worse: ChannelLesson["worse"] = [];
    let weight = 0;
    for (const metric of Object.values(ExperimentMetric)) {
      const rule = METRIC[metric];
      const value = rule.of(r);
      const usual = median(pool.map(rule.of).filter((v): v is number => v !== null));
      if (value === null || usual === null) continue;
      const enough = rule.points !== undefined ? rule.points : (rule.relative ?? 0) * Math.max(Math.abs(usual), 1e-9);
      const diff = rule.lower ? usual - value : value - usual;
      if (Math.abs(diff) < enough) continue;
      (diff > 0 ? better : worse).push({ metric, text: `${rule.show(value)} (usually ${rule.show(usual)})` });
      // Capped, so one runaway ratio (12 shares where 1 is usual) does not outweigh three clear wins.
      weight += Math.min(3, Math.abs(diff) / enough);
    }
    if (!better.length && !worse.length) continue;
    const traits: string[] = [];
    const f = r.features;
    const fs = pool.map((x) => x.features).filter((x): x is VideoFeatures => !!x);
    if (f && fs.length) {
      const mid = (g: (v: VideoFeatures) => number) => median(fs.map(g).filter((v) => v > 0));
      const d = mid((v) => v.duration);
      if (d && f.duration && Math.abs(f.duration - d) >= Math.max(4, 0.25 * d)) traits.push(`${secs(f.duration)} long (the others ${secs(d)})`);
      const b = mid((v) => v.beatsPerMin);
      if (b && f.beatsPerMin && Math.abs(f.beatsPerMin - b) >= Math.max(4, 0.25 * b))
        traits.push(`${f.beatsPerMin > b ? "faster" : "calmer"}: something new every ${secs(60 / f.beatsPerMin)} (the others every ${secs(60 / b)})`);
      const words = (v: VideoFeatures) => (v.hook ? v.hook.split(/\s+/).length : 0);
      const w = mid(words);
      if (w && words(f) && Math.abs(words(f) - w) >= 4) traits.push(`a ${words(f) < w ? "shorter" : "longer"} opening line: ${words(f)} words (the others ${Math.round(w)})`);
      const voiced = fs.filter((v) => v.voice).length / fs.length;
      if (f.voice && voiced <= 0.34) traits.push("has a voice-over (most don't)");
      if (!f.voice && voiced >= 0.66) traits.push("no voice-over (most have one)");
      const captioned = fs.filter((v) => v.captions).length / fs.length;
      if (f.captions && captioned <= 0.34) traits.push("has captions (most don't)");
      if (!f.captions && captioned >= 0.66) traits.push("no captions (most have them)");
    }
    out.push({ projectId: r.projectId, name: r.name, platform: r.platform, better, worse, traits, hook: f?.hook || null, tested: !!r.experiment, weight });
  }
  return out
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_LESSONS)
    .map(({ weight: _, ...l }) => l);
}

/** Seconds after something appears that its effect on the audience is measured over. */
export const DROPOFF_WINDOW = 2;
/** Seconds either side of a moment that set what "normal" is there (the curve falls faster early on). */
const DROPOFF_AROUND = 4;
/** Seconds between the points the slope around a moment is read at. */
const STEP = 0.5;
/** Nothing new on screen for this long counts as a moment of its own. */
const STILL_AFTER = 3;
/** A pattern needs this many moments, in at least MIN_DROPOFF_VIDEOS videos. */
const MIN_DROPOFF_MOMENTS = 3;
const MIN_DROPOFF_VIDEOS = 2;
/** Extra (or fewer) viewers leaving, in points of the audience, worth telling. */
const DROPOFF_POINTS = 0.015;

/** A kind of moment and what it does to the audience: `leave` share in the DROPOFF_WINDOW after it, against `normal` there. */
export type DropoffPattern = { kind: MomentKind | "still"; label: string; moments: number; videos: number; leave: number; normal: number; examples: string[] };
/** One of the steepest falls across the channel, with what was on screen. */
export type DropoffMoment = { projectId: string; name: string; platform: SocialPlatform; t: number; share: number; onScreen: string[] };
export type ChannelDropoffs = { videos: number; patterns: DropoffPattern[]; moments: DropoffMoment[] };

/**
 * Where viewers leave across the channel, matched with what was on screen: for each kind of moment (a
 * chart appears, a clip starts, nothing new for 3 s…) the share of the audience that leaves in the next
 * DROPOFF_WINDOW seconds against the usual fall around it in the same video, plus the steepest falls of
 * all. Needs the retention curve (YouTube) and the video's timeline; the hook (first 3 s) and the last
 * moments, where everyone leaves anyway, are left out.
 */
export function channelDropoffs(rows: ChannelVideo[]): ChannelDropoffs {
  const curves = rows.filter((r) => (r.metrics?.retention?.length ?? 0) >= 20 && r.features?.timeline);
  const groups = new Map<string, { kind: MomentKind | "still"; leave: number[]; normal: number[]; videos: Set<string>; examples: string[] }>();
  const moments: DropoffMoment[] = [];
  for (const r of curves) {
    const curve = r.metrics!.retention!;
    const len = r.metrics!.duration ?? (r.features!.duration || r.duration);
    if (!(len > SKIP_WINDOW + DROPOFF_WINDOW * 2)) continue;
    const at = (t: number) => {
      const x = (Math.min(Math.max(t, 0), len) / len) * (curve.length - 1);
      const i = Math.floor(x);
      return curve[i]! + (curve[Math.min(i + 1, curve.length - 1)]! - curve[i]!) * (x - i);
    };
    const last = len * 0.95 - DROPOFF_WINDOW;
    const measure = (s: number) => {
      if (s < SKIP_WINDOW || s > last || at(s) <= 0.01) return null;
      const e = s + DROPOFF_WINDOW;
      const [a, b] = [Math.max(SKIP_WINDOW, s - DROPOFF_AROUND), Math.min(len * 0.95, e + DROPOFF_AROUND)];
      // The median slope around it, so another cliff nearby does not make this one look normal.
      const slopes: number[] = [];
      for (let x = a; x + STEP <= s; x += STEP) slopes.push((at(x) - at(x + STEP)) / STEP);
      for (let x = e; x + STEP <= b; x += STEP) slopes.push((at(x) - at(x + STEP)) / STEP);
      if (slopes.length < 2) return null;
      const rate = Math.max(0, median(slopes)!);
      return { leave: Math.max(0, at(s) - at(e)) / at(s), normal: (rate * DROPOFF_WINDOW) / at(s) };
    };
    const add = (kind: MomentKind | "still", s: number, example: string) => {
      const m = measure(s);
      if (!m) return;
      let g = groups.get(kind);
      if (!g) groups.set(kind, (g = { kind, leave: [], normal: [], videos: new Set(), examples: [] }));
      g.leave.push(m.leave);
      g.normal.push(m.normal);
      g.videos.add(r.projectId);
      if (g.examples.length < 3 && example) g.examples.push(`${example} in "${r.name}" at ${secs(s)}`);
    };
    // One moment per kind per second: a chart's bars coming in together are one chart appearing.
    const seen = new Set<string>();
    for (const m of r.features!.timeline!) {
      const key = `${m.kind}@${Math.round(m.start)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(m.kind, m.start, m.label);
    }
    const starts = [...(r.features!.starts ?? r.features!.timeline!.map((m) => m.start))].sort((a, b) => a - b);
    for (let i = 0; i < starts.length; i++) {
      const next = starts[i + 1] ?? len;
      if (next - starts[i]! >= STILL_AFTER + DROPOFF_WINDOW) add("still", starts[i]! + STILL_AFTER, "");
    }
    for (const d of audienceDrops({ ...r.metrics!, skipRate: null, avgWatch: null }, len, 3)) {
      if (d.t < SKIP_WINDOW || d.t > last + DROPOFF_WINDOW) continue;
      const alive = r.features!.timeline!.filter((m) => m.start <= d.t && m.end > d.t);
      const fresh = alive.filter((m) => d.t - m.start <= DROPOFF_WINDOW * 2);
      moments.push({ projectId: r.projectId, name: r.name, platform: r.platform, t: d.t, share: d.share, onScreen: (fresh.length ? fresh : alive).slice(0, 3).map((m) => `${MOMENT_LABEL[m.kind]} (${m.label})`) });
    }
  }
  const patterns: DropoffPattern[] = [];
  for (const g of groups.values()) {
    if (g.leave.length < MIN_DROPOFF_MOMENTS || g.videos.size < MIN_DROPOFF_VIDEOS) continue;
    const [leave, normal] = [mean(g.leave)!, mean(g.normal)!];
    if (Math.abs(leave - normal) < DROPOFF_POINTS) continue;
    if (leave > normal ? leave < normal * 1.4 : leave > normal * 0.7) continue;
    const label = g.kind === "still" ? `nothing new for ${STILL_AFTER} s` : MOMENT_LABEL[g.kind];
    patterns.push({ kind: g.kind, label, moments: g.leave.length, videos: g.videos.size, leave, normal, examples: g.examples });
  }
  patterns.sort((a, b) => b.leave - b.normal - (a.leave - a.normal));
  moments.sort((a, b) => b.share - a.share);
  return { videos: curves.length, patterns, moments: moments.slice(0, 5) };
}

/** One hook of a video posted with several: where it went and how it did against the channel's usual there. */
export type HookEntry = {
  variant: string;
  hook: string;
  platforms: SocialPlatform[];
  views: number | null;
  /** Views (at 3 days) over the usual on the same platforms: 2 = twice as many. */
  vsUsual: number | null;
  skipRate: number | null;
  growing: boolean;
};
export const HookTestStatus = { Waiting: "waiting", Won: "won", Unclear: "unclear" } as const;
export type HookTestStatus = (typeof HookTestStatus)[keyof typeof HookTestStatus];
export type HookTest = { projectId: string; name: string; status: HookTestStatus; winner: string | null; entries: HookEntry[] };
/** A hook wins when it does this many times better than the next one. */
const HOOK_WIN = 1.25;

/**
 * Videos posted with several hooks (a different opening per platform or per post): each hook's views
 * at 3 days against the channel's usual on the same platform, so a hook on TikTok and one on Instagram
 * compare fairly. Waiting while any is under 3 days old; a winner when it beats the next by HOOK_WIN.
 */
export function hookTests(rows: ChannelVideo[], now = Date.now()): HookTest[] {
  const mature = comparable(rows, now);
  const out: HookTest[] = [];
  for (const projectId of new Set(rows.filter((r) => r.variant).map((r) => r.projectId))) {
    const mine = rows.filter((r) => r.projectId === projectId && r.variant);
    const variants = [...new Set(mine.map((r) => r.variant!))].sort();
    if (variants.length < 2) continue;
    const others = mature.filter((r) => r.projectId !== projectId);
    const usual = (p: SocialPlatform) => {
      const same = others.filter((r) => r.platform === p);
      return median((same.length >= MIN_BASELINE ? same : others).map((r) => comparableViews(r)!));
    };
    const entries: HookEntry[] = variants.map((variant) => {
      const copies = mine.filter((r) => r.variant === variant);
      const growing = copies.some((r) => isGrowing(r, now));
      const views = copies.reduce<number | null>((sum, r) => (comparableViews(r) === null ? sum : (sum ?? 0) + comparableViews(r)!), null);
      const ratios = copies.map((r) => {
        const u = usual(r.platform);
        const v = comparableViews(r);
        return u && v !== null ? v / u : null;
      });
      return {
        variant,
        hook: copies.find((r) => r.features?.hook)?.features?.hook ?? "",
        platforms: [...new Set(copies.map((r) => r.platform))],
        views,
        vsUsual: mean(present(ratios)),
        skipRate: mean(present(copies.map((r) => r.metrics?.skipRate))),
        growing,
      };
    });
    const ranked = entries.filter((e) => e.vsUsual !== null).sort((a, b) => b.vsUsual! - a.vsUsual!);
    const waiting = entries.some((e) => e.growing) || ranked.length < 2;
    const won = !waiting && ranked[0]!.vsUsual! >= HOOK_WIN * ranked[1]!.vsUsual!;
    out.push({ projectId, name: mine[0]!.name, status: waiting ? HookTestStatus.Waiting : won ? HookTestStatus.Won : HookTestStatus.Unclear, winner: won ? ranked[0]!.variant : null, entries });
  }
  return out;
}

function hookTestLine(t: HookTest): string {
  const each = t.entries
    .map((e) => `${e.variant} ("${e.hook || "?"}") on ${e.platforms.map((p) => SOCIAL_LABEL[p]).join(" + ")}: ${e.vsUsual === null ? "no numbers yet" : `${e.vsUsual.toFixed(1)}x your usual views`}${e.skipRate !== null ? `, ${pct(e.skipRate)} skip` : ""}`)
    .join("; ");
  const verdict = t.status === HookTestStatus.Waiting ? "waiting (under 3 days)" : t.status === HookTestStatus.Won ? `hook ${t.winner} won` : "no clear winner";
  return `- "${t.name}": ${verdict}. ${each}.`;
}

/** "When a chart appears, 12% leave in the next 2 s (usually 4% there)". */
export function dropoffLine(p: DropoffPattern): string {
  const when = p.kind === "still" ? `After ${p.label}` : `When ${p.label} appears`;
  const verb = p.leave > p.normal ? "leave" : "leave (fewer than usual)";
  return `${when}, ${pct(p.leave)} of viewers ${verb} in the next ${DROPOFF_WINDOW} s, against ${pct(p.normal)} usually there · ${p.moments} times in ${p.videos} videos`;
}

function lessonLine(l: ChannelLesson): string {
  const numbers = [...l.better.map((b) => b.text), ...l.worse.map((w) => w.text)].join(", ");
  const verdict = l.better.length && !l.worse.length ? "did well" : l.worse.length && !l.better.length ? "fell short" : "was mixed";
  const why = [l.hook ? `opens with "${l.hook}"` : null, ...l.traits].filter(Boolean).join("; ");
  return `- "${l.name}" ${verdict}: ${numbers}.${why ? ` It ${why}.` : ""}`;
}

function experimentLine(x: ExperimentResult): string {
  const what = `"${x.experiment.change}" on "${x.name}" (measured by ${EXPERIMENT_METRIC_LABEL[x.experiment.metric].toLowerCase()})`;
  if (x.status === ExperimentStatus.Waiting) return `- Waiting: ${what}${x.readyAt ? `, judged after ${x.readyAt.slice(0, 10)}` : ""}`;
  const numbers = x.value && x.usual ? `: ${x.value} against ${x.usual} usually` : "";
  return `- ${EXPERIMENT_STATUS_LABEL[x.status]}: ${what}${numbers}`;
}

function describe(r: ChannelVideo): string {
  const m = r.metrics!;
  const parts = [`${compactCount(comparableViews(r))} views${r.views3d != null ? " at 3 days" : ""}`];
  const w = watchShare(r);
  if (w !== null) parts.push(`${pct(w)} watched`);
  if (m.skipRate !== null) parts.push(`${pct(m.skipRate)} skip in 3 s`);
  const e = engagementRate(m);
  if (e !== null) parts.push(`${(e * 100).toFixed(1)}% engagement (${m.shares ?? 0} shares, ${m.saves ?? 0} saves)`);
  const f = r.features;
  const made = f ? [`${secs(f.duration)}`, f.beatsPerMin ? `a new element every ${secs(60 / f.beatsPerMin)}` : null, f.voice ? "voice-over" : "no voice", f.captions ? "captions" : null, f.genre].filter(Boolean).join(", ") : null;
  return `"${r.name}" (${SOCIAL_LABEL[r.platform]}): ${parts.join(" · ")}${made ? `\n    made: ${made}` : ""}${f?.hook ? `\n    opens with: "${f.hook}"` : ""}`;
}

/**
 * The channel's playbook for an agent about to make or change a video: how sure the patterns are, the
 * video to learn from and the weakest, what the best ones share, and the posts still too young to judge.
 * Null while nothing posted has numbers.
 */
export function channelPlaybook(rows: ChannelVideo[], now = Date.now()): string | null {
  const measured = comparable(rows, now);
  const growing = rows.filter((r) => r.metrics?.views != null && isGrowing(r, now));
  if (!measured.length && !growing.length) return null;
  const level = confidence(measured.length);
  const out = [`${measured.length} posted ${measured.length === 1 ? "video" : "videos"} old enough to compare · ${CONFIDENCE_LABEL[level]}.`];
  if (measured.length) out.push(`Learn from: ${describe(measured[0]!)}`);
  if (measured.length > 1) out.push(`Weakest: ${describe(measured.at(-1)!)}`);
  const insights = channelInsights(rows, now);
  if (insights.length) out.push("What the best ones do differently:", ...insights.map((i) => `- ${i.title}: ${i.detail}`));
  else if (measured.length < MIN_INSIGHT_VIDEOS) out.push(`Too few videos to compare yet (${measured.length} of ${MIN_INSIGHT_VIDEOS}): start from the best one's hook and length.`);
  const lessons = channelLessons(rows, now).filter((l) => !l.tested);
  if (lessons.length)
    out.push(
      "Lessons from videos already posted (they declared no experiment, so these are correlations: copy what the strong ones did, and test it with set_experiment to confirm):",
      ...lessons.map(lessonLine),
    );
  const drops = channelDropoffs(rows);
  if (drops.patterns.length || drops.moments.length) {
    out.push(`Where viewers leave (retention curves of ${drops.videos} ${drops.videos === 1 ? "video" : "videos"}, matched with what was on screen):`);
    out.push(...drops.patterns.map((p) => `- ${dropoffLine(p)}${p.leave > p.normal ? ": avoid it or make it quicker" : ": it holds them, use more"}.`));
    out.push(...drops.moments.slice(0, 3).map((m) => `- Steepest fall: "${m.name}" at ${secs(m.t)}, ${pct(m.share)} left${m.onScreen.length ? ` while ${m.onScreen.join(", ")} was on screen` : ""}.`));
  }
  const hooks = hookTests(rows, now);
  if (hooks.length) out.push("Hook tests (same video, different openings; open like the winners):", ...hooks.map(hookTestLine));
  const experiments = channelExperiments(rows, now);
  if (experiments.length) out.push("Experiments so far (build on what worked, don't repeat what didn't):", ...experiments.slice(0, 10).map(experimentLine));
  if (growing.length) out.push(`Still collecting views (under ${MATURE_HOURS / 24} days, don't judge them yet): ${growing.map((r) => `"${r.name}" ${compactCount(r.metrics!.views)} views at ${Math.round(ageHours(r, now))} h`).join(", ")}.`);
  out.push(
    level === Confidence.Early
      ? "With this few videos, treat the patterns as hunches: keep what the best one did and change ONE thing (the hook, the length, the pace…). Record it with set_experiment and tell the user what you are testing."
      : "Keep what the best ones share and avoid what the weakest share; change ONE thing per video, record it with set_experiment and tell the user, so the next numbers say whether it worked.",
  );
  return out.join("\n");
}
