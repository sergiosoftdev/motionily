import { API_URL } from "../api/client";

/** Font files bundled in public/fonts (OFL), by family and weight. The engine renders text with these. */
const FONT_FILES: Record<string, Record<number, string>> = {
  Inter: { 500: "Inter-500.ttf", 700: "Inter-700.ttf" },
  "Space Grotesk": { 500: "SpaceGrotesk-500.ttf", 700: "SpaceGrotesk-700.ttf" },
  "Baloo 2": { 500: "Baloo2-500.ttf", 800: "Baloo2-800.ttf" },
  "Dela Gothic One": { 400: "DelaGothicOne-400.ttf" },
  Fraunces: { 500: "Fraunces-500.ttf", 700: "Fraunces-700.ttf" },
  "Plus Jakarta Sans": { 500: "PlusJakartaSans-500.ttf", 700: "PlusJakartaSans-700.ttf" },
};

export const DEFAULT_FONT_FAMILY = "Inter";

export type FontFile = { family: string; weight: number; url: string };

/**
 * Files for a family: bundled ones when we ship them, otherwise any Google Font
 * through the API (it converts to TTF and caches), at the weights the text uses.
 */
export function fontFilesFor(family: string, weights: number[] = [500, 700]): FontFile[] {
  const bundled = FONT_FILES[family];
  if (bundled) return Object.entries(bundled).map(([w, file]) => ({ family, weight: Number(w), url: `/fonts/${file}` }));
  return [...new Set(weights)].map((weight) => ({
    family,
    weight,
    url: `${API_URL}/fonts/file?${new URLSearchParams({ family, weight: String(weight) })}`,
  }));
}
