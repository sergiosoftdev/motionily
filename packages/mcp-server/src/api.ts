import type { Brick, BrickSlot, Feedback, Project } from "@motionily/protocol";

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

  update(patch: { format?: string }) {
    return this.call<Project>("PATCH", "", patch);
  }

  /** Google Fonts catalog search (public endpoint). */
  async fonts(q: string, category?: string) {
    const url = `${this.baseUrl}/fonts?${new URLSearchParams({ q, ...(category ? { category } : {}) })}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`font search failed (${res.status})`);
    return (await res.json()) as { family: string; category: string; weights: number[] }[];
  }

  consumeFeedback() {
    return this.call<Feedback[]>("POST", "/feedback/consume");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/projects/${this.projectId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
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
}
