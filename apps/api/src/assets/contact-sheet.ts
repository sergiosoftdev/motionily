import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { MEDIA_DIR, MEDIA_PATH } from "../media";
import { AssetFormat, AssetKind, type AssetHit } from "./asset-types";
import { HEADERS, SOURCE_TIMEOUT_MS } from "./http";

/**
 * One numbered image per query instead of a thumbnail per hit: the agent compares candidates side
 * by side, and every cell is the same small size whatever the source serves (Openverse and stock
 * thumbnails are often 600 px wide).
 */
const COLS = 4;
const CELL: Record<AssetKind, [number, number]> = {
  [AssetKind.Photo]: [240, 180],
  [AssetKind.Texture]: [200, 150],
  [AssetKind.Footage]: [240, 180],
  [AssetKind.Logo]: [200, 130],
};
const GAP = 6;
const PAD = 6;
/** Logos sit on mid-light grey so black and white marks both read. */
const LOGO_BG = { r: 205, g: 205, b: 205 };
const SHEET_BG = { r: 24, g: 24, b: 24 };
const MAX_THUMB_BYTES = 4 * 1024 * 1024;
const LOGO_DENSITY = 144;

/** 3×5 pixel glyphs for labels, drawn as rects (no fonts needed on the server). */
const GLYPHS: Record<string, string> = {
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001111001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001010010010",
  "8": "111101111101111",
  "9": "111101111001111",
  s: "000011110001110",
  ".": "000000000000010",
  ":": "000010000010000",
};
const PX = 3;

/** A white label on a black box, as SVG elements at (x, y). */
function label(text: string, x: number, y: number) {
  const chars = [...text].filter((c) => GLYPHS[c]);
  const w = chars.length * 4 * PX + PX;
  const rects = chars.flatMap((c, i) =>
    [...GLYPHS[c]!].flatMap((bit, k) => (bit === "1" ? [`<rect x="${x + PX + i * 4 * PX + (k % 3) * PX}" y="${y + PX + Math.floor(k / 3) * PX}" width="${PX}" height="${PX}"/>`] : [])),
  );
  return `<rect x="${x}" y="${y}" width="${w}" height="${7 * PX}" fill="#000" fill-opacity="0.85"/><g fill="#fff">${rects.join("")}</g>`;
}

async function fetchThumb(url: string): Promise<Buffer | null> {
  if (!url) return null;
  // Library items: their preview is already on disk.
  if (MEDIA_PATH.test(url)) return readFile(join(MEDIA_DIR, url.slice("/media/".length))).catch(() => null);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length <= MAX_THUMB_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/** A JPEG grid of the hits, numbered from `first` (left to right, top to bottom); null when none could be fetched. */
export async function contactSheet(hits: AssetHit[], kind: AssetKind, first: number): Promise<Buffer | null> {
  if (!hits.length) return null;
  const [cw, ch] = CELL[kind];
  const cols = Math.min(COLS, hits.length);
  const rows = Math.ceil(hits.length / cols);
  const width = PAD * 2 + cols * cw + (cols - 1) * GAP;
  const height = PAD * 2 + rows * ch + (rows - 1) * GAP;
  const thumbs = await Promise.all(hits.map((h) => fetchThumb(h.thumb)));
  if (!thumbs.some(Boolean)) return null;
  const cellBg = kind === AssetKind.Logo ? LOGO_BG : { r: 40, g: 40, b: 40 };
  const layers: sharp.OverlayOptions[] = [];
  const labels: string[] = [];
  await Promise.all(
    hits.map(async (h, i) => {
      const x = PAD + (i % cols) * (cw + GAP);
      const y = PAD + Math.floor(i / cols) * (ch + GAP);
      const bytes = thumbs[i];
      let cell: Buffer | null = null;
      if (bytes) {
        try {
          const inset = kind === AssetKind.Logo ? 14 : 0;
          cell = await sharp(bytes, { density: h.format === AssetFormat.Svg ? LOGO_DENSITY : undefined })
            .resize(cw - inset * 2, ch - inset * 2, { fit: kind === AssetKind.Logo ? "contain" : "cover", background: { ...cellBg, alpha: kind === AssetKind.Logo ? 0 : 1 } })
            .extend({ top: inset, bottom: inset, left: inset, right: inset, background: { ...cellBg, alpha: 0 } })
            .flatten({ background: cellBg })
            .png()
            .toBuffer();
        } catch {
          cell = null;
        }
      }
      layers.push({ input: cell ?? { create: { width: cw, height: ch, channels: 3, background: cellBg } }, left: x, top: y });
      labels.push(label(String(first + i), x + 4, y + 4));
      if (h.duration) labels.push(label(`${Math.round(h.duration)}s`, x + cw - 4 - (String(Math.round(h.duration)).length + 1) * 4 * PX - PX, y + ch - 4 - 7 * PX));
    }),
  );
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels.join("")}</svg>`);
  return sharp({ create: { width, height, channels: 3, background: SHEET_BG } })
    .composite([...layers, { input: svg, left: 0, top: 0 }])
    .jpeg({ quality: 78 })
    .toBuffer();
}
