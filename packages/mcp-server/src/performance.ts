/**
 * get_performance: how this video did where it was posted, with each moment the audience leaves
 * mapped to what was on screen then, so the agent edits the moment and not the whole video.
 */
import { attentionSparkline, audienceDrops, compactCount, onScreenAt, SOCIAL_LABEL, type PostMetrics, type PostPerformance } from "@motionily/protocol";

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
