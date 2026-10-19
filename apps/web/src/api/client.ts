import type { Brick, BrickSlot, Project, ProjectListItem, User, VideoFormat } from "@motionily/protocol";
import { useSession } from "../session";
import type { AgentPrefs, GenerateState } from "../components/GeneratePanel";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3100";

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

async function upload<T>(path: string, file: File): Promise<T> {
  const body = new FormData();
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
  createProject: (name: string, motionStyle: string, format: VideoFormat) =>
    call<Project>(HttpMethod.Post, "/projects", { name, motionStyle, format }),
  updateProject: (id: string, patch: { name?: string; brief?: string; format?: VideoFormat }) =>
    call<Project>(HttpMethod.Patch, `/projects/${id}`, patch),
  deleteProject: (id: string) => call<void>(HttpMethod.Delete, `/projects/${id}`),
  projectBricks: (id: string, slot?: BrickSlot) =>
    call<Brick[]>(HttpMethod.Get, `/projects/${id}/bricks${slot ? `?slot=${slot}` : ""}`),
  setSlot: (id: string, slot: BrickSlot, value: string | string[] | null, applyKitDefaults?: boolean) =>
    call<Project>(HttpMethod.Put, `/projects/${id}/build/${slot}`, { value, applyKitDefaults }),
  agentToken: (id: string) => call<{ token: string; projectId: string }>(HttpMethod.Post, `/projects/${id}/agent-token`),
  saveScene: (id: string, scene: unknown, baseRevision: number) =>
    call<{ sceneRevision: number }>(HttpMethod.Put, `/projects/${id}/scene`, { scene, baseRevision }),
  addComment: (id: string, text: string, at: number, layerId?: string) =>
    call<unknown>(HttpMethod.Post, `/projects/${id}/feedback`, { kind: "comment", text, at, layerId }),
  googleFonts: (q: string, category?: string) =>
    call<GoogleFont[]>(HttpMethod.Get, `/fonts?${new URLSearchParams({ q, ...(category ? { category } : {}) })}`),
  createProjectBrick: (id: string, brick: { slot: BrickSlot; id: string; name: string; description?: string; payload?: Record<string, unknown> }) =>
    call<Brick>(HttpMethod.Post, `/projects/${id}/bricks`, brick),
  /** The user's prefab library with full trees (for the engine). */
  prefabs: (id: string) => call<{ name: string; node: Record<string, unknown> }[]>(HttpMethod.Get, `/projects/${id}/prefabs?full=1`),
  generate: (id: string, instruction?: string, prefs?: AgentPrefs) =>
    call<GenerateState>(HttpMethod.Post, `/projects/${id}/generate`, { instruction: instruction || undefined, ...prefs }),
  generateStatus: (id: string) => call<GenerateState>(HttpMethod.Get, `/projects/${id}/generate`),
  stopGenerate: (id: string) => call<GenerateState>(HttpMethod.Delete, `/projects/${id}/generate`),
  uploadAudio: (id: string, file: File) => upload<Project>(`/projects/${id}/audio`, file),
};
