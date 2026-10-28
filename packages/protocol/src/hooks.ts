/**
 * Hook variants: one video with several openings. Layers marked `variant: "A" | "B"…` only play in
 * that version (the scene's `variant` picks which; the first by default); everything else is the body
 * every version shares. Mirrors `Scene::variants`, `active_variant` and `variant_off` in the engine.
 */
import { OpName, type Op } from "./index.js";

/** Seconds the hook covers: what decides the swipe. */
export const HOOK_SECONDS = 3;
/** A layer that runs past this is part of the body, not the hook (a background, a running title). */
const HOOK_ENDS_BY = HOOK_SECONDS + 2;

type LayerLike = { id?: unknown; variant?: unknown; start?: unknown; end?: unknown; parent?: unknown; matte?: unknown; attach?: unknown; [k: string]: unknown };
type SceneLike = { layers?: unknown; variant?: unknown; duration?: unknown };

const layersOf = (s: SceneLike): LayerLike[] => (Array.isArray(s.layers) ? (s.layers as LayerLike[]) : []);
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Every variant the layers name, sorted. */
export function sceneVariants(scene: SceneLike): string[] {
  return [...new Set(layersOf(scene).map((l) => l.variant).filter((v): v is string => typeof v === "string" && v !== ""))].sort();
}

/** The variant that plays: the scene's when a layer has it, else the first (null without variants). */
export function activeVariant(scene: SceneLike): string | null {
  const all = sceneVariants(scene);
  return typeof scene.variant === "string" && all.includes(scene.variant) ? scene.variant : (all[0] ?? null);
}

/** The scene as one version plays it: the other variants' layers left out. */
export function forVariant<S extends SceneLike>(scene: S, variant?: string | null): S {
  const all = sceneVariants(scene);
  if (!all.length) return scene;
  const v = variant && all.includes(variant) ? variant : activeVariant(scene);
  return { ...scene, variant: v, layers: layersOf(scene).filter((l) => typeof l.variant !== "string" || l.variant === v) };
}

/** What a variant opens with: its first text, else its first layer's id. */
export function variantHook(scene: SceneLike, variant: string): string {
  const mine = layersOf(scene)
    .filter((l) => l.variant === variant)
    .sort((a, b) => num(a.start) - num(b.start));
  const text = mine.find((l) => typeof l.text === "string")?.text as string | undefined;
  return (text ?? String(mine[0]?.id ?? "")).replace(/[*_]/g, "").replace(/\s+/g, " ").trim();
}

/** Next free variant letter ("B" after "A"). */
export function nextVariant(taken: string[]): string {
  for (let i = 0; i < 26; i++) {
    const v = String.fromCharCode(65 + i);
    if (!taken.includes(v)) return v;
  }
  return `V${taken.length + 1}`;
}

/** The playing version's hook: layers that come in during the first seconds and are gone soon after (not the ones that last the whole video). */
export function hookLayers(scene: SceneLike): LayerLike[] {
  const duration = num(scene.duration, Infinity);
  return layersOf(forVariant(scene)).filter((l) => {
    const end = l.end == null ? duration : num(l.end, duration);
    return num(l.start) < HOOK_SECONDS && end <= HOOK_ENDS_BY && end < duration - 0.01;
  });
}

/**
 * Ops that copy the playing hook into a new variant, right above the original layers, and show it:
 * the user (or the agent) then rewrites the copy. The first time, the current hook becomes "A".
 * Null when the opening has nothing on screen to copy (a voice-only hook).
 */
export function newHookOps(scene: SceneLike): { variant: string; ops: Op[] } | null {
  const hook = hookLayers(scene);
  if (!hook.length) return null;
  const all = sceneVariants(scene);
  const ops: Op[] = [];
  const ids = new Set(layersOf(scene).map((l) => String(l.id)));
  const variant = nextVariant(all.length ? all : ["A"]);
  const untagged = hook.filter((l) => typeof l.variant !== "string").map((l) => String(l.id));
  if (untagged.length) ops.push({ op: OpName.Patch, ids: untagged, fields: { variant: activeVariant(scene) ?? "A" } });
  const rename = new Map<string, string>();
  for (const l of hook) {
    let id = `${String(l.id)}-${variant.toLowerCase()}`;
    for (let n = 2; ids.has(id); n++) id = `${String(l.id)}-${variant.toLowerCase()}${n}`;
    ids.add(id);
    rename.set(String(l.id), id);
  }
  const order = layersOf(scene).map((l) => String(l.id));
  for (const l of hook) {
    const copy: LayerLike = { ...structuredClone(l), id: rename.get(String(l.id))!, variant };
    // Parented or matted to another hook layer: to its copy.
    if (typeof copy.parent === "string" && rename.has(copy.parent)) copy.parent = rename.get(copy.parent);
    const matte = copy.matte as { layer?: unknown } | undefined;
    if (matte && typeof matte.layer === "string" && rename.has(matte.layer)) copy.matte = { ...matte, layer: rename.get(matte.layer) };
    delete copy.solo;
    ops.push({ op: OpName.AddLayer, layer: copy });
    const index = order.indexOf(String(l.id)) + 1;
    order.splice(index, 0, copy.id as string);
    ops.push({ op: OpName.Reorder, id: copy.id, index });
  }
  ops.push({ op: OpName.SetVariant, variant });
  return { variant, ops };
}
