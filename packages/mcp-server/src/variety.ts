/**
 * Sameness check for review_video: how this video compares with the account's latest ones (font,
 * main hue, genre). An agent left alone repeats its favorite serif and its favorite red; this says
 * so while there is still time to change.
 */
import type { Direction, Fingerprint } from "@motionily/protocol";

/** Hues closer than this (degrees) read as the same color family. */
const SAME_HUE = 18;
/** Below this saturation a color is a neutral: its hue says nothing. */
const MIN_SATURATION = 0.25;

function hsl(hex: string | null | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? "");
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

export function varietyNotes(scene: { typography?: { family?: string }; palette?: { primary?: string } } | null, direction: Direction | null, all: Fingerprint[]): string[] {
  // Favorites are the user's taste, not repetition to avoid.
  const recent = all.filter((r) => !r.favorite);
  const notes: string[] = [];
  const font = scene?.typography?.family;
  if (font) {
    const same = recent.filter((r) => r.font === font).map((r) => `"${r.name}"`);
    if (same.length) notes.push(`font ${font} was also used by ${same.join(", ")}: pick a family that belongs to THIS story (search_fonts)`);
  }
  const mine = hsl(scene?.palette?.primary);
  if (mine && mine[1] >= MIN_SATURATION) {
    const same = recent.filter((r) => {
      const h = hsl(r.primary);
      return h && h[1] >= MIN_SATURATION && hueGap(h[0], mine[0]) < SAME_HUE;
    });
    if (same.length >= 2) notes.push(`primary ${scene!.palette!.primary} is the same color family as ${same.map((r) => `"${r.name}" (${r.primary})`).join(", ")}: this video needs its own color`);
  }
  if (direction) {
    const sameGenre = recent.slice(0, 2).filter((r) => r.genre === direction.genre);
    if (sameGenre.length === 2) notes.push(`genre ${direction.genre} again (the last two videos used it): make sure the techniques differ, or choose another genre`);
  }
  return notes;
}
