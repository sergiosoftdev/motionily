/**
 * Write-time lint: the checks an agent would otherwise only meet in review, computed from the
 * engine's layout (where every layer lands, in scene px) and the palette. Each issue carries the
 * exact ops that fix it, so a small model applies a patch instead of working out coordinates.
 */
import type { FrameLayout, LayoutRow } from "@motionily/protocol";

export type Palette = { background: string; surface: string; primary: string; accent: string; text: string };
export type Layer = Record<string, unknown>;
export type Op = Record<string, unknown>;

export type IssueKind = "off_frame" | "tiny_text" | "text_overlap" | "low_contrast" | "place_missing";
export type Issue = { kind: IssueKind; id: string; times: number[]; message: string; fix?: Op[] };

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;
/** Same rule as the review and the engine's readable text (26 px on a 1080 frame). */
export const MIN_TEXT_SHARE = 0.024;
/** Share of a layer outside the frame before it is reported (a sliver off edge is intended). */
const OFF_SHARE = 0.1;
/** Overlap of two text boxes, as a share of the smaller one, that reads as a collision. */
const TEXT_OVERLAP = 0.08;

const SLOTS = ["background", "surface", "primary", "accent", "text"] as const;
type Slot = (typeof SLOTS)[number];

/** `#rgb`, `#rrggbb` or `#rrggbbaa` to `#rrggbb`; null for anything else. */
function hex6(v: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return `#${h.slice(0, 6).toLowerCase()}`;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The candidate that reads best on `bg`: the palette text, white or a near-black ink. Mirrors `on_*` in the engine. */
export function readableOn(bg: string, palette: Palette): string {
  const candidates = [hex6(palette.text) ?? "#0f1733", "#ffffff", "#121219"];
  return candidates.reduce((best, c) => (contrast(c, bg) > contrast(best, bg) ? c : best));
}

/** A color value of a layer (`fill`, `accent`…) as hex: a hex, a palette slot, an `on_*` token, or an animated list (first key). */
export function resolveColor(v: unknown, palette: Palette): string | null {
  if (Array.isArray(v)) return resolveColor((v[0] as { c?: unknown } | undefined)?.c, palette);
  if (typeof v !== "string") return null;
  if (v.startsWith("#")) return hex6(v);
  if (SLOTS.includes(v as Slot)) return hex6(palette[v as Slot]);
  const on = /^on_(background|surface|primary|accent)$/.exec(v);
  if (on) return readableOn(hex6(palette[on[1] as Slot]) ?? "#ffffff", palette);
  return null;
}

const area = (x0: number, y0: number, x1: number, y1: number) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);

/** Area of a screen box inside the frame. */
function insideArea(row: LayoutRow, [w, h]: [number, number]): number {
  const [x0, y0, x1, y1] = row.screen;
  return area(Math.max(x0, 0), Math.max(y0, 0), Math.min(x1, w), Math.min(y1, h));
}

const fmtTimes = (ts: number[]) => ts.map((t) => `${+t.toFixed(2)}s`).join(",");

export type LintInput = { layers: Layer[]; frames: FrameLayout[]; palette: Palette; size: [number, number] };

