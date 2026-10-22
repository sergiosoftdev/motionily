import { AssetFormat, AssetKind, AssetSource, type AssetHit, type ResolvedAsset } from "../asset-types";
import { getJson, plain } from "../http";

/** Openverse: openly licensed photos from Flickr, museums and many smaller collections. */
const OPENVERSE_API = "https://api.openverse.org/v1/images";
const LICENSES = "by,by-sa,cc0,pdm";
const LABEL: Record<string, string> = { by: "CC BY", "by-sa": "CC BY-SA", cc0: "CC0", pdm: "Public domain" };

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

const license = (x: OpenverseImage) => [LABEL[x.license] ?? x.license.toUpperCase(), x.license === "pdm" || x.license === "cc0" ? "" : (x.license_version ?? "")].join(" ").trim();

/** No shape filter: archive photos are scarce, and a cover crop or a framed print fits any of them. */
export async function searchOpenverse(q: string, kind: AssetKind, limit: number): Promise<AssetHit[]> {
  if (kind === AssetKind.Footage || kind === AssetKind.Logo) return [];
  const query = kind === AssetKind.Texture && !/texture/i.test(q) ? `${q} texture` : q;
  const data = await getJson<{ results: OpenverseImage[] }>(`${OPENVERSE_API}/?${new URLSearchParams({ q: query, license: LICENSES, page_size: String(limit) })}`);
  return data.results.map((x) => ({
    id: `${AssetSource.Openverse}:${x.id}`,
    kind,
    source: AssetSource.Openverse,
    format: AssetFormat.Raster,
    title: plain(x.title ?? "") || "Untitled",
    description: `via ${x.source}`,
    author: plain(x.creator ?? "", 80) || "Unknown",
    license: license(x),
    date: "",
    width: x.width ?? 0,
    height: x.height ?? 0,
    thumb: x.thumbnail,
  }));
}

export async function resolveOpenverse(ref: string): Promise<ResolvedAsset> {
  if (!/^[a-f0-9-]{36}$/.test(ref)) throw new Error("openverse ids look like openverse:<uuid>");
  const x = await getJson<OpenverseImage>(`${OPENVERSE_API}/${ref}/`);
  if (!LICENSES.split(",").includes(x.license)) throw new Error(`${ref} is ${x.license}: not reusable`);
  return {
    format: AssetFormat.Raster,
    download: x.url,
    preview: x.thumbnail,
    credit: {
      kind: AssetKind.Photo,
      source: AssetSource.Openverse,
      title: plain(x.title ?? "") || "Untitled",
      author: plain(x.creator ?? "", 80) || "Unknown",
      license: license(x),
      licenseUrl: x.license_url,
      pageUrl: x.foreign_landing_url,
    },
  };
}
