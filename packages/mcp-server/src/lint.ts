/**
 * Write-time lint: the checks an agent would otherwise only meet in review, computed from the
 * engine's layout (where every layer lands, in scene px) and the palette. Each issue carries the
 * exact ops that fix it, so a small model applies a patch instead of working out coordinates.
 */
import { APP_UI_REF, AppUiKind, TEXT_BLOCKING_ZONES, isVerticalFeed, type FrameLayout, type LayoutRow } from "@motionily/protocol";

export type Palette = { background: string; surface: string; primary: string; accent: string; text: string };
export type Layer = Record<string, unknown>;
export type Op = Record<string, unknown>;

export type IssueKind = "off_frame" | "tiny_text" | "text_overlap" | "low_contrast" | "place_missing" | "cropped_text" | "detached_child" | "app_ui";
export type Issue = { kind: IssueKind; id: string; times: number[]; message: string; fix?: Op[] };

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;
/** Same rule as the review and the engine's readable text (26 px on a 1080 frame). */
export const MIN_TEXT_SHARE = 0.024;
/** Share of a layer outside the frame before it is reported (a sliver off edge is intended). */
const OFF_SHARE = 0.1;
/** Ink past a frame edge (share of the frame side) from which a word reads as cut. */
const CROP_SHARE = 0.01;
/** A word cut in this share of the sampled frames where it shows is a layout, not a slide passing through. */
const CROP_PERSIST = 0.5;
/** Width a cut word is refitted to (share of the frame), centered. */
const REFIT_SHARE = 0.86;
/** Overlap of two text boxes, as a share of the smaller one, that reads as a collision. */
const TEXT_OVERLAP = 0.08;
/** Depth (share of the frame side) a text box reaches into an app's buttons or caption band before it reads as covered. */
const APP_UI_SHARE = 0.01;
/** Left margin the apps leave on a vertical video, on the 1080 reference (refits stay right of it). */
const APP_UI_LEFT = 60;
/** A child this many times farther from its parent's center than their boxes reach has absolute x/y by mistake. */
const DETACHED_REACH = 1.5;
/** Parents smaller than this (px) are nulls (camera rigs, pivots): children far from them are intended. */
const NULL_SIZE = 8;

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

/**
 * A color value at layer time `lt`: animated lists (`[{t, c}]`) are followed between their keys (straight
 * in RGB, which is close to what the eye reads), so a background that turns from dark to light is judged
 * as it is when the text shows, not by its first key.
 */
export function colorAt(v: unknown, lt: number, palette: Palette): string | null {
  if (!Array.isArray(v)) return resolveColor(v, palette);
  const keys = (v as { t?: unknown; c?: unknown }[]).filter((k) => typeof k?.t === "number").sort((a, b) => (a.t as number) - (b.t as number));
  if (!keys.length) return resolveColor(v, palette);
  const after = keys.findIndex((k) => (k.t as number) > lt);
  if (after <= 0) return resolveColor((after === 0 ? keys[0] : keys.at(-1))!.c, palette);
  const [a, b] = [keys[after - 1]!, keys[after]!];
  const [ca, cb] = [resolveColor(a.c, palette), resolveColor(b.c, palette)];
  if (!ca || !cb) return ca ?? cb;
  const k = (lt - (a.t as number)) / Math.max(1e-6, (b.t as number) - (a.t as number));
  const [ra, ga, ba] = rgb(ca);
  const [rb, gb, bb] = rgb(cb);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, "0");
  return `#${mix(ra, rb)}${mix(ga, gb)}${mix(ba, bb)}`;
}

const area = (x0: number, y0: number, x1: number, y1: number) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);

/** Area of a screen box inside the frame. */
function insideArea(row: LayoutRow, [w, h]: [number, number]): number {
  const [x0, y0, x1, y1] = row.screen;
  return area(Math.max(x0, 0), Math.max(y0, 0), Math.min(x1, w), Math.min(y1, h));
}

const fmtTimes = (ts: number[]) => ts.map((t) => `${+t.toFixed(2)}s`).join(",");

const num = (v: unknown) => (typeof v === "number" ? v : null);

