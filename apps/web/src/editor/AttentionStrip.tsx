import { useEffect, useMemo, useState } from "react";
import { ATTENTION_BIN, attentionCurve, attentionIssues, audienceDrops, compactCount, isShortFormSize, onScreenAt, SOCIAL_LABEL, type PostPerformance, type SocialPlatform } from "@motionily/protocol";
import { api } from "../api/client";
import { AttentionCurve } from "../components/AttentionCurve";
import type { Generation } from "../components/useGenerate";
import { ActivitySource, logActivity, useEditor } from "../store";
import { useSceneView } from "./sceneView";
import { useAgentName } from "../agentName";

/** The right-hand controls of both rows share a width, so the two curves share one time axis. */
const CONTROLS = "flex w-72 shrink-0 items-center justify-end gap-1";

/**
 * Short-form videos only (9:16, 4:5, 1:1): the attention curve measured from the scene (the same
 * numbers review_video gives the agent), the playhead, and where it breaks the sawtooth. One click
 * asks Claude to fix those spots. Once the video is posted, the real audience under it.
 */
export function AttentionStrip({ g, projectId, className = "" }: { g: Generation; projectId?: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <AttentionRow g={g} />
      {projectId && <AudienceRow g={g} projectId={projectId} />}
    </div>
  );
}

function AttentionRow({ g }: { g: Generation }) {
  const agent = useAgentName();
  const scene = useSceneView();
  const [width, height] = useEditor((s) => s.sceneSize);
  const time = useEditor((s) => s.time);
  const curve = useMemo(() => (scene ? attentionCurve(scene) : null), [scene]);
  const issues = useMemo(() => (scene ? attentionIssues({ ...scene, width, height }) : []), [scene, width, height]);
  const at = useMemo(() => curve?.bins.map((_, i) => (i + 0.5) * ATTENTION_BIN), [curve]);
  if (!scene?.layers.length || !curve || !isShortFormSize(width, height)) return null;

  const fix = async () => {
    const instruction = `Fix the attention curve of this short-form video, keeping everything else: ${issues.join("; ")}.`;
    if (await g.start(instruction)) logActivity(ActivitySource.Ask, `Whole video: fix the attention curve (${issues.length} ${issues.length === 1 ? "spot" : "spots"})`);
  };

  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[11px] text-neutral-500" title="How hard each moment grabs attention, measured from what enters, moves, cuts and sounds">
        Attention
      </span>
      <AttentionCurve values={curve.bins} at={at} duration={curve.duration} time={time} className="h-7 min-w-0 flex-1 text-emerald-300" />
      <div className={CONTROLS}>
        {issues.length ? (
          <button
            type="button"
            disabled={g.running}
            onClick={() => void fix()}
            title={issues.join("\n")}
            className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-amber-200 ring-1 ring-amber-200/30 hover:bg-amber-200/10 disabled:opacity-50"
          >
            {issues.length} to fix · Ask {agent}
          </button>
        ) : (
          <span className="shrink-0 text-[11px] text-emerald-400" title="Moving frame 0, re-hooks every 4-7 s, a pattern interrupt, an escalating finale">
            Holds attention
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The posted video's real audience on the same time axis: YouTube's retention curve, and ticks where
 * viewers leave (the 3-second skip, the end of the average view, the steepest falls). One click asks
 * the agent to rework those moments.
 */
function AudienceRow({ g, projectId }: { g: Generation; projectId: string }) {
  const agent = useAgentName();
  const scene = useSceneView();
  const time = useEditor((s) => s.time);
  const [posts, setPosts] = useState<PostPerformance[] | null>(null);
  const [pick, setPick] = useState<SocialPlatform | null>(null);
  useEffect(() => {
    api.performance(projectId).then(setPosts, () => setPosts(null));
  }, [projectId]);
  const post = posts?.find((p) => p.metrics.length);
  const m = post?.metrics.find((x) => x.platform === pick) ?? post?.metrics[0];
  const duration = typeof scene?.duration === "number" ? scene.duration : 0;
  const drops = useMemo(() => (m && duration ? audienceDrops(m, duration) : []), [m, duration]);
  if (!post || !m || !scene || duration <= 0) return null;

  const fix = async () => {
    const at = drops.map((d) => `${d.t.toFixed(1)}s (${d.why}; on screen: ${onScreenAt(scene, d.t).join(", ") || "nothing"})`).join("; ");
    const instruction = `Viewers leave this posted video on ${SOCIAL_LABEL[m.platform]} at: ${at}. Rework those moments to hold them (a re-hook just before each drop, the payoff earlier; a high early skip means the hook: frame 0 and the first line), keeping everything else. Call get_performance for every number.`;
    if (await g.start(instruction)) logActivity(ActivitySource.Ask, `Whole video: hold viewers where they leave on ${SOCIAL_LABEL[m.platform]}`);
  };
  const x = (t: number) => `${Math.min(100, (t / duration) * 100)}%`;
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[11px] text-neutral-500" title={post.outdated ? "Numbers of the posted cut: you edited the video since" : "How the posted video did"}>
        Audience{post.outdated ? "*" : ""}
      </span>
      <div className="relative h-7 min-w-0 flex-1">
        {m.retention ? (
          <AttentionCurve
            values={m.retention.map((v) => Math.min(1, v))}
            at={m.retention.map((_, i) => ((i + 1) / m.retention!.length) * duration)}
            duration={duration}
            time={time}
            className="absolute inset-0 h-full w-full text-sky-300"
          />
        ) : (
          <div className="absolute inset-x-0 top-1/2 h-px bg-neutral-700" />
        )}
        {drops.map((d) => (
          <span
            key={`${d.t}-${d.why}`}
            title={`${d.t.toFixed(1)} s · ${d.why}`}
            className="absolute top-0 h-full w-0.5 -translate-x-1/2 rounded-full bg-amber-300/80"
            style={{ left: x(d.t) }}
          />
        ))}
      </div>
      <div className={CONTROLS}>
        {post.metrics.map((o) => (
          <button
            key={o.platform}
            type="button"
            onClick={() => setPick(o.platform)}
            title={`${SOCIAL_LABEL[o.platform]}: ${compactCount(o.views)} views`}
            className={`rounded-full px-2 py-0.5 text-[11px] tabular-nums ${o.platform === m.platform ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-white"}`}
          >
            {compactCount(o.views)}
          </button>
        ))}
        {drops.length > 0 && (
          <button
            type="button"
            disabled={g.running}
            onClick={() => void fix()}
            title={drops.map((d) => `${d.t.toFixed(1)} s · ${d.why}`).join("\n")}
            className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-sky-200 ring-1 ring-sky-200/30 hover:bg-sky-200/10 disabled:opacity-50"
          >
            Hold them · Ask {agent}
          </button>
        )}
      </div>
    </div>
  );
}
