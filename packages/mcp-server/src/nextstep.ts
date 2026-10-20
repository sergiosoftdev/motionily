/**
 * `next_step`: from the project's state, the one or two things to do now. A small model gets the
 * order of the workflow from the state instead of having to remember it.
 */
export type ProjectState = {
  layers: number;
  duration: number;
  sfx: number;
  editsSinceReview: boolean;
  reviewed: boolean;
  lintIds: string[];
  pastEnd: string[];
  checkpoints: number;
};

export function nextSteps(s: ProjectState): string[] {
  if (!s.layers) return ["No layers yet: get_project and get_brand, then add_layers: the world and background first, then one add_layers per beat."];
  const steps: string[] = [];
  if (s.pastEnd.length) steps.push(`Layers start after the video ends (${s.pastEnd.slice(0, 5).join(", ")}): move their start with apply_ops set_timing, or extend the duration.`);
  if (s.lintIds.length) steps.push(`Lint issues open (${s.lintIds.slice(0, 6).join(", ")}): apply the fix ops printed with the last write.`);
  if (s.editsSinceReview) steps.push(s.reviewed ? "Edits since the last review: review_video before you finish." : "Not reviewed yet: review_video once the beats are in.");
  if (!s.sfx && s.duration >= 4) steps.push("No sound: list_sounds, then add_sfx for the entrances and the payoff.");
  if (s.layers > 15 && !s.checkpoints) steps.push("Big scene: checkpoint save NAME before a risky change, so you can restore it.");
  if (!steps.length) steps.push("Looks complete: render_frames on two or three key moments, then tell the user what you made.");
  return steps;
}
