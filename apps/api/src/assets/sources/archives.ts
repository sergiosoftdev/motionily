import { AssetFormat, AssetKind, AssetSource, type AssetHit, type ResolvedAsset, type SearchContext } from "../asset-types";
import { getJson, plain } from "../http";
import { NO_KEY } from "./stock";

/**
 * Free archives for history: the Internet Archive (public-domain films, newsreels, the Prelinger
 * collection of industrial and educational films), the Metropolitan Museum's open-access images and
 * Europeana (Europe's museums and archives; needs a free key). Only reusable licenses come back.
 */

// ── Internet Archive (footage) ──
const IA_SEARCH = "https://archive.org/advancedsearch.php";
const IA_META = "https://archive.org/metadata";
/** Public-domain or open CC films; Prelinger is public domain by the collection's terms. */
const IA_OPEN = "(collection:prelinger OR licenseurl:*publicdomain* OR licenseurl:*licenses\\/by\\/* OR licenseurl:*licenses\\/by-sa\\/*)";
const IA_PAGE = (id: string) => `https://archive.org/details/${id}`;
/** Largest file worth downloading (the agent shows seconds of it). */
const IA_MAX_BYTES = 200 * 1024 * 1024;

type IaDoc = { identifier: string; title?: string; year?: number | string; creator?: string | string[]; licenseurl?: string; collection?: string | string[] };
type IaFile = { name: string; format?: string; size?: string; length?: string; width?: string; height?: string };

