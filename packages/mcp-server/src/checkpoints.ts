/**
 * Named snapshots of the scene, kept for this MCP session: try a change, see the diff, restore if
 * it was worse. Restoring replaces the whole scene in the editor (the same as load_scene).
 */
export type Scene = Record<string, unknown>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export class Checkpoints {
  private saved = new Map<string, { at: string; scene: Scene }>();

  save(name: string, scene: Scene): string {
    if (!NAME.test(name)) throw new Error(`checkpoint names: letters, digits, _ or - (1-40 chars), got '${name}'`);
    this.saved.set(name, { at: new Date().toISOString(), scene: structuredClone(scene) });
    return `checkpoint '${name}' saved (${layersOf(scene).length} layers)`;
  }

  get(name: string): Scene {
    const hit = this.saved.get(name);
    if (!hit) throw new Error(`no checkpoint '${name}'. Saved: ${this.names().join(", ") || "none"}`);
    return structuredClone(hit.scene);
  }

  names(): string[] {
    return [...this.saved.keys()];
  }

  list(): string {
    if (!this.saved.size) return "no checkpoints yet: checkpoint save NAME before a risky change";
    return [...this.saved].map(([n, c]) => `${n} · ${c.at} · ${layersOf(c.scene).length} layers`).join("\n");
  }
}

export const layersOf = (scene: Scene): Record<string, unknown>[] => (scene.layers as Record<string, unknown>[] | undefined) ?? [];

const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/** What changed from `a` to `b`: added, removed and changed layers with the keys that differ, then scene-level keys. */
export function diffScenes(a: Scene, b: Scene): string[] {
  const out: string[] = [];
  const byId = (s: Scene) => new Map(layersOf(s).map((l) => [String(l.id), l]));
  const [before, after] = [byId(a), byId(b)];
  for (const id of after.keys()) if (!before.has(id)) out.push(`+ ${id} (added)`);
  for (const id of before.keys()) if (!after.has(id)) out.push(`- ${id} (removed)`);
  for (const [id, next] of after) {
    const prev = before.get(id);
    if (!prev) continue;
    const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
    if (keys.length) out.push(`~ ${id}: ${keys.map((k) => `${k} ${short(prev[k])} to ${short(next[k])}`).join("; ")}`);
  }
  const sceneKeys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "layers" && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  for (const k of sceneKeys) out.push(`scene ${k}: ${short(a[k])} to ${short(b[k])}`);
  return out.length ? out : ["no differences"];
}
