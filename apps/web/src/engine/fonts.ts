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

/** Weight 3D text uses when its node names a family but no weight (mirrors scene::glyphs::DEFAULT_WEIGHT). */
const TEXT3D_DEFAULT_WEIGHT = 700;

/** Fonts that 3D text nodes (`{"shape":"text","family":…}`) ask for by name, anywhere in a scene or ops. */
export function text3dFonts(value: unknown, out: Map<string, Set<number>> = new Map()): Map<string, Set<number>> {
  if (Array.isArray(value)) value.forEach((v) => text3dFonts(v, out));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.shape === "text" && typeof o.family === "string") {
      const weights = out.get(o.family) ?? new Set<number>();
      weights.add(typeof o.weight === "number" ? o.weight : TEXT3D_DEFAULT_WEIGHT);
      out.set(o.family, weights);
    }
    Object.values(o).forEach((v) => text3dFonts(v, out));
  }
  return out;
}
