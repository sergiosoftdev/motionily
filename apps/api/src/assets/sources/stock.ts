import { AssetFormat, AssetKind, AssetSource, Orientation, type AssetHit, type ResolvedAsset, type SearchContext } from "../asset-types";
import { getJson, plain } from "../http";

/**
 * Modern stock photos and footage (Pexels, Pixabay): free licenses that allow commercial use and
 * editing without attribution (credited anyway). Each needs an API key: the user's or the platform's.
 */
const PEXELS = "https://api.pexels.com";
const PIXABAY = "https://pixabay.com/api";
const PEXELS_LICENSE = { license: "Pexels License", licenseUrl: "https://www.pexels.com/license/" };
const PIXABAY_LICENSE = { license: "Pixabay Content License", licenseUrl: "https://pixabay.com/service/license-summary/" };
/** Largest import (px on the long side for photos; the short side for clips stays ≤ 1080). */
const IMPORT_WIDTH = 2560;
const MAX_CLIP_SHORT_SIDE = 1080;
const THUMB_WIDTH = 320;
const PREVIEW_WIDTH = 480;
/** Pixabay refuses fewer than 3 per page. */
const PIXABAY_MIN_PAGE = 3;

export const NO_KEY = "no API key";

const pexelsOrientation = (o?: Orientation): Record<string, string> => (o ? { orientation: o } : {});
const PIXABAY_ORIENTATION: Record<Orientation, string> = { [Orientation.Portrait]: "vertical", [Orientation.Landscape]: "horizontal", [Orientation.Square]: "all" };
const textureQuery = (q: string, kind: AssetKind) => (kind === AssetKind.Texture && !/texture/i.test(q) ? `${q} texture` : q);
/** Textures crop and tile freely: any shape will do. */
const shaped = (kind: AssetKind, o?: Orientation) => (kind === AssetKind.Texture ? undefined : o);

type PexelsPhoto = { id: number; width: number; height: number; url: string; photographer: string; alt: string; src: { original: string } };
type PexelsFile = { quality: string | null; file_type: string; width: number; height: number; link: string };
type PexelsVideo = { id: number; width: number; height: number; duration: number; url: string; image: string; user: { name: string }; video_files: PexelsFile[] };

/** Pexels serves any width of a photo through query parameters. */
const sized = (original: string, w: number) => `${original}?auto=compress&cs=tinysrgb&w=${w}`;
/** "https://www.pexels.com/photo/red-apple-on-table-1234/" -> "red apple on table". */
const pexelsTitle = (url: string, alt: string) => plain(alt, 120) || url.split("/").filter(Boolean).at(-1)?.replace(/-\d+$/, "").replace(/-/g, " ") || "Untitled";

export async function searchPexels(q: string, kind: AssetKind, limit: number, ctx: SearchContext): Promise<AssetHit[]> {
  if (kind === AssetKind.Logo) return [];
  if (!ctx.keys.pexels) throw new Error(NO_KEY);
  const auth = { Authorization: ctx.keys.pexels };
  const params = new URLSearchParams({ query: textureQuery(q, kind), per_page: String(limit), ...pexelsOrientation(shaped(kind, ctx.orientation)) });
  if (kind === AssetKind.Footage) {
    const data = await getJson<{ videos: PexelsVideo[] }>(`${PEXELS}/videos/search?${params}`, auth);
    return data.videos.map((v) => ({
      id: `${AssetSource.Pexels}:video:${v.id}`,
      kind,
      source: AssetSource.Pexels,
      format: AssetFormat.Video,
      title: pexelsTitle(v.url, ""),
      description: "",
      author: v.user.name,
      license: PEXELS_LICENSE.license,
      date: "",
      width: v.width,
      height: v.height,
      thumb: v.image,
      duration: v.duration,
    }));
  }
  const data = await getJson<{ photos: PexelsPhoto[] }>(`${PEXELS}/v1/search?${params}`, auth);
  return data.photos.map((p) => ({
    id: `${AssetSource.Pexels}:photo:${p.id}`,
    kind,
    source: AssetSource.Pexels,
    format: AssetFormat.Raster,
    title: pexelsTitle(p.url, p.alt),
    description: "",
    author: p.photographer,
    license: PEXELS_LICENSE.license,
    date: "",
    width: p.width,
    height: p.height,
    thumb: sized(p.src.original, THUMB_WIDTH),
  }));
}

