import type { AgentRunUsage, AttentionDevice, Brick, BrickSlot, LibraryItem, MediaItem, PostLink, PostMetrics, PostPerformance, Project, ProjectListItem, ProviderKey, ProviderStatus, Series, SeriesBlueprint, SocialAccount, SocialPlatform, SunoPrompt, User, VideoFormat, Voice, VoiceModel } from "@motionily/protocol";
import { useSession } from "../session";
import type { AgentPrefs, GenerateState } from "../components/GeneratePanel";
import { desktop } from "../desktop";

declare global {
  interface Window {
    /** Set by an agent's headless editor (packages/mcp-server/src/headless.ts): the API it works on. */
    __MOTIONILY_API__?: string;
  }
}

export const API_URL = desktop?.apiUrl ?? (typeof window === "undefined" ? undefined : window.__MOTIONILY_API__) ?? import.meta.env.VITE_API_URL ?? "http://localhost:3100";

/** Agent CLIs Motionily drives (apps/api/src/common/agent-cli.ts). */
export const AgentCli = { Claude: "claude", Codex: "codex", Gemini: "gemini", OpenCode: "opencode" } as const;
export type AgentCli = (typeof AgentCli)[keyof typeof AgentCli];
export type AgentSettings = {
  cli: AgentCli;
  defaultCli: AgentCli;
  /** Motionily tier → the CLI's model id (CLIs other than Claude Code). */
  models: Record<string, string>;
  /** Every CLI, with its version when it is installed on the machine running the API. */
  clis: { cli: AgentCli; name: string; version: string | null }[];
};

/** One entry of a video's version history (automatic each minute of editing, or a named snapshot). */
export type SceneVersionRow = { id: string; revision: number; label: string; layers: number; duration: number; at: string };

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

