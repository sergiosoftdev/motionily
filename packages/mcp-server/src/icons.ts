/** Lucide icons (ISC) as centered 24-unit paths; see scripts/build-icons.ts. */
import { readFileSync } from "node:fs";

type Icon = { d: string; tags: string[] };
/** Lucide's design size: stroke 2 at 24 px. */
export const ICON_GRID = 24;
const ARC_FIXED_ARGS = [2, 3, 4];

let cache: Record<string, Icon> | null = null;

function icons(): Record<string, Icon> {
  cache ??= JSON.parse(readFileSync(new URL("./icons.json", import.meta.url), "utf8")) as Record<string, Icon>;
  return cache;
}

/** Path data of `name` scaled to `size` px (still centered on 0,0). */
export function iconPath(name: string, size: number): string {
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

/** Icon names matching the words of `query` in their name or tags, best first. */
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
