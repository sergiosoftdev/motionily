/**
 * Real photos for videos, from free libraries that state each image's license.
 * Only images a video may reuse commercially and edit (crop, zoom, grade) come back:
 * public domain, CC0, CC BY and CC BY-SA. Never NC or ND.
 */

/** Mirrors ImageSource in @motionily/protocol. */
export enum ImageSource {
  Commons = "commons",
  Openverse = "openverse",
}

export type ImageHit = {
  id: string;
  source: ImageSource;
  title: string;
  description: string;
  author: string;
  license: string;
  date: string;
  width: number;
  height: number;
  thumb: string;
};

export type ImageCredit = {
  src: string;
  source: ImageSource;
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  pageUrl: string;
};

/** Where to download an image from, and how to credit it. */
export type ResolvedImage = { download: string; credit: Omit<ImageCredit, "src"> };

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const OPENVERSE_API = "https://api.openverse.org/v1/images";
/** Wikimedia asks every client to identify itself. */
const HEADERS = { "User-Agent": "Motionily/0.1 (https://github.com/sergiosoftdev/motionily)" };
/** Openverse is often slow: one source timing out must not sink the search. */
const SOURCE_TIMEOUT_MS = 8000;
const THUMB_WIDTH = 400;
/** Big enough for a slow zoom on a 1080p frame, small enough to load fast. */
const IMPORT_WIDTH = 2560;
const TEXT_MAX = 200;

const COMMONS_OK = /^(public domain|pd\b|cc0|no restrictions|attribution$|cc by(-sa)?( [\d.]+)?( [a-z]{2,3})?$)/i;
const IMAGE_EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const OPENVERSE_LICENSES = "by,by-sa,cc0,pdm";
const OPENVERSE_LABEL: Record<string, string> = { by: "CC BY", "by-sa": "CC BY-SA", cc0: "CC0", pdm: "Public domain" };

