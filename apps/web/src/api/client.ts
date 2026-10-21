import type { AgentRunUsage, Brick, BrickSlot, Project, ProjectListItem, User, VideoFormat, Voice, VoiceModel } from "@motionily/protocol";
import { useSession } from "../session";
import type { SoundRecipe } from "../audio/synth";
import type { AgentPrefs, GenerateState } from "../components/GeneratePanel";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3100";

export const AssetKind = { Logo: "logo", Screenshot: "screenshot", Photo: "photo", Video: "video", Other: "other" } as const;
export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];
/** Whether the user connected their ElevenLabs key, and its last characters. */
export type ElevenLabsStatus = { connected: boolean; hint: string | null };
export type BrandPalette = { name: string; background: string; surface: string; primary: string; accent: string; text: string };
export type BrandAsset = {
  id: string;
  kind: AssetKind;
  name: string;
  description: string;
  url: string;
  mime: string;
  /** Video clips: seconds, size and contact sheet (when the API could read the file). */
  duration?: number;
  width?: number;
  height?: number;
  poster?: string;
};
export type BrandSummary = { id: string; name: string; notes: string; palettes: BrandPalette[]; videos: number };
export type BrandKit = { id: string; name: string; notes: string; palettes: BrandPalette[]; assets: BrandAsset[] };
export const PrefabKind = { Object: "object", Character: "character", Space: "space" } as const;
export type PrefabKind = (typeof PrefabKind)[keyof typeof PrefabKind];
export type PrefabSummary = { name: string; kind: PrefabKind; description: string; parent?: string; version: number; updatedAt: string };

export type ConceptBeat = { at: string; what: string };
export type Concept = { title: string; hook: string; direction: string; beats: ConceptBeat[]; voiceover: string; prompt: string };
export type ConceptsRequest = { idea: string; format: VideoFormat; count: number; steer?: string; avoid?: string[]; model?: string; effort?: string; references?: string[]; angle?: number };
export const Platform = { Instagram: "instagram", TikTok: "tiktok" } as const;
export type Platform = (typeof Platform)[keyof typeof Platform];
export const PostStatus = { Scheduled: "scheduled", Posted: "posted" } as const;
export type PostStatus = (typeof PostStatus)[keyof typeof PostStatus];
/** The text that goes with the video on one platform; hashtags without "#". */
export type PostCopy = { platform: Platform; caption: string; hashtags: string[] };
/** A video on the posting calendar. `outdated`: the video was edited after this file was rendered. */
export type ScheduledPost = {
  id: string;
  projectId: string;
  projectName: string | null;
  format: VideoFormat | null;
  scheduledAt: string;
  platforms: Platform[];
  copy: PostCopy[];
  video: { url: string; mime: string; size: number; outdated: boolean } | null;
  status: PostStatus;
  postedAt: string | null;
  due: boolean;
};
export type SoundRow = { name: string; category: string; description: string; duration: number; url: string; recipe: SoundRecipe };
export type GoogleFont = { family: string; category: string; weights: number[]; popularity: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const HttpMethod = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE" } as const;
type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

async function call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const token = useSession.getState().token;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) useSession.getState().logout();
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string | string[] };
    throw new ApiError(res.status, [err.message ?? res.statusText].flat().join(", "));
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Absolute URL for media the API serves (e.g. the project audio). */
export const mediaUrl = (path: string) => `${API_URL}${path}`;

async function upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  body.append("file", file);
  const token = useSession.getState().token;
  const res = await fetch(`${API_URL}${path}`, { method: "POST", body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { message?: string }).message ?? res.statusText);
  return (await res.json()) as T;
}