/** A beat of a pitched concept; `energy` (0-100) and `device` trace its attention curve. */
export type ConceptBeat = { at: string; what: string; energy?: number; device?: AttentionDevice };
export type Concept = { title: string; hook: string; direction: string; beats: ConceptBeat[]; voiceover: string; prompt: string };
export type ConceptsRequest = { idea: string; format: VideoFormat; count: number; steer?: string; avoid?: string[]; model?: string; effort?: string; references?: string[]; angle?: number };
export const Platform = { Instagram: "instagram", TikTok: "tiktok", YouTube: "youtube" } as const;
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
  /** Where it was published, and the latest numbers there (once posted and the accounts are connected). */
  links: PostLink[];
  metrics: PostMetrics[];
};
/** How a library sound moves in time (SoundShape in apps/api/src/sounds/library.ts). */
export const SoundShape = { Hit: "hit", Build: "build", Swell: "swell", Steady: "steady" } as const;
export type SoundShape = (typeof SoundShape)[keyof typeof SoundShape];
/** A sound of Motionily's library: measured from its file (peak and hits are seconds into it). */
export type SoundRow = { name: string; category: string; description: string; duration: number; peak: number; shape: SoundShape; hits: number[]; every: number | null; url: string };
export type GoogleFont = { family: string; category: string; weights: number[]; popularity: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How clean_audio / Clean works: steady noise down (denoise) or speech kept and the rest dropped (voice). */
export const CleanMode = { Denoise: "denoise", Voice: "voice" } as const;
export type CleanMode = (typeof CleanMode)[keyof typeof CleanMode];

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
  createProject: (name: string, brief: string, format: VideoFormat | undefined, brandId: string | undefined, voiceScript = "", references: string[] = [], seriesId?: string) =>
    call<Project>(HttpMethod.Post, "/projects", { name, brief, format, brandId, voiceScript, wantsScript: !!voiceScript, references, seriesId }),
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
  updateProject: (id: string, patch: { name?: string; brief?: string; format?: VideoFormat; references?: string[]; postCopy?: PostCopy[] }) =>
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
  addComment: (id: string, text: string, at?: number, layerId?: string, references: string[] = []) =>
    call<unknown>(HttpMethod.Post, `/projects/${id}/feedback`, { kind: "comment", text, at, layerId, references: references.length ? references : undefined }),
  googleFonts: (q: string, category?: string) =>
    call<GoogleFont[]>(HttpMethod.Get, `/fonts?${new URLSearchParams({ q, ...(category ? { category } : {}) })}`),
  createProjectBrick: (id: string, brick: { slot: BrickSlot; id: string; name: string; description?: string; payload?: Record<string, unknown> }) =>
    call<Brick>(HttpMethod.Post, `/projects/${id}/bricks`, brick),
  /** The user's prefab library with full trees (for the engine). */
  prefabs: (id: string) => call<{ name: string; node: Record<string, unknown> }[]>(HttpMethod.Get, `/projects/${id}/prefabs?full=1`),
  generate: (id: string, instruction?: string, prefs?: AgentPrefs, references: string[] = [], extra: { resume?: boolean; sfxOnly?: boolean } = {}) =>
    call<GenerateState>(HttpMethod.Post, `/projects/${id}/generate`, { instruction: instruction || undefined, ...prefs, references: references.length ? references : undefined, ...extra }),
  sounds: () => call<SoundRow[]>(HttpMethod.Get, "/sounds"),
  /** A reference image pasted into a prompt; returns its media path. */
  /** Images come back as themselves; films as contact sheets (`urls`) plus their shot timing. */
  uploadReference: (file: File) => upload<{ url: string; urls?: string[]; film?: string }>("/references", file),
  generateStatus: (id: string) => call<GenerateState>(HttpMethod.Get, `/projects/${id}/generate`),
  stopGenerate: (id: string) => call<GenerateState>(HttpMethod.Delete, `/projects/${id}/generate`),
  uploadAudio: (id: string, file: File) => upload<Project>(`/projects/${id}/audio`, file),
  /** Claude writes the Suno prompt for the video's music (kept with the video); `steer` asks for changes. */
  sunoPrompt: (id: string, steer?: string) => call<SunoPrompt>(HttpMethod.Post, `/projects/${id}/suno-prompt`, { steer: steer || undefined }),
  /** Background music for the video (replaces the previous file). */
  uploadMusic: (id: string, file: File) => upload<Project>(`/projects/${id}/music`, file),
  /** The user's own clip to edit; `language` is what is spoken in it (ISO 639-1). */
  uploadRender: (id: string, file: File) => upload<{ url: string; size: number }>(`/projects/${id}/renders`, file),
  versions: (id: string) => call<SceneVersionRow[]>(HttpMethod.Get, `/projects/${id}/versions`),
  saveVersion: (id: string, label?: string) => call<{ id: string }>(HttpMethod.Post, `/projects/${id}/versions`, { label }),
  version: (id: string, versionId: string) => call<{ id: string; label: string; scene: Record<string, unknown> }>(HttpMethod.Get, `/projects/${id}/versions/${versionId}`),
  projectMedia: (id: string) => call<MediaItem[]>(HttpMethod.Get, `/projects/${id}/media`),
  uploadMedia: (id: string, file: File) => upload<MediaItem>(`/projects/${id}/media`, file),
  removeMedia: (id: string, mediaId: string) => call<{ ok: true }>(HttpMethod.Delete, `/projects/${id}/media/${mediaId}`),
  /** Put clips (c1…) and pool items (m1…) in a bin, or back at the top (null). */
  setBin: (id: string, ids: string[], bin: string | null) => call<{ moved: number }>(HttpMethod.Post, `/projects/${id}/media/bin`, { ids, bin }),
  /** Clips, sounds and the voice-over whose files are gone from the media folder. */
  missingMedia: (id: string) => call<{ kind: string; id: string; name: string; file: string; size: number | null }[]>(HttpMethod.Get, `/projects/${id}/media/missing`),
  /** Look for missing files in a folder (desktop app) by name and size and copy them back in. */
  relinkMedia: (id: string, folder: string) => call<{ relinked: string[]; missing: string[] }>(HttpMethod.Post, `/projects/${id}/media/relink`, { folder }),
  /** Make (or remake) a clip's 540p preview proxy. */
  makeProxy: (id: string, source: string) => call<{ proxy: string }>(HttpMethod.Post, `/projects/${id}/media/proxy`, { source }),
  /** A stabilized copy of a clip (a new clip, same timing); `method` = vid.stab or deshake. */
  stabilize: (id: string, body: { source: string; strength?: number }) => call<{ footage: string; url: string; method: string }>(HttpMethod.Post, `/projects/${id}/media/stabilize`, body),
  /** A cleaned copy of a sound or clip (new pool sound), or of the voice-over (`source` "voice", replaced in place). */
  cleanMedia: (id: string, body: { source: string; mode: CleanMode; strength?: number }) => call<MediaItem | { voice: string; original: MediaItem }>(HttpMethod.Post, `/projects/${id}/media/clean`, body),
  uploadFootage: (id: string, file: File, language: string) => upload<Project>(`/projects/${id}/footage`, file, { language }),
  /** A clip's transcript, made here in the browser. */
  saveFootageWords: (id: string, clipId: string, words: { text: string; start: number; end: number }[]) =>
    call<Project>(HttpMethod.Put, `/projects/${id}/footage/${clipId}/words`, { words }),
  /** The user's ElevenLabs connection (their own key, kept encrypted by the API). */
  elevenLabs: () => call<ElevenLabsStatus>(HttpMethod.Get, "/voice/elevenlabs"),
  connectElevenLabs: (apiKey: string) => call<ElevenLabsStatus>(HttpMethod.Put, "/voice/elevenlabs", { apiKey }),
  disconnectElevenLabs: () => call<ElevenLabsStatus>(HttpMethod.Delete, "/voice/elevenlabs"),
  /** Star a video: agents study favorites as the user's taste. */
  setFavorite: (id: string, favorite: boolean) => call<{ favorite: boolean }>(HttpMethod.Put, `/projects/${id}/favorite`, { favorite }),
  /** The user's own keys for asset sources (stock libraries, web image search, image generation). */
  providerKeys: () => call<ProviderStatus[]>(HttpMethod.Get, "/keys"),
  agentSettings: () => call<AgentSettings>(HttpMethod.Get, "/settings/agent"),
  saveAgentSettings: (cli: AgentCli, models: Record<string, string>) => call<AgentSettings>(HttpMethod.Put, "/settings/agent", { cli, models }),
  connectProviderKey: (provider: ProviderKey, apiKey: string) => call<ProviderStatus[]>(HttpMethod.Put, `/keys/${provider}`, { apiKey }),
  disconnectProviderKey: (provider: ProviderKey) => call<ProviderStatus[]>(HttpMethod.Delete, `/keys/${provider}`),
  /** Everything agents imported, cut out or generated, reusable in every video. */
  library: () => call<LibraryItem[]>(HttpMethod.Get, "/library?limit=500"),
  removeLibraryItem: (id: string) => call<{ ok: true }>(HttpMethod.Delete, `/library/${encodeURIComponent(id)}`),
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
  /** Instagram, TikTok and YouTube accounts (the user's own developer apps), for the numbers of what they post. */
  socialAccounts: () => call<{ accounts: SocialAccount[]; youtubeRedirect: string }>(HttpMethod.Get, "/social/accounts"),
  connectInstagram: (token: string) => call<SocialAccount[]>(HttpMethod.Put, "/social/instagram", { token }),
  startTikTok: (app: { clientKey: string; clientSecret: string; redirectUri: string }) => call<{ authorizeUrl: string }>(HttpMethod.Post, "/social/tiktok/start", app),
  finishTikTok: (url: string) => call<SocialAccount[]>(HttpMethod.Post, "/social/tiktok/finish", { url }),
  startYouTube: (app: { clientId: string; clientSecret: string }) => call<{ authorizeUrl: string }>(HttpMethod.Post, "/social/youtube/start", app),
  disconnectSocial: (platform: SocialPlatform) => call<SocialAccount[]>(HttpMethod.Delete, `/social/${platform}`),
  syncSocial: () => call<{ synced: number; errors: string[] }>(HttpMethod.Post, "/social/sync"),
  /** A post's published copy by its link (found on the connected account), then measured. */
  linkPost: (id: string, platform: SocialPlatform, url: string) => call<ScheduledPost>(HttpMethod.Post, `/posts/${id}/links`, { platform, url }),
  unlinkPost: (id: string, platform: SocialPlatform) => call<ScheduledPost>(HttpMethod.Delete, `/posts/${id}/links/${platform}`),
  syncPost: (id: string) => call<{ post: ScheduledPost; errors: string[] }>(HttpMethod.Post, `/posts/${id}/sync`),
  /** Every posted copy of this video with its numbers. */
  performance: (projectId: string) => call<PostPerformance[]>(HttpMethod.Get, `/projects/${projectId}/performance`),
  /** Series templates: a video's structure saved to make more episodes with other content. */
  series: (brandId?: string) => call<Series[]>(HttpMethod.Get, `/series${brandId ? `?brandId=${brandId}` : ""}`),
  saveSeries: (projectId: string, body: { name: string; note?: string; blueprint: SeriesBlueprint }) => call<Series>(HttpMethod.Post, `/projects/${projectId}/series`, body),
  seriesOf: (projectId: string) => call<{ series: Series | null }>(HttpMethod.Get, `/projects/${projectId}/series`),
  deleteSeries: (id: string) => call<void>(HttpMethod.Delete, `/series/${id}`),
  /** The rendered file, tagged with the scene revision it shows. */
  uploadPostVideo: (id: string, video: Blob, filename: string, sceneRevision: number) =>
    upload<ScheduledPost>(`/posts/${id}/video`, new File([video], filename, { type: video.type }), { sceneRevision: String(sceneRevision) }),
};
