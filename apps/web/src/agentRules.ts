import { OpName, type Op } from "@motionily/protocol";

/** Key prefixes of the old built-in bricks (pre-made animations and transitions). */
const BUILTIN_PREFIXES = ["animation/", "transition/"];
/** Ops that apply looks we designed instead of the agent. */
const PRESET_OPS: string[] = [OpName.SetStyle, OpName.SetCaptionStyle, OpName.SetScenario, OpName.SetStagePreset, OpName.SetRenderStyle, OpName.SetSize];
const CHARACTER_LAYER = "character";

const HINT =
  "Motionily has no presets: design it yourself (keyframes on the layer, or define_anim with your own keys and use that key; cuts via layer start/end; people as stickman rigs on the 3D stage).";

type Json = Record<string, unknown>;

function builtinRef(v: unknown): boolean {
  return typeof v === "string" && BUILTIN_PREFIXES.some((p) => v.startsWith(p));
}

function checkLayer(layer: Json | undefined): string | null {
  if (!layer) return null;
  if (layer.type === CHARACTER_LAYER) return "2D preset characters are disabled";
  const anims = (layer.anims as Json[] | undefined) ?? [];
  if (anims.some((a) => builtinRef(a.use))) return `layer '${String(layer.id)}' uses a built-in animation`;
  return null;
}

/** Why an agent's ops break the no-presets rule, or null when they are fine. */
export function presetViolation(ops: Op[]): string | null {
  for (const op of ops) {
    if (PRESET_OPS.includes(op.op)) return `'${op.op}' is disabled. ${HINT}`;
    if (op.op === OpName.PutProp && (op.prop as Json | undefined)?.model) return `stock 3D models are disabled. ${HINT}`;
    const why = checkLayer(op.layer as Json | undefined);
    if (why) return `${why}. ${HINT}`;
    if (builtinRef((op.anim as Json | undefined)?.use) || builtinRef((op.transition as Json | undefined)?.use)) return `built-in animations/transitions are disabled. ${HINT}`;
  }
  return null;
}

/** Same rule for a whole scene sent with load_scene. */
export function scenePresetViolation(scene: Json): string | null {
  for (const l of (scene.layers as Json[] | undefined) ?? []) {
    const why = checkLayer(l);
    if (why) return `${why}. ${HINT}`;
  }
  if (((scene.transitions as Json[] | undefined) ?? []).some((t) => builtinRef(t.use))) return `built-in transitions are disabled. ${HINT}`;
  const stage = scene.stage as { props?: Json[] } | undefined;
  if (stage?.props?.some((p) => p.model)) return `stock 3D models are disabled. ${HINT}`;
  if (scene.scenario) return `preset scenarios are disabled. ${HINT}`;
  return null;
}
