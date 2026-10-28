import { useEffect, useMemo, useState } from "react";
import {
  activeVariant,
  ATTENTION_BIN,
  attentionCurve,
  attentionIssues,
  audienceDrops,
  compactCount,
  HOOK_SECONDS,
  isShortFormSize,
  newHookOps,
  onScreenAt,
  OpName,
  sceneVariants,
  SOCIAL_LABEL,
  type Op,
  type PostPerformance,
  type SocialPlatform,
  variantHook,
} from "@motionily/protocol";
import { apply } from "../editing/direct";
import { api } from "../api/client";
import { AttentionCurve } from "../components/AttentionCurve";
import { LinkPublishedDialog } from "../social/Published";
import type { Generation } from "../components/useGenerate";
import { ActivitySource, logActivity, useEditor } from "../store";
import { useSceneView } from "./sceneView";
import { useAgentName } from "../agentName";

/** Right-hand controls of a row (the strip is a grid: label, curve, controls, so both curves share one time axis). */
const CONTROLS = "flex items-center justify-end gap-1";

/**
 * Short-form videos only (9:16, 4:5, 1:1): the attention curve measured from the scene (the same
 * numbers review_video gives the agent), the playhead, and where it breaks the sawtooth. One click
 * asks Claude to fix those spots. Once the video is posted, the real audience under it.
 */
