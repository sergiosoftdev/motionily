/**
 * Videos the user approved, kept outside the repo (MOTIONILY_EXAMPLES or ~/.motionily/examples).
 * They are reference for the agent to read and learn from, never templates to paste: find_examples
 * returns the techniques they use and their first layers, and the agent writes its own scene.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Example = { label: string; tags: string[]; savedAt: string; width: number; height: number; duration: number; palette?: unknown; scene: Record<string, unknown> };

export const examplesDir = (): string => process.env.MOTIONILY_EXAMPLES ?? join(homedir(), ".motionily", "examples");

export function saveExample(dir: string, label: string, tags: string[], scene: Record<string, unknown>): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "example";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}-${Date.now().toString(36)}.json`);
  const entry: Example = {
    label,
    tags: tags.map((t) => t.toLowerCase().trim()).filter(Boolean),
    savedAt: new Date().toISOString(),
    width: Number(scene.width ?? 0),
    height: Number(scene.height ?? 0),
    duration: Number(scene.duration ?? 0),
    palette: scene.palette,
    scene,
  };
  writeFileSync(file, JSON.stringify(entry));
  return file;
}

export function loadExamples(dir: string): Example[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Example[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Example);
    } catch {
      // A damaged file is skipped, not fatal.
    }
  }
  return out;
}

/** Relevance: query words found in the label and tags, plus a bonus for the same frame shape. */
export function rankExamples(examples: Example[], query: string, width?: number, height?: number): Example[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const score = (e: Example) => {
    const text = `${e.label} ${e.tags.join(" ")}`.toLowerCase();
    const hits = words.filter((w) => text.includes(w)).length;
    const shape = width && height && e.width && e.height && Math.sign(e.width - e.height) === Math.sign(width - height) ? 0.5 : 0;
    return hits + shape;
  };
  return examples.map((e) => ({ e, s: score(e) })).filter((x) => x.s > 0 || !words.length).sort((a, b) => b.s - a.s).map((x) => x.e);
}

/** Techniques an example uses, read from its JSON: what an agent can reuse. */
export function techniques(scene: Record<string, unknown>): string[] {
  const json = JSON.stringify(scene);
  const out = new Set<string>();
  if (/"ease":"spring"/.test(json)) out.add("spring easing");
  if (/"ease":"back"/.test(json)) out.add("back overshoot");
  for (const m of json.matchAll(/"blend":"([a-z_]+)"/g)) out.add(`blend ${m[1]}`);
  if (/"fx":"glow"[^}]*"threshold"/.test(json)) out.add("glow threshold (bloom)");
  else if (/"fx":"glow"/.test(json)) out.add("glow");
  if (/"type":"particles"/.test(json)) out.add("particles");
  if (/"camera"/.test(json)) out.add("camera");
  if (/"matte"/.test(json)) out.add("track matte");
  if (/"animate":/.test(json)) out.add("per-unit text animation");
  if (/"gradient"/.test(json)) out.add("gradients");
  if (/"trim_end"|"trim_start"/.test(json)) out.add("path trim");
  return [...out];
}

/** One compact card per example: header, techniques, and the first `lines` layers in compact form. */
export function describeExample(e: Example, layerLines: (layer: Record<string, unknown>) => string, lines = 8): string {
  const layers = (e.scene.layers as Record<string, unknown>[] | undefined) ?? [];
  const head = `${e.label} · ${e.width}x${e.height} · ${e.duration}s · ${layers.length} layers${e.tags.length ? ` · tags: ${e.tags.join(", ")}` : ""}`;
  const tech = techniques(e.scene);
  return [head, tech.length ? `techniques: ${tech.join(", ")}` : "techniques: plain", ...layers.slice(0, lines).map(layerLines), layers.length > lines ? `… ${layers.length - lines} more layers (inspect ${String(layers[0]?.id ?? "")} to read any)` : ""]
    .filter(Boolean)
    .join("\n");
}
