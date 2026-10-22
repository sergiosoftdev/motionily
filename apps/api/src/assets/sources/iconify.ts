import { AssetFormat, AssetKind, AssetSource, type AssetHit, type ResolvedAsset } from "../asset-types";
import { getJson } from "../http";

/**
 * Iconify: ~275k icons in 200+ sets, among them thousands of brand logos as clean SVG (Simple Icons,
 * gilbarbara's Logos, theSVG…). Each set states its license; sets whose license forbids commercial
 * use or reaches into the work (NC, GPL) are never offered.
 */
const ICONIFY = "https://api.iconify.design";
const LOGO_CATEGORY = "Logos";
/** Licenses a video may use (with credit where they ask for it). */
const REUSABLE = new Set(["CC0-1.0", "Unlicense", "MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "MPL-2.0", "OFL-1.1", "CC-BY-3.0", "CC-BY-4.0", "CC-BY-SA-3.0", "CC-BY-SA-4.0"]);
/** Licenses that need no credit line in the video's credits. */
const NO_CREDIT = new Set(["CC0-1.0", "Unlicense"]);
const ICON_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const DEFAULT_GRID = 24;
const THUMB_PX = 160;
/** Iconify's search returns at least this many. */
const MIN_SEARCH = 32;

export type IconSet = { name: string; author?: { name: string; url?: string }; license?: { title: string; spdx?: string; url?: string }; palette?: boolean; category?: string; height?: number | number[] };
export type IconData = { id: string; body: string; width: number; height: number; set: string; license: string; licenseUrl: string | null; multicolor: boolean };

const isReusable = (set?: IconSet) => !!set?.license?.spdx && REUSABLE.has(set.license.spdx);

type SearchAnswer = { icons: string[]; collections?: Record<string, IconSet> };

/** Icon ids (prefix:name) for words, with their sets; only reusable sets. */
export async function searchIcons(q: string, limit: number, category?: string) {
  const params = new URLSearchParams({ query: q, limit: String(Math.max(MIN_SEARCH, limit * 2)), ...(category ? { category } : {}) });
  const data = await getJson<SearchAnswer>(`${ICONIFY}/search?${params}`);
  const sets = data.collections ?? {};
  const icons = data.icons.filter((id) => isReusable(sets[id.split(":")[0]!])).slice(0, limit);
  return { icons, sets };
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether an icon name is the brand asked for: "coca-cola" and "cocacola" for "Coca-Cola",
 * "spotify-icon" for "Spotify", never "fantasy" for "Fanta" (Iconify matches prefixes).
 */
function namesBrand(name: string, q: string) {
  const want = q.toLowerCase().replace(/\blogo\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = name.split(/[-_]/);
  return compact(name).startsWith(compact(want.join(""))) && (tokens.includes(want[0]!) || tokens[0] === compact(want.join("")) || compact(tokens.slice(0, want.length).join("")) === compact(want.join("")));
}

export async function searchIconifyLogos(q: string, kind: AssetKind, limit: number): Promise<AssetHit[]> {
  if (kind !== AssetKind.Logo) return [];
  const found = await searchIcons(q.replace(/\blogo\b/gi, "").trim() || q, limit * 3, LOGO_CATEGORY);
  const sets = found.sets;
  const icons = found.icons.filter((id) => namesBrand(id.split(":")[1]!, q)).slice(0, limit);
  return icons.map((id) => {
    const [prefix, name] = id.split(":") as [string, string];
    const set = sets[prefix]!;
    const h = Array.isArray(set.height) ? set.height[0] : set.height;
    return {
      id: `${AssetSource.Iconify}:${id}`,
      kind,
      source: AssetSource.Iconify,
      format: AssetFormat.Svg,
      title: `${name} (${set.name})`,
      description: set.palette ? "full color" : "one color: recolor it freely",
      author: set.author?.name ?? set.name,
      license: set.license?.title ?? "",
      date: "",
      width: h ?? DEFAULT_GRID,
      height: h ?? DEFAULT_GRID,
      thumb: `${ICONIFY}/${prefix}/${name}.svg?height=${THUMB_PX}`,
    };
  });
}

let setsCache: { at: number; sets: Record<string, IconSet> } | null = null;
const SETS_TTL_MS = 6 * 3600 * 1000;

/** Every set's name and license (cached: the list changes rarely). */
export async function iconSets(): Promise<Record<string, IconSet>> {
  if (setsCache && Date.now() - setsCache.at < SETS_TTL_MS) return setsCache.sets;
  setsCache = { at: Date.now(), sets: await getJson<Record<string, IconSet>>(`${ICONIFY}/collections`) };
  return setsCache.sets;
}

type SetAnswer = { prefix: string; width?: number; height?: number; icons: Record<string, { body: string; width?: number; height?: number }>; aliases?: Record<string, { parent: string; width?: number; height?: number }>; not_found?: string[] };

/** SVG bodies of icons (any sets), checked against each set's license. */
export async function iconData(ids: string[]): Promise<{ icons: IconData[]; missing: string[] }> {
  const bad = ids.filter((id) => !ICON_ID.test(id));
  if (bad.length) throw new Error(`icon ids look like prefix:name, got ${bad.join(", ")}`);
  const sets = await iconSets();
  const byPrefix = new Map<string, string[]>();
  for (const id of ids) {
    const [prefix, name] = id.split(":") as [string, string];
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }
  const icons: IconData[] = [];
  const missing: string[] = [];
  await Promise.all(
    [...byPrefix].map(async ([prefix, names]) => {
      const set = sets[prefix];
      if (!isReusable(set)) {
        missing.push(...names.map((n) => `${prefix}:${n} (${set ? `${set.license?.title ?? "unknown"} license: not reusable` : "unknown set"})`));
        return;
      }
      const data = await getJson<SetAnswer>(`${ICONIFY}/${prefix}.json?${new URLSearchParams({ icons: names.join(",") })}`);
      for (const name of names) {
        const alias = data.aliases?.[name];
        const icon = data.icons[name] ?? (alias ? data.icons[alias.parent] : undefined);
        if (!icon) {
          missing.push(`${prefix}:${name}`);
          continue;
        }
        icons.push({
          id: `${prefix}:${name}`,
          body: icon.body,
          width: alias?.width ?? icon.width ?? data.width ?? DEFAULT_GRID,
          height: alias?.height ?? icon.height ?? data.height ?? DEFAULT_GRID,
          set: set!.name,
          license: set!.license!.title,
          licenseUrl: set!.license!.url ?? null,
          multicolor: !!set!.palette,
        });
      }
    }),
  );
  return { icons, missing };
}

/** A standalone SVG file of an icon (currentColor renders black until recolored). */
export function iconSvg(icon: Pick<IconData, "body" | "width" | "height">) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width} ${icon.height}" width="${icon.width}" height="${icon.height}" color="#000000">${icon.body}</svg>`;
}

/** Whether using an icon of this license puts a line in the video's credits. */
export const needsCredit = (spdxOrTitle: string) => !NO_CREDIT.has(spdxOrTitle) && !/^(CC0|Unlicense)/i.test(spdxOrTitle);

/** The set's page on Iconify, used as the credit's link (one credit per set). */
export const setPage = (prefix: string) => `https://icon-sets.iconify.design/${prefix}/`;

export async function resolveIconify(ref: string): Promise<ResolvedAsset & { svgText: string }> {
  const { icons, missing } = await iconData([ref]);
  const icon = icons[0];
  if (!icon) throw new Error(missing[0] ?? `no icon ${ref}`);
  const [prefix, name] = ref.split(":") as [string, string];
  return {
    format: AssetFormat.Svg,
    download: `${ICONIFY}/${prefix}/${name}.svg`,
    svgText: iconSvg(icon),
    credit: { kind: AssetKind.Logo, source: AssetSource.Iconify, title: `${name} (${icon.set})`, author: icon.set, license: icon.license, licenseUrl: icon.licenseUrl, pageUrl: `${setPage(prefix)}?icon-filter=${name}` },
  };
}
