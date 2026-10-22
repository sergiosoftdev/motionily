import { createHash } from "node:crypto";
import { AssetFormat, AssetKind, AssetSource, type AssetHit, type ResolvedAsset, type SearchContext } from "../asset-types";
import { assertPublicUrl, getJson, plain } from "../http";
import { NO_KEY } from "./stock";

/**
 * Web image search (Brave Search API, the user's own key). Anything on the web comes back, so the
 * license is unknown: every hit is flagged editorial (commentary, news, history) and credited to
 * the page it came from.
 */
const BRAVE = "https://api.search.brave.com/res/v1/images/search";
const EDITORIAL = "Unknown — editorial use only";
/** Brave returns at most this many per call. */
const MAX_COUNT = 100;
/** Results are remembered so import can take an id instead of a URL the caller writes. */
const HIT_TTL_MS = 6 * 3600 * 1000;
const MAX_REMEMBERED = 4000;

type BraveImage = { title: string; url: string; source: string; thumbnail?: { src?: string; width?: number; height?: number }; properties?: { url?: string; width?: number; height?: number } };
type Remembered = { at: number; image: string; page: string; title: string; host: string };

const remembered = new Map<string, Remembered>();

function remember(r: Remembered) {
  const id = createHash("sha1").update(r.image).digest("hex").slice(0, 16);
  remembered.set(id, r);
  if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value!);
  return id;
}

export async function searchWeb(q: string, kind: AssetKind, limit: number, ctx: SearchContext): Promise<AssetHit[]> {
  if (kind === AssetKind.Footage) return [];
  if (!ctx.keys.brave) throw new Error(NO_KEY);
  const query = kind === AssetKind.Logo && !/\blogo\b/i.test(q) ? `${q} logo` : kind === AssetKind.Texture && !/texture/i.test(q) ? `${q} texture` : q;
  const params = new URLSearchParams({ q: query, count: String(Math.min(MAX_COUNT, limit)), safesearch: "strict" });
  const data = await getJson<{ results?: BraveImage[] }>(`${BRAVE}?${params}`, { Accept: "application/json", "X-Subscription-Token": ctx.keys.brave });
  return (data.results ?? []).flatMap((r): AssetHit[] => {
    const image = r.properties?.url;
    const thumb = r.thumbnail?.src;
    if (!image || !thumb) return [];
    const host = (() => {
      try {
        return new URL(r.url).hostname.replace(/^www\./, "");
      } catch {
        return r.source;
      }
    })();
    const id = remember({ at: Date.now(), image, page: r.url, title: plain(r.title, 120), host });
    return [
      {
        id: `${AssetSource.Web}:${id}`,
        kind,
        source: AssetSource.Web,
        format: /\.svg(\?|$)/i.test(image) ? AssetFormat.Svg : AssetFormat.Raster,
        title: plain(r.title, 120) || host,
        description: `from ${host}`,
        author: host,
        license: EDITORIAL,
        date: "",
        width: r.properties?.width ?? r.thumbnail?.width ?? 0,
        height: r.properties?.height ?? r.thumbnail?.height ?? 0,
        thumb,
        editorial: true,
      },
    ];
  });
}

export async function resolveWeb(ref: string): Promise<ResolvedAsset> {
  const r = remembered.get(ref);
  if (!r || Date.now() - r.at > HIT_TTL_MS) throw new Error("this web result expired: search again");
  await assertPublicUrl(r.image);
  return {
    format: /\.svg(\?|$)/i.test(r.image) ? AssetFormat.Svg : AssetFormat.Raster,
    download: r.image,
    credit: { kind: AssetKind.Photo, source: AssetSource.Web, title: r.title || r.host, author: r.host, license: EDITORIAL, licenseUrl: null, pageUrl: r.page, editorial: true },
  };
}