/** Issues for the given frames (layout at several instants). Repeated findings merge into one issue. */
export function lintLayers({ layers, frames, palette, size }: LintInput): Issue[] {
  const [w, h] = size;
  const short = Math.min(w, h);
  const byId = new Map(layers.map((l, i) => [String(l.id), { layer: l, index: i }]));
  const issues = new Map<string, Issue>();
  const add = (key: string, issue: Omit<Issue, "times">, t: number | null) => {
    const prev = issues.get(key);
    if (prev) {
      if (t !== null && !prev.times.includes(t)) prev.times.push(t);
      return;
    }
    issues.set(key, { ...issue, times: t === null ? [] : [t] });
  };

  for (const [id, { layer }] of byId) {
    const place = layer.place as { of?: string } | undefined;
    if (place?.of && !byId.has(place.of)) add(`place:${id}`, { kind: "place_missing", id, message: `'${id}' is placed relative to '${place.of}', which does not exist` }, null);
    const size = layer.size;
    if (layer.type === "text" && typeof size === "number" && size < short * MIN_TEXT_SHARE) {
      const min = Math.ceil(short * MIN_TEXT_SHARE);
      add(`tiny:${id}`, { kind: "tiny_text", id, message: `text '${id}' is ${size}px on a ${short}px frame: too small to read on a phone (at least ${min}px)`, fix: [{ op: "patch", id, fields: { size: min } }] }, null);
    }
  }

  for (const frame of frames) {
    const t = frame.t;
    const rows = new Map(frame.layers.map((r) => [r.id, r]));
    const texts: { id: string; row: LayoutRow }[] = [];
    for (const [id, { layer, index }] of byId) {
      const row = rows.get(id);
      if (!row || !row.visible || frame.camera) continue;
      const [x0, y0, x1, y1] = row.screen;
      const total = area(x0, y0, x1, y1);
      const inside = insideArea(row, size);
      // Entirely off screen is normal (waiting to enter); a box mostly past an edge is the bug.
      if (total > 0 && inside > 0 && 1 - inside / total > OFF_SHARE) {
        const fields: Record<string, unknown> = {};
        if (typeof layer.x === "number" && !layer.parent) {
          if (x0 < 0) fields.x = +((layer.x as number) - x0).toFixed(1);
          else if (x1 > w) fields.x = +((layer.x as number) - (x1 - w)).toFixed(1);
          if (y0 < 0) fields.y = +((layer.y as number) - y0).toFixed(1);
          else if (y1 > h) fields.y = +((layer.y as number) - (y1 - h)).toFixed(1);
        }
        const pct = Math.round((1 - inside / total) * 100);
        add(`off:${id}`, { kind: "off_frame", id, message: `'${id}' is ${pct}% off the frame`, fix: Object.keys(fields).length ? [{ op: "patch", id, fields }] : undefined }, t);
      }
      if (layer.type === "text") texts.push({ id, row });
      if (layer.type === "text" && !layer.gradient) {
        const fill = layer.fill ?? "primary";
        const ink = resolveColor(fill, palette);
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        // What the text sits on: the topmost non-text layer behind it at its center, else the background.
        let behind: { id: string; fill: unknown } | null = null;
        for (const [bid, b] of byId) {
          if (b.index >= index || b.layer.type === "text") continue;
          const br = rows.get(bid);
          if (!br || !br.visible) continue;
          const [bx0, by0, bx1, by1] = br.screen;
          if (cx >= bx0 && cx <= bx1 && cy >= by0 && cy <= by1 && (!behind || b.index > byId.get(behind.id)!.index)) behind = { id: bid, fill: b.layer.fill };
        }
        const bgHex = behind ? resolveColor(behind.fill ?? "surface", palette) : hex6(palette.background);
        if (ink && bgHex) {
          const ratio = contrast(ink, bgHex);
          if (ratio < MIN_CONTRAST) {
            const slot = behind && typeof behind.fill === "string" && SLOTS.includes(behind.fill as Slot) ? (behind.fill as string) : behind ? null : "background";
            const token = slot ? `on_${slot}` : readableOn(bgHex, palette);
            const where = behind ? `on '${behind.id}'` : "on the background";
            add(`contrast:${id}`, {
              kind: "low_contrast",
              id,
              message: `text '${id}' reads ${ratio.toFixed(1)}:1 ${where} (WCAG needs ${MIN_CONTRAST}:1)`,
              fix: [{ op: "patch", id, fields: { fill: token } }],
            }, t);
          }
        }
      }
    }
    for (let a = 0; a < texts.length; a++)
      for (let b = a + 1; b < texts.length; b++) {
        const [p, q] = [texts[a]!, texts[b]!];
        const [px0, py0, px1, py1] = p.row.screen;
        const [qx0, qy0, qx1, qy1] = q.row.screen;
        const ov = area(Math.max(px0, qx0), Math.max(py0, qy0), Math.min(px1, qx1), Math.min(py1, qy1));
        const small = Math.min(area(px0, py0, px1, py1), area(qx0, qy0, qx1, qy1));
        if (small > 0 && ov / small > TEXT_OVERLAP) {
          const [first, second] = [p.id, q.id].sort();
          add(`overlap:${first}:${second}`, { kind: "text_overlap", id: `${first}+${second}`, message: `text '${first}' and '${second}' overlap: place one with place=below:${first} (or move it)` }, t);
        }
      }
  }
  return [...issues.values()];
}

/** One line per issue, with the exact ops that fix it when there are some. */
export function formatIssues(issues: Issue[]): string[] {
  return issues.map((i) => {
    const when = i.times.length ? ` at ${fmtTimes(i.times)}` : "";
    const fix = i.fix?.length ? ` · fix: ${JSON.stringify(i.fix)}` : "";
    return `LINT ${i.kind}: ${i.message}${when}${fix}`;
  });
}