/**
 * Children drawn far from the parent they hang from: with parent=, x/y are relative to the parent's center, and an
 * agent that writes scene coordinates there (a hand at the arm's absolute position) breaks the figure. Static
 * check on the written values, so it also runs on a component's lines.
 */
export function detachedChildren(layers: Layer[]): Issue[] {
  const byId = new Map(layers.map((l) => [String(l.id), l]));
  const out: Issue[] = [];
  for (const l of layers) {
    const parent = typeof l.parent === "string" ? byId.get(l.parent) : undefined;
    const [x, y, cw, ch, pw, ph] = [num(l.x), num(l.y), num(l.w), num(l.h), num(parent?.w), num(parent?.h)];
    if (!parent || x === null || y === null || pw === null || ph === null || Math.max(pw, ph) < NULL_SIZE || parent.vis === 0) continue;
    const reachX = (pw + (cw ?? 0)) / 2;
    const reachY = (ph + (ch ?? 0)) / 2;
    if (Math.abs(x) <= reachX * DETACHED_REACH && Math.abs(y) <= reachY * DETACHED_REACH) continue;
    out.push({
      kind: "detached_child",
      id: String(l.id),
      times: [],
      message: `'${l.id}' sits at ${x},${y} from the center of its parent '${l.parent}' (${pw}×${ph}), far outside it: with parent=, x/y are relative to the parent's center, not the scene (a hand at the end of a ${ph}px arm is x=0 y=${Math.round(ph / 2)})`,
    });
  }
  return out;
}

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

  for (const issue of detachedChildren(layers)) issues.set(`detached:${issue.id}`, issue);
  for (const [id, { layer }] of byId) {
    const place = layer.place as { of?: string } | undefined;
    if (place?.of && !byId.has(place.of)) add(`place:${id}`, { kind: "place_missing", id, message: `'${id}' is placed relative to '${place.of}', which does not exist` }, null);
    const size = layer.size;
    if (layer.type === "text" && typeof size === "number" && size < short * MIN_TEXT_SHARE) {
      const min = Math.ceil(short * MIN_TEXT_SHARE);
      add(`tiny:${id}`, { kind: "tiny_text", id, message: `text '${id}' is ${size}px on a ${short}px frame: too small to read on a phone (at least ${min}px)`, fix: [{ op: "patch", id, fields: { size: min } }] }, null);
    }
  }

  // Words cut by the frame edge read as broken (screen boxes, so it holds with a camera too).
  const isText3d = (l: Layer) => l.type === "object" && (l.node as { shape?: string } | undefined)?.shape === "text";
  const cropped = new Map<string, { shown: number; cut: number[] }>();
  for (const frame of frames) {
    for (const row of frame.layers) {
      const entry = byId.get(row.id);
      if (!entry || !row.visible || !(entry.layer.type === "text" || isText3d(entry.layer))) continue;
      const [x0, y0, x1, y1] = row.screen;
      const c = cropped.get(row.id) ?? { shown: 0, cut: [] };
      c.shown++;
      const past = Math.max(-x0, x1 - w, 0) / w + Math.max(-y0, y1 - h, 0) / h;
      const inside = insideArea(row, size) > 0;
      if (inside && past > CROP_SHARE) c.cut.push(frame.t);
      cropped.set(row.id, c);
    }
  }
  for (const [id, c] of cropped) {
    if (!c.cut.length || c.cut.length / c.shown < CROP_PERSIST) continue;
    const layer = byId.get(id)!.layer;
    const fits = typeof layer.w === "number" && (layer.w as number) > w * REFIT_SHARE && typeof layer.x === "number" && !layer.parent;
    add(`crop:${id}`, {
      kind: "cropped_text",
      id,
      message: `'${id}' is cut by the frame edge: cut words read as broken, not bold — keep every word whole inside the frame`,
      fix: fits ? [{ op: "patch", id, fields: { w: Math.round(w * REFIT_SHARE), x: w / 2 } }] : undefined,
    }, c.cut[0]!);
    for (const t of c.cut.slice(1)) add(`crop:${id}`, { kind: "cropped_text", id, message: "" }, t);
  }

  // On a vertical video TikTok and Reels draw their buttons (right) and the caption band (bottom) over the frame.
  if (isVerticalFeed(size)) {
    const [kx, ky] = [w / APP_UI_REF[0], h / APP_UI_REF[1]];
    const zones = TEXT_BLOCKING_ZONES.map(({ kind, box: [x0, y0, x1, y1] }) => ({ kind, box: [x0 * kx, y0 * ky, x1 * kx, y1 * ky] }));
    const right = Math.min(...zones.filter((z) => z.kind === AppUiKind.Buttons).map((z) => z.box[0]!));
    const bottom = Math.min(...zones.filter((z) => z.kind === AppUiKind.Caption).map((z) => z.box[1]!));
    const left = APP_UI_LEFT * kx;
    const covered = new Map<string, { shown: number; hits: number[]; buttons: number; caption: number; x0: number }>();
    for (const frame of frames) {
      for (const row of frame.layers) {
        const entry = byId.get(row.id);
        if (!entry || !row.visible || !(entry.layer.type === "text" || isText3d(entry.layer)) || insideArea(row, size) === 0) continue;
        const [x0, y0, x1, y1] = row.screen;
        const c = covered.get(row.id) ?? { shown: 0, hits: [], buttons: 0, caption: 0, x0 };
        c.shown++;
        let hit = false;
        for (const { kind, box: [zx0, zy0, zx1, zy1] } of zones) {
          if (Math.min(x1, zx1!) - Math.max(x0, zx0!) <= w * APP_UI_SHARE || Math.min(y1, zy1!) - Math.max(y0, zy0!) <= h * APP_UI_SHARE) continue;
          hit = true;
          if (kind === AppUiKind.Buttons) c.buttons = Math.max(c.buttons, x1 - right);
          else c.caption = Math.max(c.caption, y1 - bottom);
          c.x0 = Math.min(c.x0, x0);
        }
        if (hit) c.hits.push(frame.t);
        covered.set(row.id, c);
      }
    }
    for (const [id, c] of covered) {
      // A slide passing through is fine, and a word already cut by the frame edge is reported as cropped_text.
      if (!c.hits.length || c.hits.length / c.shown < CROP_PERSIST || issues.has(`crop:${id}`)) continue;
      const layer = byId.get(id)!.layer;
      const where = [c.buttons > 0 && "buttons", c.caption > 0 && "caption band"].filter(Boolean).join(" and ");
      const fields: Record<string, unknown> = {};
      if (layer.type === "text" && !layer.parent && typeof layer.x === "number" && typeof layer.y === "number") {
        if (c.buttons > 0) {
          if (c.x0 - c.buttons >= left) fields.x = +((layer.x as number) - c.buttons).toFixed(1);
          else if (typeof layer.w === "number") Object.assign(fields, { w: Math.round(right - left), x: +((left + right) / 2).toFixed(1) });
        }
        if (c.caption > 0) fields.y = +((layer.y as number) - c.caption).toFixed(1);
      }
      add(`appui:${id}`, {
        kind: "app_ui",
        id,
        message: `'${id}' sits under the TikTok/Reels ${where}: on a vertical video keep text left of x=${Math.round(right)} and above y=${Math.round(bottom)} (backgrounds and footage still fill the frame)`,
        fix: Object.keys(fields).length ? [{ op: "patch", id, fields }] : undefined,
      }, c.hits[0]!);
      for (const t of c.hits.slice(1)) add(`appui:${id}`, { kind: "app_ui", id, message: "" }, t);
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
      // Entirely off screen is normal (waiting to enter); a box mostly past an edge is the bug. A box as wide or as
      // tall as the frame (a wall, a band, a backdrop) bleeds off it on purpose.
      const bleeds = x1 - x0 >= w || y1 - y0 >= h;
      if (total > 0 && inside > 0 && !bleeds && 1 - inside / total > OFF_SHARE) {
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
        const localT = (l: Layer) => t - (typeof l.start === "number" ? l.start : 0);
        const ink = colorAt(fill, localT(layer), palette);
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
        const behindLayer = behind ? byId.get(behind.id)!.layer : null;
        const bgHex = behind ? colorAt(behind.fill ?? "surface", localT(behindLayer!), palette) : hex6(palette.background);
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
