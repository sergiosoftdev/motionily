import { AssetFormat, AssetKind, AssetSource, type AssetHit, type ResolvedAsset } from "../asset-types";
import { getJson, plain } from "../http";

/** Wikimedia Commons: history, places, people, events — and many logos as public-domain SVG. */
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const THUMB_WIDTH = 240;
/** What the agent sees of an imported photo: enough to compose around it. */
const PREVIEW_WIDTH = 480;
/** Big enough for a slow zoom on a 1080p frame, small enough to load fast. */
const IMPORT_WIDTH = 2560;
const COMMONS_OK = /^(public domain|pd\b|cc0|no restrictions|attribution$|cc by(-sa)?( [\d.]+)?( [a-z]{2,3})?$)/i;
const SVG = "image/svg+xml";

type CommonsMeta = Record<string, { value?: string } | undefined>;
type CommonsPage = {
  index: number;
  title: string;
  imageinfo?: { width: number; height: number; mime?: string; thumburl?: string; url: string; descriptionurl: string; extmetadata?: CommonsMeta }[];
};

/** Commons often renders a name twice (visible + hidden copy): "Jane Doe Jane Doe" -> "Jane Doe". */
function author(html: string | undefined) {
  const words = plain(html, 160).split(" ");
  const half = words.length / 2;
  const name = Number.isInteger(half) && words.slice(0, half).join(" ") === words.slice(half).join(" ") ? words.slice(0, half).join(" ") : words.join(" ");
  return (name.length > 80 ? `${name.slice(0, 79)}…` : name) || "Unknown";
}

function commonsUrl(params: Record<string, string>) {
  return `${COMMONS_API}?${new URLSearchParams({
    action: "query",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|ImageDescription|ObjectName|DateTimeOriginal",
    format: "json",
    ...params,
  })}`;
}

/** Photos and textures are bitmaps; logos are drawings (SVG), searched with the word "logo". */
export async function searchCommons(q: string, kind: AssetKind, limit: number): Promise<AssetHit[]> {
  if (kind === AssetKind.Footage) return [];
  const query = kind === AssetKind.Logo ? `${/\blogo\b/i.test(q) ? q : `${q} logo`} filetype:drawing` : `${q} filetype:bitmap`;
  const data = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(
    commonsUrl({ generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: String(limit * 2), iiurlwidth: String(THUMB_WIDTH) }),
  );
  return Object.values(data.query?.pages ?? {})
    .sort((a, b) => a.index - b.index)
    .flatMap((p): AssetHit[] => {
      const info = p.imageinfo?.[0];
      const meta = info?.extmetadata ?? {};
      const license = plain(meta.LicenseShortName?.value, 40);
      if (!info?.thumburl || !COMMONS_OK.test(license)) return [];
      return [
        {
          id: `${AssetSource.Commons}:${p.title}`,
          kind,
          source: AssetSource.Commons,
          format: info.mime === SVG ? AssetFormat.Svg : AssetFormat.Raster,
          title: plain(meta.ObjectName?.value) || p.title.replace(/^File:/, ""),
          description: plain(meta.ImageDescription?.value),
          author: author(meta.Artist?.value),
          license,
          date: plain(meta.DateTimeOriginal?.value, 80).replace(/\b\w+ QS:\S+/g, "").trim().slice(0, 40),
          width: info.width,
          height: info.height,
          thumb: info.thumburl,
        },
      ];
    })
    .slice(0, limit);
}

export async function resolveCommons(ref: string): Promise<ResolvedAsset> {
  if (!/^File:/.test(ref)) throw new Error("commons ids look like commons:File:Name.jpg");
  type Pages = { query?: { pages?: Record<string, Omit<CommonsPage, "index">> } };
  const [data, small] = await Promise.all([
    getJson<Pages>(commonsUrl({ titles: ref, iiurlwidth: String(IMPORT_WIDTH) })),
    getJson<Pages>(commonsUrl({ titles: ref, iiurlwidth: String(PREVIEW_WIDTH) })),
  ]);
  const info = Object.values(data.query?.pages ?? {})[0]?.imageinfo?.[0];
  const previewInfo = Object.values(small.query?.pages ?? {})[0]?.imageinfo?.[0];
  if (!info) throw new Error(`no image ${ref} on Wikimedia Commons`);
  const meta = info.extmetadata ?? {};
  const license = plain(meta.LicenseShortName?.value, 40);
  if (!COMMONS_OK.test(license)) throw new Error(`${ref} is ${license || "unlicensed"}: not reusable`);
  const svg = info.mime === SVG;
  return {
    format: svg ? AssetFormat.Svg : AssetFormat.Raster,
    // Vectors come as the original SVG (rendered to PNG on import); photos as a large rendition.
    download: svg ? info.url : (info.thumburl ?? info.url),
    preview: svg ? undefined : (previewInfo?.thumburl ?? info.thumburl ?? info.url),
    credit: {
      kind: svg ? AssetKind.Logo : AssetKind.Photo,
      source: AssetSource.Commons,
      title: plain(meta.ObjectName?.value) || ref.replace(/^File:/, ""),
      author: author(meta.Artist?.value),
      license,
      licenseUrl: meta.LicenseUrl?.value ?? null,
      pageUrl: info.descriptionurl,
    },
  };
}
