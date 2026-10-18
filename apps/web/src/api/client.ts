import type { Brick, BrickSlot, Project, ProjectListItem, User } from "@motionily/protocol";
import { useSession } from "../session";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3100";

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

export const api = {
  mockGoogle: (email: string, name?: string) =>
    call<{ token: string; user: User }>(HttpMethod.Post, "/auth/mock-google", { email, name }),
  bricks: (q: { slot?: BrickSlot; fits?: string } = {}) =>
    call<Brick[]>(HttpMethod.Get, `/bricks?${new URLSearchParams(q as Record<string, string>)}`),
  projects: () => call<ProjectListItem[]>(HttpMethod.Get, "/projects"),
  project: (id: string) => call<Project>(HttpMethod.Get, `/projects/${id}`),
  createProject: (name: string, motionStyle: string) =>
    call<Project>(HttpMethod.Post, "/projects", { name, motionStyle }),
  updateProject: (id: string, patch: { name?: string; brief?: string }) =>
    call<Project>(HttpMethod.Patch, `/projects/${id}`, patch),
  deleteProject: (id: string) => call<void>(HttpMethod.Delete, `/projects/${id}`),
  projectBricks: (id: string, slot?: BrickSlot) =>
    call<Brick[]>(HttpMethod.Get, `/projects/${id}/bricks${slot ? `?slot=${slot}` : ""}`),
  setSlot: (id: string, slot: BrickSlot, value: string | string[] | null, applyKitDefaults?: boolean) =>
    call<Project>(HttpMethod.Put, `/projects/${id}/build/${slot}`, { value, applyKitDefaults }),
  saveScene: (id: string, scene: unknown, baseRevision: number) =>
    call<{ sceneRevision: number }>(HttpMethod.Put, `/projects/${id}/scene`, { scene, baseRevision }),
  addComment: (id: string, text: string, at: number) =>
    call<unknown>(HttpMethod.Post, `/projects/${id}/feedback`, { kind: "comment", text, at }),
};
