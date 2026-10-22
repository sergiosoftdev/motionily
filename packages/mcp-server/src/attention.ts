import { ATTENTION_BIN, attentionCurve, attentionIssues, attentionSparkline, isShortFormSize } from "@motionily/protocol";

/** Bins per mark of the sparkline in the report. */
const BINS_PER_MARK = 2;

/**
 * review_video's attention section for short-form videos (9:16, 4:5, 1:1): the measured curve as a
 * sparkline and where it breaks the sawtooth of docs/agent/craft.md. Empty for 16:9.
 */
export function attentionReport(scene: Record<string, unknown> | null): string {
  if (!scene || !isShortFormSize(Number(scene.width), Number(scene.height))) return "";
  const curve = attentionCurve(scene);
  const issues = attentionIssues(scene);
  const line = `attention curve (short-form sawtooth, one mark per ${ATTENTION_BIN * BINS_PER_MARK}s from 0s to ${curve.duration}s): ${attentionSparkline(curve.bins, BINS_PER_MARK)}`;
  return issues.length
    ? `${line}\nattention issues (fix them like lint, they decide whether people keep watching):\n- ${issues.join("\n- ")}`
    : `${line}\nattention: the sawtooth holds (moving frame 0, re-hooks, pattern interrupt, escalating finale, no fade-out).`;
}
