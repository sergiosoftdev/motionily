import type { AssetKind, Brick, BrickSlot, Direction, FavoriteVideo, Feedback, Fingerprint, Genre, ImageCredit, ImageHit, LibraryItem, Project, User } from "@motionily/protocol";
import type { LibrarySound } from "./sounds.js";

/** Motionily API client for one project, with an agent-scoped token. */
export class ProjectApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly projectId: string,
  ) {}

  project() {
    return this.call<Project>("GET", "");
  }

  bricks(slot?: BrickSlot) {
    return this.call<Brick[]>("GET", `/bricks${slot ? `?slot=${slot}` : ""}`);
  }

  createBrick(brick: { slot: BrickSlot; id: string; name: string; description?: string; payload?: Record<string, unknown> }) {
    return this.call<Brick>("POST", "/bricks", brick);
  }

  setSlot(slot: BrickSlot, value: string | string[] | null, applyKitDefaults?: boolean) {
    return this.call<Project>("PUT", `/build/${slot}`, { value, applyKitDefaults });
  }

  /** Where the voice file is really silent (file seconds), measured from its sound. */
  voiceSilences() {
    return this.call<{ silences: [number, number][] }>("GET", "/voice/silences");
  }

  /** Motionily's sound effect library (the same for every account). */
  sounds() {
    return this.call<LibrarySound[]>("GET", "/sounds");
  }

  /** Session for the agent's headless editor. */
  headlessSession() {
    return this.call<{ token: string; user: User }>("POST", "/headless-token");
  }

  update(patch: { format?: string; voiceScript?: string }) {
    return this.call<Project>("PATCH", "", patch);
  }

  /** Google Fonts catalog search (public endpoint). */
  async fonts(q: string, category?: string) {
    const url = `${this.baseUrl}/fonts?${new URLSearchParams({ q, ...(category ? { category } : {}) })}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`font search failed (${res.status})`);
    return (await res.json()) as { family: string; category: string; weights: number[] }[];
  }

  prefabs() {
    return this.call<{ name: string; kind: string; description: string; parent?: string; version: number }[]>("GET", "/prefabs");
  }

  prefab(name: string) {
    return this.call<{ name: string; kind: string; description: string; node: Record<string, unknown> }>("GET", `/prefabs/${name}`);
  }

  savePrefab(name: string, body: { kind: string; node: Record<string, unknown>; description?: string }) {
    return this.call<unknown>("PUT", `/prefabs/${name}`, body);
  }

  clonePrefab(from: string, to: string, description?: string) {
    return this.call<{ node: Record<string, unknown> }>("POST", `/prefabs/${from}/clone`, { name: to, description });
  }

  brand() {
    return this.call<{
      name: string;
      notes: string;
      palettes: { name: string; background: string; surface: string; primary: string; accent: string; text: string }[];
      assets: BrandAsset[];
    }>("GET", "/brand");
  }

  /** Raw bytes of a media file the API serves (brand images, clip contact sheets). */
  async media(path: string) {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`image not found (${res.status})`);
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "image/png" };
  }

  /** Every query against every source of its kind; one numbered contact sheet (base64 JPEG) per query. */
  searchAssets(queries: { q: string; kind: AssetKind }[], perQuery: number) {
    return this.call<{ groups: { q: string; kind: AssetKind; hits: ImageHit[]; sheet: string | null }[]; unavailable: string[]; missingKeys: string[] }>("POST", "/assets/search", { queries, perQuery });
  }

  /** Download hits (or library items) into the video and the user's library, with their credits. */
  importAssets(ids: string[], query?: string) {
    return this.call<{ id: string; credit?: ImageCredit; error?: string }[]>("POST", "/assets/import", { ids, ...(query ? { query } : {}) });
  }

  /** The subject of a /media image on a transparent background. */
  cutout(src: string) {
    return this.call<ImageCredit>("POST", "/assets/cutout", { src });
  }

  /** An image generated with the user's own OpenAI key. */
  generateImage(prompt: string, transparent: boolean, orientation?: string) {
    return this.call<ImageCredit & { revisedPrompt: string | null }>("POST", "/assets/generate", { prompt, transparent, ...(orientation ? { orientation } : {}) });
  }

  library(kind?: AssetKind, limit?: number) {
    const params = new URLSearchParams({ ...(kind ? { kind } : {}), ...(limit ? { limit: String(limit) } : {}) });
    return this.call<LibraryItem[]>("GET", `/assets/library?${params}`);
  }

  /** Iconify icon ids for words (reusable sets only). */
  icons(q: string, limit: number) {
    return this.call<{ id: string; set: string; license: string; category: string; multicolor: boolean }[]>("GET", `/assets/icons?${new URLSearchParams({ q, limit: String(limit) })}`);
  }

  /** SVG bodies of Iconify icons (the API records credits for sets that ask for them). */
  iconData(ids: string[]) {
    return this.call<{ icons: { id: string; body: string; width: number; height: number; set: string; license: string; multicolor: boolean }[]; missing: string[] }>(
      "GET",
      `/assets/icon-data?${new URLSearchParams({ ids: ids.join(",") })}`,
    );
  }

  /** The account's other starred videos (the user's taste). */
  favorites() {
    return this.call<FavoriteVideo[]>("GET", "/favorites");
  }

  favoriteScene(id: string) {
    return this.call<{ id: string; name: string; direction: Direction | null; scene: Record<string, unknown> | null }>("GET", `/favorites/${id}`);
  }

  setFavorite(favorite: boolean) {
    return this.call<{ favorite: boolean }>("PUT", "/favorite", { favorite });
  }

  direction() {
    return this.call<{ direction: Direction | null; constraints: string[]; recent: Fingerprint[]; genres: Genre[] }>("GET", "/direction");
  }

  setDirection(body: { genre: Genre; concept: string; techniques: string[]; redraw?: boolean }) {
    return this.call<{ direction: Direction; constraints: string[]; references: { genre: Genre; title: string; look: string; moves: string }[]; recent: Fingerprint[] }>("PUT", "/direction", body);
  }

  /** Text of a media file (a sanitized SVG). */
  async mediaText(path: string) {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`file not found (${res.status})`);
    return res.text();
  }

  /** Every note of the project, read and unread, without marking any as read. */
  feedback() {
    return this.call<(Feedback & { _id: string; consumedAt: string | null })[]>("GET", "/feedback");
  }

  consumeFeedback() {
    return this.call<Feedback[]>("POST", "/feedback/consume");
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.projectId) return Promise.reject(new Error(NO_PROJECT));
    return request<T>(this.baseUrl, this.token, method, `/projects/${this.projectId}${path}`, body);
  }
}

/** Scope of an account-wide agent token (the API's TokenScope.Account). */
export const ACCOUNT_SCOPE = "account";

export const NO_PROJECT = "No video is open yet. Call list_projects, then open_project or create_project.";

/** A video as the account lists it. */
export type VideoRow = { _id: string; name: string; format: string; brandId?: string; updatedAt: string };
/** A brand kit (what the API calls a project in the UI) that videos live in. */
export type BrandRow = { id: string; name: string; notes: string; videos: number };

/** Account-level client: lists and creates videos and gets each one's project token. Nothing else. */
export class AccountApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  videos() {
    return request<VideoRow[]>(this.baseUrl, this.token, "GET", "/projects");
  }

  brands() {
    return request<BrandRow[]>(this.baseUrl, this.token, "GET", "/brands");
  }

  create(video: { name: string; brief?: string; format?: string; voiceScript?: string; brandId?: string }) {
    return request<Project>(this.baseUrl, this.token, "POST", "/projects", video);
  }

  projectToken(id: string) {
    return request<{ token: string; projectId: string }>(this.baseUrl, this.token, "POST", `/projects/${id}/agent-token`);
  }
}

async function request<T>(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string | string[] };
    const msg = [err.message ?? res.statusText].flat().join(", ");
    throw new Error(res.status === 401 ? "Motionily token expired or invalid. Ask the user for a new one (Conectar agente)." : msg);
  }
  return (await res.json()) as T;
}

// --- video clips in the brand kit ---
/** A brand image or clip. Clips (`kind: "video"`) carry length, size and a contact sheet when the API could read them. */
export type BrandAsset = {
  id: string;
  kind: string;
  name: string;
  description: string;
  url: string;
  mime: string;
  duration?: number;
  width?: number;
  height?: number;
  poster?: string;
};

export const VIDEO_ASSET = "video";
/** Frames in a clip's contact sheet (4 × 3, the API's reference-film sheet). */
const POSTER_FRAMES = 12;

/** Seconds of each frame of a clip's contact sheet, left to right, top to bottom. */
export function posterTimes(duration: number): number[] {
  return Array.from({ length: POSTER_FRAMES }, (_, i) => +((duration * (i + 0.5)) / POSTER_FRAMES).toFixed(2));
}

/** `12.40s 1920×1080 · video layer` — what get_brand prints for a clip. */
export function clipFacts(a: BrandAsset): string {
  const size = a.width && a.height ? ` ${a.width}×${a.height}` : "";
  return a.duration ? `${a.duration.toFixed(2)}s${size} · use in a video layer` : "length unknown (render_frames to check it) · use in a video layer";
}
// --- end video clips ---
