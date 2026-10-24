/** Output sizes, by the frame's short side (height of a vertical or square video, width of a wide one). */
export const RESOLUTIONS = [
  { shortSide: 720, label: "720p" },
  { shortSide: 1080, label: "1080p" },
  { shortSide: 1440, label: "1440p" },
  { shortSide: 2160, label: "4K" },
] as const;
export const DEFAULT_SHORT_SIDE = 1080;

const key = (projectId: string) => `motionily.resolution.${projectId}`;

/** The project's output resolution (Project settings), used as the export's default. */
export function projectResolution(projectId: string | undefined): number {
  try {
    const v = projectId ? Number(localStorage.getItem(key(projectId))) : 0;
    return RESOLUTIONS.some((r) => r.shortSide === v) ? v : DEFAULT_SHORT_SIDE;
  } catch {
    return DEFAULT_SHORT_SIDE;
  }
}

export function setProjectResolution(projectId: string, shortSide: number) {
  try {
    localStorage.setItem(key(projectId), String(shortSide));
  } catch {
    // Storage blocked: the export keeps its own default.
  }
}