/** The best mp4 that keeps the short side ≤ 1080 (smaller files, enough for a 1080p frame). */
function pexelsRendition(files: PexelsFile[]) {
  const mp4 = files.filter((f) => f.file_type === "video/mp4" && f.width && f.height);
  const fits = mp4.filter((f) => Math.min(f.width, f.height) <= MAX_CLIP_SHORT_SIDE).sort((a, b) => b.width * b.height - a.width * a.height);
  return fits[0] ?? mp4.sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

export async function resolvePexels(ref: string, keys: SearchContext["keys"]): Promise<ResolvedAsset> {
  if (!keys.pexels) throw new Error(`Pexels: ${NO_KEY}`);
  const auth = { Authorization: keys.pexels };
  const [type, id] = ref.split(":");
  if (!/^\d+$/.test(id ?? "")) throw new Error("pexels ids look like pexels:photo:123 or pexels:video:123");
  if (type === "video") {
    const v = await getJson<PexelsVideo>(`${PEXELS}/videos/videos/${id}`, auth);
    const file = pexelsRendition(v.video_files);
    if (!file) throw new Error(`pexels video ${id} has no mp4`);
    return {
      format: AssetFormat.Video,
      download: file.link,
      credit: { kind: AssetKind.Footage, source: AssetSource.Pexels, title: pexelsTitle(v.url, ""), author: v.user.name, ...PEXELS_LICENSE, pageUrl: v.url },
    };
  }
  if (type !== "photo") throw new Error("pexels ids look like pexels:photo:123 or pexels:video:123");
  const p = await getJson<PexelsPhoto>(`${PEXELS}/v1/photos/${id}`, auth);
  return {
    format: AssetFormat.Raster,
    download: sized(p.src.original, Math.min(IMPORT_WIDTH, p.width)),
    preview: sized(p.src.original, PREVIEW_WIDTH),
    credit: { kind: AssetKind.Photo, source: AssetSource.Pexels, title: pexelsTitle(p.url, p.alt), author: p.photographer, ...PEXELS_LICENSE, pageUrl: p.url },
  };
}

type PixabayImage = { id: number; pageURL: string; tags: string; previewURL: string; webformatURL: string; largeImageURL: string; imageWidth: number; imageHeight: number; user: string };
type PixabayRendition = { url: string; width: number; height: number; size: number; thumbnail: string };
type PixabayVideo = { id: number; pageURL: string; tags: string; duration: number; videos: Partial<Record<"large" | "medium" | "small" | "tiny", PixabayRendition>>; user: string };

const pixabayTitle = (tags: string) => tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4).join(", ") || "Untitled";

export async function searchPixabay(q: string, kind: AssetKind, limit: number, ctx: SearchContext): Promise<AssetHit[]> {
  if (kind === AssetKind.Logo) return [];
  if (!ctx.keys.pixabay) throw new Error(NO_KEY);
  const o = shaped(kind, ctx.orientation);
  const params = new URLSearchParams({
    key: ctx.keys.pixabay,
    q: textureQuery(q, kind).slice(0, 100),
    per_page: String(Math.max(PIXABAY_MIN_PAGE, limit)),
    safesearch: "true",
    ...(o ? { orientation: PIXABAY_ORIENTATION[o] } : {}),
  });
  if (kind === AssetKind.Footage) {
    const data = await getJson<{ hits: PixabayVideo[] }>(`${PIXABAY}/videos/?${params}`);
    return data.hits.slice(0, limit).flatMap((v) => {
      const best = v.videos.large?.url ? v.videos.large : v.videos.medium;
      if (!best?.url) return [];
      return [
        {
          id: `${AssetSource.Pixabay}:video:${v.id}`,
          kind,
          source: AssetSource.Pixabay,
          format: AssetFormat.Video,
          title: pixabayTitle(v.tags),
          description: "",
          author: v.user,
          license: PIXABAY_LICENSE.license,
          date: "",
          width: best.width,
          height: best.height,
          thumb: best.thumbnail || v.videos.medium?.thumbnail || "",
          duration: v.duration,
        },
      ];
    });
  }
  const data = await getJson<{ hits: PixabayImage[] }>(`${PIXABAY}/?${params.toString()}&image_type=photo`);
  return data.hits.slice(0, limit).map((x) => ({
    id: `${AssetSource.Pixabay}:photo:${x.id}`,
    kind,
    source: AssetSource.Pixabay,
    format: AssetFormat.Raster,
    title: pixabayTitle(x.tags),
    description: "",
    author: x.user,
    license: PIXABAY_LICENSE.license,
    date: "",
    width: x.imageWidth,
    height: x.imageHeight,
    thumb: x.webformatURL,
  }));
}

export async function resolvePixabay(ref: string, keys: SearchContext["keys"]): Promise<ResolvedAsset> {
  if (!keys.pixabay) throw new Error(`Pixabay: ${NO_KEY}`);
  const [type, id] = ref.split(":");
  if (!/^\d+$/.test(id ?? "")) throw new Error("pixabay ids look like pixabay:photo:123 or pixabay:video:123");
  const params = new URLSearchParams({ key: keys.pixabay, id: id! });
  if (type === "video") {
    const v = (await getJson<{ hits: PixabayVideo[] }>(`${PIXABAY}/videos/?${params}`)).hits[0];
    // `large` is 1920 wide when the clip has it; medium is 1280.
    const best = v?.videos.large?.url ? v.videos.large : v?.videos.medium;
    if (!v || !best?.url) throw new Error(`no pixabay video ${id}`);
    return {
      format: AssetFormat.Video,
      download: best.url,
      credit: { kind: AssetKind.Footage, source: AssetSource.Pixabay, title: pixabayTitle(v.tags), author: v.user, ...PIXABAY_LICENSE, pageUrl: v.pageURL },
    };
  }
  if (type !== "photo") throw new Error("pixabay ids look like pixabay:photo:123 or pixabay:video:123");
  const x = (await getJson<{ hits: PixabayImage[] }>(`${PIXABAY}/?${params}`)).hits[0];
  if (!x) throw new Error(`no pixabay photo ${id}`);
  return {
    format: AssetFormat.Raster,
    // largeImageURL is 1280 px on the long side (the full size needs Pixabay's approval).
    download: x.largeImageURL,
    preview: x.webformatURL,
    credit: { kind: AssetKind.Photo, source: AssetSource.Pixabay, title: pixabayTitle(x.tags), author: x.user, ...PIXABAY_LICENSE, pageUrl: x.pageURL },
  };
}
