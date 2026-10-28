import { engineHost } from "../engine/host";
import { exportVideo, type ExportResult } from "./exportVideo";

/** The editor's current scene as a video file, rendered frame by frame on the GPU (needs the editor's engine). */
export async function renderCurrentScene(o: {
  shortSide: number;
  range?: [number, number] | null;
  audioUrl: string | null;
  /** The hook variant to render (videos with several openings); the one playing by default. */
  variant?: string | null;
  onProgress: (ratio: number) => void;
  signal: AbortSignal;
}): Promise<ExportResult> {
  engineHost.pause();
  // Audio-reactive curves and video files must be ready before the first frame.
  await engineHost.mediaReady();
  return exportVideo({
    sceneJson: o.variant ? JSON.stringify({ ...JSON.parse(engineHost.sceneJson()), variant: o.variant }) : engineHost.sceneJson(),
    shortSide: o.shortSide,
    range: o.range ?? null,
    fonts: await engineHost.loadedFontFiles(),
    stage: await engineHost.stageAssets(),
    images: await engineHost.imageAssets(),
    luts: await engineHost.lutAssets(),
    audioUrl: o.audioUrl,
    videos: engineHost.videoLibrary(),
    onProgress: o.onProgress,
    signal: o.signal,
  });
}
