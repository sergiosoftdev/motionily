/**
 * Icons for `ic=`: Lucide (ISC, bundled, centered 24-unit paths; see scripts/build-icons.ts) by plain
 * name, and any of Iconify's ~275k icons by `prefix:name` (Phosphor, Tabler, Material Symbols,
 * Solar, hand-drawn sets…), loaded through the API and cached on disk.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathData, svgToVector, type Seg } from "./svg.js";

type Icon = { d: string; tags: string[] };
/** Lucide's design size: stroke 2 at 24 px. */
export const ICON_GRID = 24;
const ARC_FIXED_ARGS = [2, 3, 4];

let cache: Record<string, Icon> | null = null;

function icons(): Record<string, Icon> {
  cache ??= JSON.parse(readFileSync(new URL("./icons.json", import.meta.url), "utf8")) as Record<string, Icon>;
  return cache;
}

// ── Iconify ──
/** `ph:rocket-duotone`: an Iconify id (Lucide names never have a colon). */
export const ICONIFY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const ICONIFY_IN_TEXT = /\bic[=:]([a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[-_][a-z0-9]+)*)(?=[:\s"]|$)/g;
const CACHE_DIR = join(process.env.MOTIONILY_HOME ?? join(homedir(), ".motionily"), "iconify");

type IconifyIcon = { body: string; width: number; height: number; multicolor: boolean };
/** One-color geometry of an Iconify icon, ready to scale. */
type Shape = { segs: Seg[]; box: [number, number, number, number]; stroked: boolean; strokeWidth: number; nonzero: boolean; colors: number };

const iconify = new Map<string, IconifyIcon>();
const shapes = new Map<string, Shape>();

function diskFile(prefix: string) {
  return join(CACHE_DIR, `${prefix}.json`);
}

function fromDisk(id: string): IconifyIcon | undefined {
  const [prefix, name] = id.split(":") as [string, string];
  try {
    const all = JSON.parse(readFileSync(diskFile(prefix), "utf8")) as Record<string, IconifyIcon>;
    for (const [n, icon] of Object.entries(all)) iconify.set(`${prefix}:${n}`, icon);
    return all[name];
  } catch {
    return undefined;
  }
}

function toDisk(prefix: string) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const all: Record<string, IconifyIcon> = {};
    for (const [id, icon] of iconify) if (id.startsWith(`${prefix}:`)) all[id.slice(prefix.length + 1)] = icon;
    writeFileSync(diskFile(prefix), JSON.stringify(all));
  } catch {
    // The cache is a convenience: the API serves them again next time.
  }
}

type IconDataApi = { iconData(ids: string[]): Promise<{ icons: { id: string; body: string; width: number; height: number; multicolor: boolean }[]; missing: string[] }> };

/** Load every Iconify id written in these lines (ic=prefix:name) before they are parsed. */
export async function preloadIcons(text: string, api: IconDataApi): Promise<void> {
  // `ic=message-circle:84` is a Lucide name with its size, not the Iconify id "message-circle:84".
  const ids = [...new Set([...text.matchAll(ICONIFY_IN_TEXT)].map((m) => m[1]!))]
    .filter((id) => !/^[\d.]+$/.test(id.split(":")[1]!))
    .filter((id) => !iconify.has(id) && !fromDisk(id));
  if (!ids.length) return;
  const { icons: got, missing } = await api.iconData(ids);
  for (const i of got) iconify.set(i.id, { body: i.body, width: i.width, height: i.height, multicolor: i.multicolor });
  for (const prefix of new Set(got.map((i) => i.id.split(":")[0]!))) toDisk(prefix);
  if (missing.length) throw new Error(`unknown or unusable icons: ${missing.join(", ")} (find_icons lists real ids)`);
}

function shapeOf(id: string): Shape {
  const known = shapes.get(id);
  if (known) return known;
  const icon = iconify.get(id) ?? fromDisk(id);
  if (!icon) throw new Error(`icon '${id}' is not loaded (find_icons lists real ids)`);
  const v = svgToVector(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width} ${icon.height}">${icon.body}</svg>`);
  if (!v.parts.length) throw new Error(`icon '${id}' has no drawable shapes`);
  const paints = new Set(v.parts.map((p) => `${p.fill ?? ""}|${p.stroke?.color ?? ""}`));
  const stroked = v.parts.every((p) => !p.fill && p.stroke);
  const shape: Shape = {
    segs: v.parts.flatMap((p) => p.segs),
    box: v.box,
    stroked,
    strokeWidth: stroked ? (v.parts[0]!.stroke?.width ?? 2) : 0,
    nonzero: v.parts.every((p) => p.nonzero),
    colors: icon.multicolor ? Math.max(2, paints.size) : paints.size,
  };
  shapes.set(id, shape);
  return shape;
}

/** How an icon is painted: Lucide and line sets are stroked; most Iconify sets are filled shapes. */
export type IconStyle = { filled: boolean; nonzero: boolean; strokeAt: (size: number) => number };

export function iconStyle(name: string): IconStyle {
  if (!ICONIFY_ID.test(name)) return { filled: false, nonzero: false, strokeAt: (px) => Math.max(1.5, px / 12) };
  const s = shapeOf(name);
  if (s.colors > 1) throw new Error(`'${name}' has ${s.colors} colors: place it with add_vector icon=${name} (each color its own part), or pick a one-color icon`);
  const grid = Math.max(s.box[2], s.box[3]);
  return { filled: !s.stroked, nonzero: s.nonzero, strokeAt: (px) => +((s.strokeWidth * px) / grid).toFixed(2) };
}

/** Path data of `name` scaled to `size` px (still centered on 0,0). */
export function iconPath(name: string, size: number): string {
  if (ICONIFY_ID.test(name)) {
    const s = shapeOf(name);
    const [bx, by, bw, bh] = s.box;
    const k = size / Math.max(bw, bh);
    const [cx, cy] = [bx + bw / 2, by + bh / 2];
    return pathData(s.segs, (x, y) => [(x - cx) * k, (y - cy) * k]);
  }
  const icon = icons()[name];
  if (!icon) throw new Error(`unknown icon '${name}' (find_icons lists them)`);
  const k = size / ICON_GRID;
  // Absolute commands with plain numbers: scale every number except arc rotation and flags.
  return icon.d.replace(/([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/g, (_, cmd: string, args: string) => {
    const nums = args.trim() ? args.trim().split(/\s+/).map(Number) : [];
    const scaled = nums.map((v, i) => (cmd === "A" && ARC_FIXED_ARGS.includes(i % 7) ? v : +(v * k).toFixed(2)));
    return cmd + scaled.join(" ");
  });
}

/** `ph:rocket:48` / `bell:48` / `ph:rocket` / `bell` -> name and size. */
export function splitIcon(v: string): { name: string; size: number | undefined } {
  const parts = v.split(":");
  const last = parts[parts.length - 1]!;
  const sized = parts.length > 1 && /^[\d.]+$/.test(last);
  const name = (sized ? parts.slice(0, -1) : parts).join(":");
  return { name, size: sized ? Number(last) : undefined };
}

/** Lucide icon names matching the words of `query` in their name or tags, best first. */
export function findIcons(query: string, limit: number): string[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return Object.entries(icons())
    .map(([name, icon]) => {
      const hay = [name, ...icon.tags];
      const score = words.reduce((s, w) => s + (name === w ? 4 : name.includes(w) ? 2 : hay.some((h) => h.includes(w)) ? 1 : 0), 0);
      return { name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, limit)
    .map((x) => x.name);
}
