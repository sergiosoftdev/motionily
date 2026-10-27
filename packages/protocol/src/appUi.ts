/**
 * Where each app draws its own UI over a vertical video (approximate, from their current layouts), on a
 * 1080×1920 reference frame. The viewer paints these zones; the write-time lint keeps text out of the
 * buttons and the caption band of TikTok and Reels, the two places a vertical video is posted first.
 */
export const APP_UI_REF: [number, number] = [1080, 1920];

export const AppUiPlatform = { TikTok: "tiktok", Reels: "reels", Shorts: "shorts" } as const;
export type AppUiPlatform = (typeof AppUiPlatform)[keyof typeof AppUiPlatform];

export const AppUiKind = { Top: "top", Buttons: "buttons", Caption: "caption" } as const;
export type AppUiKind = (typeof AppUiKind)[keyof typeof AppUiKind];

export type AppUiZone = { kind: AppUiKind; box: [x0: number, y0: number, x1: number, y1: number]; label: string };

export const APP_UI: Record<AppUiPlatform, { zones: AppUiZone[]; safe: [number, number, number, number] }> = {
  tiktok: {
    zones: [
      { kind: AppUiKind.Top, box: [0, 0, 1080, 150], label: "Top bar · Following / For You" },
      { kind: AppUiKind.Buttons, box: [940, 720, 1080, 1500], label: "Buttons" },
      { kind: AppUiKind.Caption, box: [0, 1500, 1080, 1920], label: "Username · caption · sound · nav bar" },
    ],
    safe: [60, 150, 940, 1500],
  },
  reels: {
    zones: [
      { kind: AppUiKind.Top, box: [0, 0, 1080, 210], label: "Top bar · Reels · camera" },
      { kind: AppUiKind.Buttons, box: [950, 900, 1080, 1560], label: "Buttons" },
      { kind: AppUiKind.Caption, box: [0, 1560, 1080, 1920], label: "Username · caption · audio · nav bar" },
    ],
    safe: [60, 210, 950, 1560],
  },
  shorts: {
    zones: [
      { kind: AppUiKind.Top, box: [0, 0, 1080, 140], label: "Top bar · search" },
      { kind: AppUiKind.Buttons, box: [900, 820, 1080, 1480], label: "Buttons" },
      { kind: AppUiKind.Caption, box: [0, 1480, 1080, 1920], label: "Title · channel · sound · nav bar" },
    ],
    safe: [60, 140, 900, 1480],
  },
};

/** The zones text must stay out of on a vertical video: the buttons and the caption band of TikTok and Reels. */
export const TEXT_BLOCKING_ZONES: AppUiZone[] = [APP_UI.tiktok, APP_UI.reels].flatMap((p) =>
  p.zones.filter((z) => z.kind === AppUiKind.Buttons || z.kind === AppUiKind.Caption),
);

/** A frame this close to 9:16 is a vertical video the apps lay their UI over. */
export function isVerticalFeed([w, h]: [number, number]): boolean {
  return Math.abs(h / w - 16 / 9) < 0.02;
}
