/** Numbers for one frame of the self-review: how many layers show and how much of the frame text covers. */
import type { FrameLayout } from "@motionily/protocol";

export type FrameStats = { onScreen: number; textCover: number; quiet: number };

const area = (x0: number, y0: number, x1: number, y1: number) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);

export function frameStats(frame: FrameLayout, size: [number, number], textIds: Set<string>): FrameStats {
  const [w, h] = size;
  let onScreen = 0;
  let text = 0;
  for (const row of frame.layers) {
    if (!row.visible) continue;
    const [x0, y0, x1, y1] = row.screen;
    const inside = area(Math.max(x0, 0), Math.max(y0, 0), Math.min(x1, w), Math.min(y1, h));
    if (inside <= 0) continue;
    onScreen++;
    if (textIds.has(row.id)) text += inside;
  }
  return { onScreen, textCover: Math.round((text / (w * h)) * 100), quiet: 0 };
}
