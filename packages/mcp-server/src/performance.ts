/**
 * get_performance: how this video did where it was posted, with each moment the audience leaves
 * mapped to what was on screen then, so the agent edits the moment and not the whole video.
 */
import {
  attentionSparkline,
  audienceDrops,
  channelInsights,
  channelSummary,
  compactCount,
  engagementRate,
  MIN_INSIGHT_VIDEOS,
  onScreenAt,
  SOCIAL_LABEL,
  watchShare,
  type ChannelVideo,
  type PostMetrics,
  type PostPerformance,
} from "@motionily/protocol";

type SceneLike = { layers?: unknown; duration?: unknown };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${+v.toFixed(1)} s`;

function counts(m: PostMetrics) {
  const parts: [string, number | null][] = [
    ["views", m.views],
    ["reach", m.reach],
    ["likes", m.likes],
    ["comments", m.comments],
    ["shares", m.shares],
    ["saves", m.saves],
  ];
  return parts
    .filter(([, v]) => v !== null)
    .map(([k, v]) => (k === "reach" ? `reach ${compactCount(v)}` : `${compactCount(v)} ${k}`))
    .join(" · ");
}

function metricLines(m: PostMetrics, scene: SceneLike, url: string | null): string[] {
  const duration = m.duration ?? (typeof scene.duration === "number" ? scene.duration : 0);
  const out = [`${SOCIAL_LABEL[m.platform]}${url ? ` · ${url}` : ""} · measured ${m.fetchedAt.slice(0, 16).replace("T", " ")}`, `  ${counts(m) || "no counts yet"}`];
  const watch: string[] = [];
  if (m.avgWatch !== null && duration > 0) watch.push(`average view ${secs(m.avgWatch)} of ${secs(duration)} (${pct(m.avgWatch / duration)})`);
  if (m.skipRate !== null) watch.push(`${pct(m.skipRate)} skipped in the first 3 s`);
  if (watch.length) out.push(`  ${watch.join(" · ")}`);
  if (m.retention?.length) out.push(`  retention ${attentionSparkline(m.retention.map((v) => Math.min(1, v)), 5)} (${pct(m.retention[0]!)} → ${pct(m.retention.at(-1)!)})`);
  const drops = audienceDrops(m, duration);
  if (drops.length) {
    out.push("  where they leave:");
    for (const d of drops) {
      const seen = onScreenAt(scene, d.t);
      out.push(`  - ${secs(d.t)}: ${d.why}${seen.length ? ` · on screen: ${seen.join(", ")}` : ""}`);
    }
  }
  return out;
}

export function performanceReport(posts: PostPerformance[], scene: SceneLike): string {
  if (!posts.length) return "This video has not been posted from the calendar yet, or the user has not connected Instagram, TikTok or YouTube in Settings: no audience numbers.";
  const out: string[] = [];
  for (const p of posts) {
    out.push(`Posted ${p.postedAt?.slice(0, 10) ?? "(date unknown)"}${p.outdated ? " · edited since: the times are of the posted cut, check the moment still holds the same thing before changing it" : ""}`);
    if (!p.metrics.length) out.push("  not matched to a published video yet (the user can paste its link in the calendar), or the numbers are still coming");
    for (const m of p.metrics) out.push(...metricLines(m, scene, p.links.find((l) => l.platform === m.platform)?.url ?? null));
  }
  out.push(
    "Read it as the attention curve's real-world check: fix the moments where viewers leave (a re-hook just before the drop, the payoff earlier, a cut where it sags), a high 3-second skip means the hook (frame 0 and the first line). Compare platforms before blaming the video: one weak platform is the platform.",
  );
  return out.join("\n");
}

/** Videos listed by name in the channel report (best and worst). */
const CHANNEL_LISTED = 5;

function channelLine(r: ChannelVideo, projectId: string) {
  const m = r.metrics!;
  const parts = [`${compactCount(m.views)} views`];
  const w = watchShare(r);
  if (w !== null) parts.push(`${pct(w)} watched`);
  if (m.skipRate !== null) parts.push(`${pct(m.skipRate)} skip 3 s`);
  const e = engagementRate(m);
  if (e !== null) parts.push(`${(e * 100).toFixed(1)}% engagement`);
  const len = m.duration ?? r.duration;
  if (len) parts.push(secs(len));
  return `- "${r.name}"${r.projectId === projectId ? " (this video)" : ""} · ${SOCIAL_LABEL[r.platform]} ${r.publishedAt?.slice(0, 10) ?? ""} · ${parts.join(" · ")}`;
}

/** get_channel_insights: how the account's posted videos compare, and what the best ones do differently. */
export function channelReport(rows: ChannelVideo[], projectId: string): string {
  const measured = rows.filter((r) => r.metrics?.views != null).sort((a, b) => b.metrics!.views! - a.metrics!.views!);
  if (!measured.length)
    return "No posted video has numbers yet: the user has to connect Instagram, TikTok or YouTube in Settings and post from the calendar (or link videos already posted, on the Stats page).";
  const s = channelSummary(measured);
  const head = [`${s.videos} posted videos measured · ${compactCount(s.views)} views in all · typical video ${compactCount(s.medianViews)} views`];
  const avgs: string[] = [];
  if (s.watch !== null) avgs.push(`${pct(s.watch)} watched on average`);
  if (s.skip !== null) avgs.push(`${pct(s.skip)} skip in the first 3 s`);
  if (s.engagement !== null) avgs.push(`${(s.engagement * 100).toFixed(1)}% engagement`);
  if (avgs.length) head.push(avgs.join(" · "));
  const out = [...head, "", "Best:", ...measured.slice(0, CHANNEL_LISTED).map((r) => channelLine(r, projectId))];
  if (measured.length > CHANNEL_LISTED) out.push("", "Weakest:", ...measured.slice(-Math.min(CHANNEL_LISTED, measured.length - CHANNEL_LISTED)).map((r) => channelLine(r, projectId)));
  const insights = channelInsights(measured);
  out.push("", "What the best ones do differently:");
  if (insights.length) out.push(...insights.map((i) => `- ${i.title}: ${i.detail}`));
  else if (measured.length < MIN_INSIGHT_VIDEOS) out.push(`- too few measured videos to compare (${measured.length}; need ${MIN_INSIGHT_VIDEOS})`);
  else out.push("- no difference big enough to act on: the best and the rest hook, hold and run alike");
  out.push(
    "",
    "Use it to plan this video: keep what the best ones share (hook, length, pace), avoid what the weakest share. Open a specific video's moments with get_performance on that video; tell the user in a line or two what you are changing and why, citing the numbers.",
  );
  return out.join("\n");
}