export function AttentionStrip({ g, projectId, className = "" }: { g: Generation; projectId?: string; className?: string }) {
  return (
    <div className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 ${className}`}>
      <AttentionRow g={g} />
      <HookRow g={g} />
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
    <div className="contents">
      <span className="text-[11px] text-neutral-500" title="How hard each moment grabs attention, measured from what enters, moves, cuts and sounds">
        Attention
      </span>
      <AttentionCurve values={curve.bins} at={at} duration={curve.duration} time={time} className="h-7 w-full min-w-0 text-emerald-300" />
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
 * Hook variants: one video with several openings, to post a different one on each platform and see
 * which holds. Chips switch the one playing (and exported); "Another hook" copies the opening into a
 * new variant to rewrite, or the agent writes one.
 */
function HookRow({ g }: { g: Generation }) {
  const agent = useAgentName();
  const scene = useSceneView();
  const [width, height] = useEditor((s) => s.sceneSize);
  const [note, setNote] = useState<string | null>(null);
  if (!scene?.layers.length) return null;
  const variants = sceneVariants(scene);
  if (!variants.length && !isShortFormSize(width, height)) return null;
  const playing = activeVariant(scene);

  const copy = () => {
    const made = newHookOps(scene);
    if (!made) return setNote(`Nothing on screen in the first ${HOOK_SECONDS} s to copy: ask ${agent} for another hook.`);
    setNote(`Hook ${made.variant} is a copy: click its text in the video to change it, or ask ${agent}.`);
    apply(made.ops, `Hook ${made.variant}: a copy of the opening to rewrite`);
  };
  const ask = async () => {
    const next = variants.length ? `variant ${String.fromCharCode(65 + variants.length)}` : "variant B (mark the current opening's layers variant=A first)";
    const instruction = `Write another hook for this video as ${next}: the first ${HOOK_SECONDS} s only, a different angle (a question instead of a statement, the payoff first, a bold claim…), everything after the hook unchanged. Then show it with set_variant.`;
    if (await g.start(instruction)) logActivity(ActivitySource.Ask, "Another hook to test");
  };
  const remove = (v: string) => {
    const ops: Op[] = scene.layers.filter((l) => l.variant === v).map((l) => ({ op: OpName.RemoveLayer, id: l.id }));
    const left = variants.filter((x) => x !== v);
    // A single variant left is just the opening again.
    if (left.length === 1) ops.push({ op: OpName.SetVariant, variant: null }, { op: OpName.Patch, ids: scene.layers.filter((l) => l.variant === left[0]).map((l) => l.id), fields: { variant: null } });
    apply(ops, `Hook ${v} removed`);
  };

  return (
    <div className="contents">
      <span className="text-[11px] text-neutral-500" title="Several openings for the same video: post a different one on each platform and Stats says which hooks better">
        Hook
      </span>
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {variants.length ? (
          variants.map((v) => (
            <span key={v} className={`group flex shrink-0 items-center rounded-full text-[11px] ring-1 ${v === playing ? "bg-white/10 text-white ring-white/20" : "text-neutral-400 ring-white/10 hover:text-white"}`}>
              <button type="button" onClick={() => apply([{ op: OpName.SetVariant, variant: v }], `Showing hook ${v}`)} title={`Show and export hook ${v}`} className="flex max-w-56 items-center gap-1.5 py-0.5 pr-1 pl-2.5">
                <b className="font-semibold">{v}</b>
                <span className="truncate">{variantHook(scene, v) || "…"}</span>
              </button>
              <button type="button" onClick={() => remove(v)} title={`Remove hook ${v}`} aria-label={`Remove hook ${v}`} className="pr-2 text-neutral-500 opacity-0 group-hover:opacity-100 hover:text-white">
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="truncate text-[11px] text-neutral-600">{note ?? "Test more than one opening: post a different hook on each platform."}</span>
        )}
        {variants.length > 0 && note && <span className="truncate text-[11px] text-amber-200/80">{note}</span>}
      </div>
      <div className={CONTROLS}>
        <button type="button" onClick={copy} title={`Copy the first ${HOOK_SECONDS} s into a new hook to rewrite`} className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-neutral-300 ring-1 ring-white/15 hover:bg-white/5">
          + Another hook
        </button>
        <button type="button" disabled={g.running} onClick={() => void ask()} className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-violet-200 ring-1 ring-violet-200/30 hover:bg-violet-200/10 disabled:opacity-50">
          Ask {agent}
        </button>
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
  const [connected, setConnected] = useState(false);
  const [linking, setLinking] = useState(false);
  const load = () => api.performance(projectId).then(setPosts, () => setPosts(null));
  useEffect(() => {
    void load();
    api.socialAccounts().then((r) => setConnected(r.accounts.some((a) => a.connected)), () => undefined);
  }, [projectId]);
  const post = posts?.find((p) => p.metrics.length);
  const m = post?.metrics.find((x) => x.platform === pick) ?? post?.metrics[0];
  const duration = typeof scene?.duration === "number" ? scene.duration : 0;
  const drops = useMemo(() => (m && duration ? audienceDrops(m, duration) : []), [m, duration]);
  const dialog = linking && (
    <LinkPublishedDialog
      projectId={projectId}
      onClose={() => setLinking(false)}
      onLinked={() => {
        setLinking(false);
        void load();
      }}
    />
  );
  // Not posted from the calendar: it may have been posted by hand. Offer to link it.
  if ((!post || !m) && posts !== null && connected && scene?.layers?.length)
    return (
      <div className="contents">
        <span className="text-[11px] text-neutral-500">Audience</span>
        <span className="text-[11px] text-neutral-600">Posted it already?</span>
        <div className={CONTROLS}>
          <button type="button" onClick={() => setLinking(true)} className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-neutral-300 ring-1 ring-white/15 hover:bg-white/5">
            Link the posted video
          </button>
        </div>
        {dialog}
      </div>
    );
  if (!post || !m || !scene || duration <= 0) return null;

  const fix = async () => {
    const at = drops.map((d) => `${d.t.toFixed(1)}s (${d.why}; on screen: ${onScreenAt(scene, d.t).join(", ") || "nothing"})`).join("; ");
    const instruction = `Viewers leave this posted video on ${SOCIAL_LABEL[m.platform]} at: ${at}. Rework those moments to hold them (a re-hook just before each drop, the payoff earlier; a high early skip means the hook: frame 0 and the first line), keeping everything else. Call get_performance for every number.`;
    if (await g.start(instruction)) logActivity(ActivitySource.Ask, `Whole video: hold viewers where they leave on ${SOCIAL_LABEL[m.platform]}`);
  };
  const x = (t: number) => `${Math.min(100, (t / duration) * 100)}%`;
  return (
    <div className="contents">
      <span className="text-[11px] text-neutral-500" title={post.outdated ? "Numbers of the posted cut: you edited the video since" : "How the posted video did"}>
        Audience{post.outdated ? "*" : ""}
      </span>
      <div className="relative h-7 w-full min-w-0">
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
        {connected && (
          <button type="button" onClick={() => setLinking(true)} title="Link another posted copy (another platform)" className="rounded-full px-1.5 py-0.5 text-[11px] text-neutral-500 hover:text-white">
            +
          </button>
        )}
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
      {dialog}
    </div>
  );
}