export const api = {
  mockGoogle: (email: string, name?: string) =>
    call<{ token: string; user: User }>(HttpMethod.Post, "/auth/mock-google", { email, name }),
  bricks: (q: { slot?: BrickSlot; fits?: string } = {}) =>
    call<Brick[]>(HttpMethod.Get, `/bricks?${new URLSearchParams(q as Record<string, string>)}`),
  projects: () => call<ProjectListItem[]>(HttpMethod.Get, "/projects"),
  project: (id: string) => call<Project>(HttpMethod.Get, `/projects/${id}`),
  createProject: (name: string, brief: string, format: VideoFormat, brandId: string, voiceScript = "", references: string[] = []) =>
    call<Project>(HttpMethod.Post, "/projects", { name, brief, format, brandId, voiceScript, wantsScript: !!voiceScript, references }),
  concepts: (brandId: string, req: ConceptsRequest) => call<{ concepts: Concept[]; usage: AgentRunUsage | null }>(HttpMethod.Post, `/brands/${brandId}/concepts`, req),
  brands: () => call<BrandSummary[]>(HttpMethod.Get, "/brands"),
  brand: (id: string) => call<BrandKit>(HttpMethod.Get, `/brands/${id}`),
  createBrand: (name: string) => call<BrandKit>(HttpMethod.Post, "/brands", { name }),
  updateBrand: (id: string, patch: { name?: string; notes?: string; palettes?: BrandPalette[] }) => call<BrandKit>(HttpMethod.Patch, `/brands/${id}`, patch),
  deleteBrand: (id: string) => call<void>(HttpMethod.Delete, `/brands/${id}`),
  brandVideos: (id: string) => call<ProjectListItem[]>(HttpMethod.Get, `/brands/${id}/videos`),
  uploadAsset: (brandId: string, file: File, kind: AssetKind) => upload<BrandKit>(`/brands/${brandId}/assets`, file, { kind }),
  updateAsset: (brandId: string, assetId: string, patch: { kind?: AssetKind; name?: string; description?: string }) =>
    call<BrandKit>(HttpMethod.Patch, `/brands/${brandId}/assets/${assetId}`, patch),
  deleteAsset: (brandId: string, assetId: string) => call<BrandKit>(HttpMethod.Delete, `/brands/${brandId}/assets/${assetId}`),
  myPrefabs: () => call<PrefabSummary[]>(HttpMethod.Get, "/prefabs"),
  myPrefabTrees: () => call<{ name: string; node: Record<string, unknown> }[]>(HttpMethod.Get, "/prefabs?full=1"),
  clonePrefab: (name: string, newName: string) => call<unknown>(HttpMethod.Post, `/prefabs/${name}/clone`, { name: newName }),
  prefab: (name: string) => call<PrefabSummary & { node: Record<string, unknown> }>(HttpMethod.Get, `/prefabs/${name}`),
  prefabWorkshop: () => call<{ videoId: string }>(HttpMethod.Get, "/prefabs/-/workshop"),
  createPrefab: (instruction: string, prefs?: AgentPrefs) =>
    call<GenerateState & { videoId: string }>(HttpMethod.Post, "/prefabs/-/create", { instruction, ...prefs }),
  editPrefab: (name: string, instruction: string, prefs?: AgentPrefs) =>
    call<GenerateState & { videoId: string }>(HttpMethod.Post, `/prefabs/${name}/edit`, { instruction, ...prefs }),
  deletePrefab: (name: string) => call<void>(HttpMethod.Delete, `/prefabs/${name}`),
  updateProject: (id: string, patch: { name?: string; brief?: string; format?: VideoFormat; references?: string[] }) =>
    call<Project>(HttpMethod.Patch, `/projects/${id}`, patch),
  deleteProject: (id: string) => call<void>(HttpMethod.Delete, `/projects/${id}`),
  projectBricks: (id: string, slot?: BrickSlot) =>
    call<Brick[]>(HttpMethod.Get, `/projects/${id}/bricks${slot ? `?slot=${slot}` : ""}`),
  setSlot: (id: string, slot: BrickSlot, value: string | string[] | null, applyKitDefaults?: boolean) =>
    call<Project>(HttpMethod.Put, `/projects/${id}/build/${slot}`, { value, applyKitDefaults }),
  agentToken: (id: string) => call<{ token: string; projectId: string }>(HttpMethod.Post, `/projects/${id}/agent-token`),
  /** Account-wide agent token: the MCP can create videos and open any of them. */
  accountAgentToken: () => call<{ token: string }>(HttpMethod.Post, "/auth/agent-token"),
  saveScene: (id: string, scene: unknown, baseRevision: number) =>
    call<{ sceneRevision: number }>(HttpMethod.Put, `/projects/${id}/scene`, { scene, baseRevision }),
  /** A note for the agent; without `at` it is about the whole video. */
  addComment: (id: string, text: string, at?: number, layerId?: string) =>
    call<unknown>(HttpMethod.Post, `/projects/${id}/feedback`, { kind: "comment", text, at, layerId }),
  googleFonts: (q: string, category?: string) =>
    call<GoogleFont[]>(HttpMethod.Get, `/fonts?${new URLSearchParams({ q, ...(category ? { category } : {}) })}`),
  createProjectBrick: (id: string, brick: { slot: BrickSlot; id: string; name: string; description?: string; payload?: Record<string, unknown> }) =>
    call<Brick>(HttpMethod.Post, `/projects/${id}/bricks`, brick),
  /** The user's prefab library with full trees (for the engine). */
  prefabs: (id: string) => call<{ name: string; node: Record<string, unknown> }[]>(HttpMethod.Get, `/projects/${id}/prefabs?full=1`),
  generate: (id: string, instruction?: string, prefs?: AgentPrefs, references: string[] = [], extra: { resume?: boolean; sfxOnly?: boolean } = {}) =>
    call<GenerateState>(HttpMethod.Post, `/projects/${id}/generate`, { instruction: instruction || undefined, ...prefs, references: references.length ? references : undefined, ...extra }),
  sounds: () => call<SoundRow[]>(HttpMethod.Get, "/sounds"),
  saveSound: (s: { name: string; category: string; description: string; recipe: SoundRecipe; duration: number }, wav: Blob) =>
    upload<SoundRow[]>("/sounds", new File([wav], `${s.name}.wav`, { type: "audio/wav" }), {
      name: s.name,
      category: s.category,
      description: s.description,
      recipe: JSON.stringify(s.recipe),
      duration: String(s.duration),
    }),
  deleteSound: (name: string) => call<void>(HttpMethod.Delete, `/sounds/${name}`),
  designSound: (description: string) => call<{ name: string; category: string; description: string; recipe: SoundRecipe }>(HttpMethod.Post, "/sounds/-/design", { description }),
  /** A reference image pasted into a prompt; returns its media path. */
  /** Images come back as themselves; films as contact sheets (`urls`) plus their shot timing. */
  uploadReference: (file: File) => upload<{ url: string; urls?: string[]; film?: string }>("/references", file),
  generateStatus: (id: string) => call<GenerateState>(HttpMethod.Get, `/projects/${id}/generate`),
  stopGenerate: (id: string) => call<GenerateState>(HttpMethod.Delete, `/projects/${id}/generate`),
  uploadAudio: (id: string, file: File) => upload<Project>(`/projects/${id}/audio`, file),
  /** Background music for the video (replaces the previous file). */
  uploadMusic: (id: string, file: File) => upload<Project>(`/projects/${id}/music`, file),
  /** The user's own clip to edit; `language` is what is spoken in it (ISO 639-1). */
  uploadFootage: (id: string, file: File, language: string) => upload<Project>(`/projects/${id}/footage`, file, { language }),
  /** A clip's transcript, made here in the browser. */
  saveFootageWords: (id: string, clipId: string, words: { text: string; start: number; end: number }[]) =>
    call<Project>(HttpMethod.Put, `/projects/${id}/footage/${clipId}/words`, { words }),
  /** The user's ElevenLabs connection (their own key, kept encrypted by the API). */
  elevenLabs: () => call<ElevenLabsStatus>(HttpMethod.Get, "/voice/elevenlabs"),
  connectElevenLabs: (apiKey: string) => call<ElevenLabsStatus>(HttpMethod.Put, "/voice/elevenlabs", { apiKey }),
  disconnectElevenLabs: () => call<ElevenLabsStatus>(HttpMethod.Delete, "/voice/elevenlabs"),
  voices: () => call<Voice[]>(HttpMethod.Get, "/voice/voices"),
  /** Read the script aloud with an ElevenLabs voice; the project comes back with the audio and its words. */
  generateVoice: (id: string, body: { voiceId: string; voiceName?: string; modelId?: VoiceModel; text?: string }) => call<Project>(HttpMethod.Post, `/projects/${id}/voice`, body),
  /** Caption and hashtags per platform, written by Claude from the video (nothing is saved). */
  writeCopy: (projectId: string, platforms: Platform[], steer?: string) => call<{ copy: PostCopy[] }>(HttpMethod.Post, "/posts/copy", { projectId, platforms, steer: steer || undefined }),
  posts: (q: { from?: string; to?: string; due?: boolean; projectId?: string } = {}) =>
    call<ScheduledPost[]>(
      HttpMethod.Get,
      `/posts?${new URLSearchParams({ ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), ...(q.due ? { due: "1" } : {}), ...(q.projectId ? { projectId: q.projectId } : {}) })}`,
    ),
  createPost: (body: { projectId: string; scheduledAt: string; platforms: Platform[]; copy: PostCopy[] }) => call<ScheduledPost>(HttpMethod.Post, "/posts", body),
  updatePost: (id: string, patch: { scheduledAt?: string; platforms?: Platform[]; copy?: PostCopy[]; status?: PostStatus }) => call<ScheduledPost>(HttpMethod.Patch, `/posts/${id}`, patch),
  deletePost: (id: string) => call<void>(HttpMethod.Delete, `/posts/${id}`),
  /** The rendered file, tagged with the scene revision it shows. */
  uploadPostVideo: (id: string, video: Blob, filename: string, sceneRevision: number) =>
    upload<ScheduledPost>(`/posts/${id}/video`, new File([video], filename, { type: video.type }), { sceneRevision: String(sceneRevision) }),
};
