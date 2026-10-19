/** What the editor should do by itself when it opens a video the wizard just created. */
export const VideoPipeline = {
  /** Start the agent right away. */
  Generate: "generate",
  /** Transcribe the uploaded voice into captions first, then start the agent. */
  TranscribeThenGenerate: "transcribe_then_generate",
} as const;
export type VideoPipeline = (typeof VideoPipeline)[keyof typeof VideoPipeline];

const KEY = "motionily.pipeline";
/** Fired on window when the agent should start (e.g. captions are ready). */
export const GENERATE_EVENT = "motionily:generate";

export function requestPipeline(projectId: string, pipeline: VideoPipeline) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ projectId, pipeline }));
  } catch {
    // Storage blocked: the user presses Generar themselves.
  }
}

/** The pending pipeline for this project, consumed once. */
export function takePipeline(projectId: string, pipeline: VideoPipeline): boolean {
  try {
    const raw = sessionStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as { projectId: string; pipeline: VideoPipeline }) : null;
    if (p?.projectId !== projectId || p.pipeline !== pipeline) return false;
    sessionStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function startGenerate(projectId: string) {
  window.dispatchEvent(new CustomEvent(GENERATE_EVENT, { detail: projectId }));
}