const isNc = (url?: string) => !!url && /\/(by-nc|by-nd|by-nc-sa|by-nc-nd)\//.test(url);
const iaLicense = (d: Pick<IaDoc, "licenseurl" | "collection">) =>
  d.licenseurl ? (/publicdomain|\/zero\//.test(d.licenseurl) ? "Public domain" : d.licenseurl.includes("by-sa") ? "CC BY-SA" : "CC BY") : "Public domain (Prelinger Archives)";
/** "02:15" / "135.4" -> seconds. */
const seconds = (len?: string) => (!len ? 0 : len.includes(":") ? len.split(":").reduce((s, p) => s * 60 + Number(p), 0) : Number(len));

/** The smallest-but-decent MP4 of an item (derivatives like *_512kb.mp4 first), under the size cap. */
function iaFile(files: IaFile[]): IaFile | undefined {
  return files
    .filter((f) => /\.(mp4|m4v)$/i.test(f.name) && Number(f.size ?? 0) > 0 && Number(f.size) <= IA_MAX_BYTES)
    .sort((a, b) => Number(b.size) - Number(a.size))[0];
}

export async function searchArchive(q: string, kind: AssetKind, limit: number): Promise<AssetHit[]> {
  if (kind !== AssetKind.Footage) return [];
  const params = new URLSearchParams({ q: `(${q}) AND mediatype:movies AND ${IA_OPEN}`, rows: String(limit * 2), output: "json" });
  for (const f of ["identifier", "title", "year", "creator", "licenseurl", "collection"]) params.append("fl[]", f);
  const answer = await getJson<{ response?: { docs?: IaDoc[] }; error?: string }>(`${IA_SEARCH}?${params}`);
  if (answer.error) throw new Error(answer.error.slice(0, 120));
  const docs = answer.response?.docs ?? [];
  // The file list says whether a usable MP4 exists and how long it runs.
  const hits = await Promise.all(
    docs.filter((d) => !isNc(d.licenseurl)).map(async (d): Promise<AssetHit | null> => {
      const meta = await getJson<{ files?: IaFile[] }>(`${IA_META}/${encodeURIComponent(d.identifier)}`).catch(() => null);
      const file = iaFile(meta?.files ?? []);
      if (!file) return null;
      return {
        id: `${AssetSource.Archive}:${d.identifier}`,
        kind,
        source: AssetSource.Archive,
        format: AssetFormat.Video,
        title: plain(d.title ?? d.identifier, 120),
        description: "Internet Archive",
        author: plain([d.creator ?? ""].flat().join(", "), 80) || "Internet Archive",
        license: iaLicense(d),
        date: String(d.year ?? ""),
        width: Number(file.width ?? 0),
        height: Number(file.height ?? 0),
        thumb: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
        duration: Math.round(seconds(file.length)),
      };
    }),
  );
  return hits.filter((h): h is AssetHit => !!h).slice(0, limit);
}

export async function resolveArchive(ref: string): Promise<ResolvedAsset> {
  if (!/^[\w.-]+$/.test(ref)) throw new Error("archive ids look like archive:<identifier>");
  const meta = await getJson<{ metadata?: IaDoc; files?: IaFile[] }>(`${IA_META}/${ref}`);
  const d = meta.metadata;
  if (!d) throw new Error(`no item ${ref} on the Internet Archive`);
  const open = [d.collection ?? []].flat().includes("prelinger") || (!!d.licenseurl && /publicdomain|creativecommons\.org\/licenses\/by(-sa)?\//.test(d.licenseurl) && !isNc(d.licenseurl));
  if (!open) throw new Error(`${ref} has no reusable license`);
  const file = iaFile(meta.files ?? []);
  if (!file) throw new Error(`${ref} has no MP4 under ${IA_MAX_BYTES / 1024 / 1024} MB`);
  return {
    format: AssetFormat.Video,
    download: `https://archive.org/download/${ref}/${encodeURIComponent(file.name)}`,
    credit: { kind: AssetKind.Footage, source: AssetSource.Archive, title: plain(d.title ?? ref, 120), author: plain([d.creator ?? ""].flat().join(", "), 80) || "Internet Archive", license: iaLicense(d), licenseUrl: d.licenseurl ?? null, pageUrl: IA_PAGE(ref) },
  };
}

// ── The Met (photos of objects, art, artifacts) ──
const MET = "https://collectionapi.metmuseum.org/public/collection";
type MetObject = { objectID: number; isPublicDomain: boolean; primaryImage: string; primaryImageSmall: string; title: string; artistDisplayName: string; objectDate: string; objectURL: string; department: string };

export async function searchMet(q: string, kind: AssetKind, limit: number): Promise<AssetHit[]> {
  if (kind !== AssetKind.Photo) return [];
  const found = await getJson<{ objectIDs?: number[] }>(`${MET}/v1.1/search?${new URLSearchParams({ q, hasImages: "true", limit: String(limit * 2) })}`);
  const objects = await Promise.all((found.objectIDs ?? []).slice(0, limit * 2).map((id) => getJson<MetObject>(`${MET}/v1/objects/${id}`).catch(() => null)));
  return objects
    .filter((o): o is MetObject => !!o && o.isPublicDomain && !!o.primaryImageSmall)
    .slice(0, limit)
    .map((o) => ({
      id: `${AssetSource.Met}:${o.objectID}`,
      kind,
      source: AssetSource.Met,
      format: AssetFormat.Raster,
      title: plain(o.title, 120) || "Untitled",
      description: `The Met · ${o.department}`,
      author: o.artistDisplayName || "The Metropolitan Museum of Art",
      license: "Public domain (CC0)",
      date: o.objectDate,
      width: 0,
      height: 0,
      thumb: o.primaryImageSmall,
    }));
}

export async function resolveMet(ref: string): Promise<ResolvedAsset> {
  if (!/^\d+$/.test(ref)) throw new Error("met ids look like met:12345");
  const o = await getJson<MetObject>(`${MET}/v1/objects/${ref}`);
  if (!o.isPublicDomain || !o.primaryImage) throw new Error(`met object ${ref} is not open access`);
  return {
    format: AssetFormat.Raster,
    download: o.primaryImage,
    preview: o.primaryImageSmall,
    credit: { kind: AssetKind.Photo, source: AssetSource.Met, title: plain(o.title, 120), author: o.artistDisplayName || "The Metropolitan Museum of Art", license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", pageUrl: o.objectURL },
  };
}

// ── Europeana (Europe's museums, archives, libraries) ──
const EUROPEANA = "https://api.europeana.eu/record/v2";
type EuropeanaItem = { id: string; title?: string[]; rights?: string[]; edmIsShownBy?: string[]; edmPreview?: string[]; guid?: string; dataProvider?: string[]; dcCreator?: string[]; year?: string[] };

function europeanaLicense(rights?: string) {
  if (!rights) return null;
  if (/publicdomain\/(zero|mark)/.test(rights)) return "Public domain";
  const m = /licenses\/(by(?:-sa)?)\/([\d.]+)/.exec(rights);
  return m ? `CC ${m[1]!.toUpperCase()} ${m[2]}` : null;
}

export async function searchEuropeana(q: string, kind: AssetKind, limit: number, ctx: SearchContext): Promise<AssetHit[]> {
  if (kind !== AssetKind.Photo && kind !== AssetKind.Texture) return [];
  if (!ctx.keys.europeana) throw new Error(NO_KEY);
  // "open" = public domain, CC0, CC BY, CC BY-SA.
  const params = new URLSearchParams({ wskey: ctx.keys.europeana, query: q, rows: String(limit * 2), reusability: "open", media: "true", qf: "TYPE:IMAGE", profile: "rich" });
  const data = await getJson<{ items?: EuropeanaItem[] }>(`${EUROPEANA}/search.json?${params}`);
  return (data.items ?? [])
    .flatMap((x): AssetHit[] => {
      const license = europeanaLicense(x.rights?.[0]);
      if (!license || !x.edmIsShownBy?.[0] || !x.edmPreview?.[0]) return [];
      return [
        {
          id: `${AssetSource.Europeana}:${x.id.replace(/^\//, "")}`,
          kind,
          source: AssetSource.Europeana,
          format: AssetFormat.Raster,
          title: plain(x.title?.[0] ?? "", 120) || "Untitled",
          description: `Europeana · ${plain(x.dataProvider?.[0] ?? "", 60)}`,
          author: plain(x.dcCreator?.[0] ?? x.dataProvider?.[0] ?? "", 80) || "Unknown",
          license,
          date: x.year?.[0] ?? "",
          width: 0,
          height: 0,
          thumb: x.edmPreview[0],
        },
      ];
    })
    .slice(0, limit);
}

export async function resolveEuropeana(ref: string, keys: SearchContext["keys"]): Promise<ResolvedAsset> {
  if (!keys.europeana) throw new Error(`Europeana: ${NO_KEY}`);
  if (!/^[\w-]+\/[\w-]+$/.test(ref)) throw new Error("europeana ids look like europeana:<dataset>/<item>");
  const data = await getJson<{ object?: { aggregations?: { edmIsShownBy?: string; edmRights?: { def?: string[] } }[]; title?: string[]; proxies?: { dcCreator?: { def?: string[] }; dcTitle?: { def?: string[] } }[] } }>(
    `${EUROPEANA}/${ref}.json?${new URLSearchParams({ wskey: keys.europeana })}`,
  );
  const agg = data.object?.aggregations?.[0];
  const license = europeanaLicense(agg?.edmRights?.def?.[0]);
  if (!agg?.edmIsShownBy || !license) throw new Error(`${ref} has no reusable image`);
  const proxy = data.object?.proxies?.find((p) => p.dcTitle?.def?.[0]) ?? data.object?.proxies?.[0];
  const preview = `https://api.europeana.eu/thumbnail/v2/url.json?${new URLSearchParams({ uri: agg.edmIsShownBy, type: "IMAGE", size: "w400" })}`;
  return {
    format: AssetFormat.Raster,
    download: agg.edmIsShownBy,
    preview,
    credit: {
      kind: AssetKind.Photo,
      source: AssetSource.Europeana,
      title: plain(data.object?.title?.[0] ?? proxy?.dcTitle?.def?.[0] ?? "", 120) || "Untitled",
      author: plain(proxy?.dcCreator?.def?.[0] ?? "", 80) || "Unknown",
      license,
      licenseUrl: agg.edmRights?.def?.[0] ?? null,
      pageUrl: `https://www.europeana.eu/item/${ref}`,
    },
  };
}