/** Commons metadata comes as HTML. */
function plain(html: string | undefined, max = TEXT_MAX) {
  const t = (html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Commons often renders a name twice (visible + hidden copy): "Jane Doe Jane Doe" -> "Jane Doe". */
function author(html: string | undefined) {
  const words = plain(html, 160).split(" ");
  const half = words.length / 2;
  const name = Number.isInteger(half) && words.slice(0, half).join(" ") === words.slice(half).join(" ") ? words.slice(0, half).join(" ") : words.join(" ");
  return (name.length > 80 ? `${name.slice(0, 79)}…` : name) || "Unknown";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

type CommonsMeta = Record<string, { value?: string } | undefined>;
type CommonsPage = {
  index: number;
  title: string;
  imageinfo?: { width: number; height: number; thumburl?: string; url: string; descriptionurl: string; extmetadata?: CommonsMeta }[];
};

function commonsUrl(params: Record<string, string>) {
  return `${COMMONS_API}?${new URLSearchParams({
    action: "query",
    prop: "imageinfo",
    iiprop: "url|size|extmetadata",
    iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|ImageDescription|ObjectName|DateTimeOriginal",
    format: "json",
    ...params,
  })}`;
}

async function searchCommons(query: string, limit: number): Promise<ImageHit[]> {
  const data = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(
    commonsUrl({ generator: "search", gsrsearch: `${query} filetype:bitmap`, gsrnamespace: "6", gsrlimit: String(limit * 2), iiurlwidth: String(THUMB_WIDTH) }),
  );
  return Object.values(data.query?.pages ?? {})
    .sort((a, b) => a.index - b.index)
    .flatMap((p): ImageHit[] => {
      const info = p.imageinfo?.[0];
      const meta = info?.extmetadata ?? {};
      const license = plain(meta.LicenseShortName?.value, 40);
      if (!info?.thumburl || !COMMONS_OK.test(license)) return [];
      return [
        {
          id: `${ImageSource.Commons}:${p.title}`,
          source: ImageSource.Commons,
          title: plain(meta.ObjectName?.value) || p.title.replace(/^File:/, ""),
          description: plain(meta.ImageDescription?.value),
          author: author(meta.Artist?.value),
          license,
          date: plain(meta.DateTimeOriginal?.value, 40),
          width: info.width,
          height: info.height,
          thumb: info.thumburl,
        },
      ];
    })
    .slice(0, limit);
}

type OpenverseImage = {
  id: string;
  title: string | null;
  url: string;
  thumbnail: string;
  creator: string | null;
  license: string;
  license_version: string | null;
  license_url: string | null;
  foreign_landing_url: string;
  width: number | null;
  height: number | null;
  source: string;
};

const openverseLicense = (x: OpenverseImage) => [OPENVERSE_LABEL[x.license] ?? x.license.toUpperCase(), x.license === "pdm" || x.license === "cc0" ? "" : x.license_version ?? ""].join(" ").trim();

async function searchOpenverse(query: string, limit: number): Promise<ImageHit[]> {
  const data = await getJson<{ results: OpenverseImage[] }>(`${OPENVERSE_API}/?${new URLSearchParams({ q: query, license: OPENVERSE_LICENSES, page_size: String(limit) })}`);
  return data.results.map((x) => ({
    id: `${ImageSource.Openverse}:${x.id}`,
    source: ImageSource.Openverse,
    title: plain(x.title ?? "") || "Untitled",
    description: `via ${x.source}`,
    author: plain(x.creator ?? "", 80) || "Unknown",
    license: openverseLicense(x),
    date: "",
    width: x.width ?? 0,
    height: x.height ?? 0,
    thumb: x.thumbnail,
  }));
}

const SEARCHERS: Record<ImageSource, (query: string, limit: number) => Promise<ImageHit[]>> = {
  [ImageSource.Commons]: searchCommons,
  [ImageSource.Openverse]: searchOpenverse,
};

/** Search every source (or one) at once; a source that fails is reported, not fatal. */
export async function searchImages(query: string, limit: number, source?: ImageSource) {
  const sources = source ? [source] : Object.values(ImageSource);
  const settled = await Promise.allSettled(sources.map((s) => SEARCHERS[s](query, limit)));
  const hits: ImageHit[] = [];
  const unavailable: string[] = [];
  settled.forEach((r, i) => (r.status === "fulfilled" ? hits.push(...r.value) : unavailable.push(`${sources[i]} (${(r.reason as Error).message})`)));
  return { hits, unavailable };
}

/** Turn a search id back into a download URL and its attribution, straight from the source (never a URL the caller gives). */
export async function resolveImage(id: string): Promise<ResolvedImage> {
  const at = id.indexOf(":");
  const source = id.slice(0, at) as ImageSource;
  const ref = id.slice(at + 1);
  if (source === ImageSource.Commons) {
    if (!/^File:/.test(ref)) throw new Error("commons ids look like commons:File:Name.jpg");
    const data = await getJson<{ query?: { pages?: Record<string, Omit<CommonsPage, "index">> } }>(commonsUrl({ titles: ref, iiurlwidth: String(IMPORT_WIDTH) }));
    const page = Object.values(data.query?.pages ?? {})[0];
    const info = page?.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    const license = plain(meta.LicenseShortName?.value, 40);
    if (!info) throw new Error(`no image ${ref} on Wikimedia Commons`);
    if (!COMMONS_OK.test(license)) throw new Error(`${ref} is ${license || "unlicensed"}: not reusable`);
    return {
      download: info.thumburl ?? info.url,
      credit: {
        source,
        title: plain(meta.ObjectName?.value) || ref.replace(/^File:/, ""),
        author: author(meta.Artist?.value),
        license,
        licenseUrl: meta.LicenseUrl?.value ?? null,
        pageUrl: info.descriptionurl,
      },
    };
  }
  if (source === ImageSource.Openverse) {
    if (!/^[a-f0-9-]{36}$/.test(ref)) throw new Error("openverse ids look like openverse:<uuid>");
    const x = await getJson<OpenverseImage>(`${OPENVERSE_API}/${ref}/`);
    if (!OPENVERSE_LICENSES.split(",").includes(x.license)) throw new Error(`${ref} is ${x.license}: not reusable`);
    return {
      download: x.url,
      credit: { source, title: plain(x.title ?? "") || "Untitled", author: plain(x.creator ?? "", 80) || "Unknown", license: openverseLicense(x), licenseUrl: x.license_url, pageUrl: x.foreign_landing_url },
    };
  }
  throw new Error(`unknown image source in '${id}' (${Object.values(ImageSource).join(", ")})`);
}

/** Download an image (checked type and size) for saving under /media. */
export async function downloadImage(url: string, maxBytes: number) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS * 3) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const ext = IMAGE_EXT[mime];
  if (!ext) throw new Error(`not a usable image (${mime || "unknown type"})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`image too large (${Math.round(bytes.length / 1e6)} MB)`);
  return { bytes, ext };
}
