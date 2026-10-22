import { useMemo } from "react";
import { ATTENTION_BIN, attentionCurve, attentionIssues, isShortFormSize } from "@motionily/protocol";
import { AttentionCurve } from "../components/AttentionCurve";
import type { Generation } from "../components/useGenerate";
import { ActivitySource, logActivity, useEditor } from "../store";
import { useSceneView } from "./sceneView";

/**
 * Short-form videos only (9:16, 4:5, 1:1): the attention curve measured from the scene (the same
 * numbers review_video gives the agent), the playhead, and where it breaks the sawtooth. One click
 * asks Claude to fix those spots.
 */
export function AttentionStrip({ g, className = "" }: { g: Generation; className?: string }) {
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
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="shrink-0 text-[11px] text-neutral-500" title="How hard each moment grabs attention, measured from what enters, moves, cuts and sounds">
        Attention
      </span>
      <AttentionCurve values={curve.bins} at={at} duration={curve.duration} time={time} className="h-7 min-w-0 flex-1 text-emerald-300" />
      {issues.length ? (
        <button
          type="button"
          disabled={g.running}
          onClick={() => void fix()}
          title={issues.join("\n")}
          className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-amber-200 ring-1 ring-amber-200/30 hover:bg-amber-200/10 disabled:opacity-50"
        >
          {issues.length} to fix · Ask Claude
        </button>
      ) : (
        <span className="shrink-0 text-[11px] text-emerald-400" title="Moving frame 0, re-hooks every 4-7 s, a pattern interrupt, an escalating finale">
          Holds attention
        </span>
      )}
    </div>
  );
}
