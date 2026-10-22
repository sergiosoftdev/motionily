import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Wikimedia asks every client to identify itself; the others do not mind. */
export const HEADERS = { "User-Agent": "Motionily/0.1 (https://github.com/sergiosoftdev/motionily)" };
/** A slow source must not sink the whole search. */
export const SOURCE_TIMEOUT_MS = 8000;
const TEXT_MAX = 200;

export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { ...HEADERS, ...headers }, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Source metadata often comes as HTML. */
export function plain(html: string | undefined | null, max = TEXT_MAX) {
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

export const IMAGE_EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
export const SVG_MIME = "image/svg+xml";
export const VIDEO_EXT: Record<string, string> = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" };

const MAX_REDIRECTS = 4;

/**
 * Download a file whose type is one of `types` (mime -> extension), refusing anything bigger than
 * maxBytes. `untrusted` (web search results) checks every hop of the redirect chain is public.
 */
export async function download(url: string, maxBytes: number, types: Record<string, string>, opts: { timeoutMs?: number; untrusted?: boolean } = {}) {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? SOURCE_TIMEOUT_MS * 3);
  let res: Response;
  let at = url;
  for (let hop = 0; ; hop++) {
    if (opts.untrusted) await assertPublicUrl(at);
    res = await fetch(at, { headers: HEADERS, signal, redirect: opts.untrusted ? "manual" : "follow" });
    const next = res.headers.get("location");
    if (!opts.untrusted || res.status < 300 || res.status >= 400 || !next) break;
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    at = new URL(next, at).toString();
  }
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = types[mime] ?? (mime === "application/octet-stream" || mime === "binary/octet-stream" ? guessExt(url, types) : undefined);
  if (!ext) throw new Error(`not a usable file (${mime || "unknown type"})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error(`file too large (${Math.round(declared / 1e6)} MB)`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`file too large (${Math.round(bytes.length / 1e6)} MB)`);
  return { bytes, ext, mime };
}

function guessExt(url: string, types: Record<string, string>) {
  const ext = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return ext ? Object.values(types).find((e) => e === `.${ext}`) : undefined;
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/**
 * URLs that come from a web search point anywhere: refuse non-http(s) and hosts that resolve to
 * private or loopback addresses, so a search result can never make the API fetch its own network.
 */
export async function assertPublicUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) images");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const a of addresses) {
    const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
    if (PRIVATE_V4.some((r) => r.test(v4)) || v4 === "::1" || /^f[cd]/i.test(v4) || /^fe80/i.test(v4)) throw new Error("that address is not public");
  }
}
