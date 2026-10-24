import { DEFAULT_OUTPUT, OUTPUT_SHORT_SIDES, type Output } from "@motionily/protocol";
import { engineHost } from "../engine/host";

/** Output sizes, by the frame's short side (height of a vertical or square video, width of a wide one). */
const LABEL: Record<number, string> = { 720: "720p", 1080: "1080p", 1440: "1440p", 2160: "4K", 4320: "8K" };
export const RESOLUTIONS = OUTPUT_SHORT_SIDES.map((shortSide) => ({ shortSide, label: LABEL[shortSide]! }));

/** The scene's export settings (Project settings, `set_output`), with the defaults filled in. */
export function sceneOutput(): Output {
  try {
    const s = JSON.parse(engineHost.sceneJson()) as { output?: Partial<Output> | null };
    return { ...DEFAULT_OUTPUT, ...(s.output ?? {}) };
  } catch {
    return DEFAULT_OUTPUT;
  }
}
