import sharp from "sharp";

/**
 * SVG files from outside (Commons, Iconify, the web) are kept for add_vector and rendered to PNG
 * for image layers. They are served from /media, so anything that could run is stripped first.
 */
export const MAX_SVG_BYTES = 3 * 1024 * 1024;
/** Long side of the PNG rendering: sharp at any size up to a full-frame logo. */
const RASTER_PX = 2048;
const PREVIEW_PX = 480;
const BASE_DPI = 72;
const MAX_DENSITY = 50000;

export function sanitizeSvg(text: string): string {
  if (text.length > MAX_SVG_BYTES) throw new Error("SVG too large");
  // Entities can expand without bound (and reach the file system in some parsers).
  if (/<!ENTITY/i.test(text)) throw new Error("SVG with entity declarations refused");
  if (!/<svg[\s>]/i.test(text)) throw new Error("not an SVG");
  return text
    .replace(/<\?xml-stylesheet[^>]*>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(xlink:)?href\s*=\s*("|')\s*(javascript|https?|file|ftp):[^"']*\2/gi, "")
    .replace(/url\(\s*['"]?\s*(javascript|https?|file):[^)]*\)/gi, "none");
}

/** PNG renderings of an SVG: a big one for image layers and a small one for the agent to look at. */
export async function rasterizeSvg(svg: string) {
  const bytes = Buffer.from(svg);
  const meta = await sharp(bytes, { density: BASE_DPI }).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0) || 300;
  const render = async (px: number) => {
    const density = Math.min(MAX_DENSITY, Math.max(1, (BASE_DPI * px) / longest));
    return sharp(bytes, { density }).resize(px, px, { fit: "inside", withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true });
  };
  const [full, small] = await Promise.all([render(RASTER_PX), render(PREVIEW_PX)]);
  return { png: full.data, width: full.info.width, height: full.info.height, preview: small.data };
}
