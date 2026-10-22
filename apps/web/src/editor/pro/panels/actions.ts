import { OpName, type Op } from "@motionily/protocol";
import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import { effectDef, FILM_MM, LAYER_STYLES, MatteMode, newEffect, NORMAL_BLEND, type EffectDef, type Fx, type LayerStyleDef } from "./effects";
import { notify } from "./notice";
import { INSTANCE_TYPE, localTime, readScene, runOps, sceneLayers, selectedIds, selectLayer, slug, uniqueId } from "./scene";

/**
 * Every Layer/Effect/Animation menu action, written as the ops the agent would send (add_layer,
 * patch, reorder, precompose, add_anim…), so Claude can do the same through MCP.
 */

/** Ops the editor sends that the protocol's `OpName` does not list (crates/scene/src/ops.rs). */
const MoreOp = { AddAnim: "add_anim" } as const;

/** What Layer > New makes. */
export const NewLayer = { Text: "text", Solid: "solid", Shape: "shape", Null: "null", Adjustment: "adjustment", Camera: "camera" } as const;
export type NewLayer = (typeof NewLayer)[keyof typeof NewLayer];

/** Id stem per kind: `text_1`, `solid_2`… */
const STEM: Record<NewLayer, string> = {
  [NewLayer.Text]: "text",
  [NewLayer.Solid]: "solid",
  [NewLayer.Shape]: "shape",
  [NewLayer.Null]: "null",
  [NewLayer.Adjustment]: "adjustment",
  [NewLayer.Camera]: "camera",
};

const LayerKind = { Shape: "shape", Text: "text", Object: "object" } as const;
const ShapeKind = { Rect: "rect" } as const;
const Slot = { Text: "text", Primary: "primary" } as const;
const TextRole = { Heading: "heading" } as const;
const TextAlign = { Center: "center" } as const;

/** Share of the frame's short side a new text's size / shape's side takes. */
const TEXT_SIZE = 0.08;
const SHAPE_SIDE = 0.4;
/** A null is invisible; this box only gives it something to grab. */
const NULL_SIZE = 100;

export type NewLayerOptions = { name?: string; color?: string; w?: number; h?: number; focal?: number };

export const focalPx = (mm: number, compWidth: number) => Math.round((mm * compWidth) / FILM_MM);

function layerJson(kind: NewLayer, id: string, o: NewLayerOptions): Record<string, unknown> {
  const [W, H] = useEditor.getState().sceneSize;
  const center = { x: Math.round(W / 2), y: Math.round(H / 2) };
  const rect = { id, type: LayerKind.Shape, shape: ShapeKind.Rect, ...center };
  switch (kind) {
    case NewLayer.Text: {
      const size = Math.round(Math.min(W, H) * TEXT_SIZE);
      return { id, type: LayerKind.Text, text: "Text", size, role: TextRole.Heading, align: TextAlign.Center, ...center, w: Math.round(W * 0.8), h: Math.round(size * 1.5), fill: Slot.Text };
    }
    case NewLayer.Solid:
      return { ...rect, w: o.w ?? W, h: o.h ?? H, fill: o.color ?? Slot.Primary };
    case NewLayer.Shape: {
      const side = Math.round(Math.min(W, H) * SHAPE_SIDE);
      return { ...rect, w: side, h: side, radius: Math.round(side * 0.08), fill: Slot.Primary };
    }
    case NewLayer.Null:
      return { ...rect, w: NULL_SIZE, h: NULL_SIZE, visible: false };
    case NewLayer.Adjustment:
      return { ...rect, w: W, h: H, adjustment: true, fixed: true };
    case NewLayer.Camera:
      return { ...rect, w: 1, h: 1, visible: false, camera: { focal: o.focal ?? focalPx(35, W) } };
  }
}

/** Above the selected layer, like AE (the end of the list is the front). */
function placeAboveSelection(id: string): Op[] {
  const sel = useEditor.getState().selectedLayerId;
  const layers = sceneLayers();
  const i = sel ? layers.findIndex((l) => l.id === sel) : -1;
  return i >= 0 && i < layers.length - 1 ? [{ op: OpName.Reorder, id, index: i + 1 }] : [];
}

/** Layer > New: centered in the comp, from the comp start, then selected. */
export function addNewLayer(kind: NewLayer, o: NewLayerOptions = {}): string | null {
  if (!engineHost.ready) return null;
  const id = o.name ? uniqueId(o.name, undefined, false) : uniqueId(STEM[kind]);
  const ops: Op[] = [{ op: OpName.AddLayer, layer: layerJson(kind, id, o) }, ...placeAboveSelection(id)];
  if (!runOps(ops, `Adds ${kind} layer ${id}`)) return null;
  selectLayer(id);
  return id;
}

export function hasCamera(): boolean {
  return sceneLayers().some((l) => !!l.camera);
}

/** Component names already in the library. */
export function componentNames(): string[] {
  return Object.keys(readScene()?.library?.components ?? {});
}

/** Layer > Pre-compose: the layers move into a component; one instance takes their place. */
export function precompose(ids: string[], name: string): string | null {
  const taken = componentNames();
  let component = slug(name);
  for (let n = 2; taken.includes(component); n++) component = `${slug(name)}_${n}`;
  const id = uniqueId(component, undefined, false);
  if (!runOps([{ op: OpName.Precompose, ids, component, id }], `Pre-composes ${ids.join(", ")} into ${component}`)) return null;
  selectLayer(id);
  return id;
}

/** AE's layer switches, stored as layer flags. */
export const LayerSwitch = { Solo: "solo", Locked: "locked", Shy: "shy" } as const;
export type LayerSwitch = (typeof LayerSwitch)[keyof typeof LayerSwitch];

export function toggleSwitch(ids: string[], sw: LayerSwitch) {
  const on = !ids.every((id) => engineHost.layer(id)?.[sw] === true);
  runOps([{ op: OpName.Patch, ids, fields: { [sw]: on ? true : null } }], `${on ? "Turns on" : "Turns off"} ${sw} on ${ids.join(", ")}`);
}

export function setBlend(ids: string[], mode: string) {
  runOps([{ op: OpName.Patch, ids, fields: { blend: mode === NORMAL_BLEND ? null : mode } }], `Blend mode ${mode} on ${ids.join(", ")}`);
}

/** The layer drawn right in front of `id` (AE's "layer above" in the timeline). */
export function layerAbove(id: string): string | undefined {
  const layers = sceneLayers();
  const i = layers.findIndex((l) => l.id === id);
  return i >= 0 ? layers[i + 1]?.id : undefined;
}

/** Track matte from `source` (hidden, as AE does), or none. */
export function setMatte(id: string, source: string | null, mode: MatteMode = MatteMode.Alpha) {
  if (!source) return runOps([{ op: OpName.Patch, id, fields: { matte: null } }], `Removes the track matte of ${id}`);
  runOps(
    [
      { op: OpName.Patch, id, fields: { matte: { layer: source, mode } } },
      { op: OpName.Patch, id: source, fields: { visible: false } },
    ],
    `${id} uses ${source} as its ${mode.replace("_", " ")} matte`,
  );
}

/** Effect > NAME: appended to each selected layer's stack (Liquid Glass also makes it an adjustment layer). */
export function addEffect(ids: string[], def: EffectDef) {
  const ops: Op[] = ids.map((id) => {
    const effects = ((engineHost.layer(id)?.effects as Fx[] | undefined) ?? []).concat(newEffect(def));
    return { op: OpName.Patch, id, fields: def.adjustment ? { effects, adjustment: true } : { effects } };
  });
  runOps(ops, `Adds ${def.name} to ${ids.join(", ")}`);
}

export function removeAllEffects(ids: string[]) {
  runOps([{ op: OpName.Patch, ids, fields: { effects: null } }], `Removes every effect of ${ids.join(", ")}`);
}

/** Animatable layer numbers go through set_prop; the other styles are fields. */
const ANIMATED_STYLE_FIELDS = new Set(["soft", "backdrop"]);

export function addLayerStyle(ids: string[], style: LayerStyleDef) {
  const ops: Op[] = ANIMATED_STYLE_FIELDS.has(style.field)
    ? ids.map((id) => ({ op: OpName.SetProp, id, prop: style.field, value: style.value }))
    : [{ op: OpName.Patch, ids, fields: { [style.field]: style.value } }];
  runOps(ops, `Adds ${style.name} to ${ids.join(", ")}`);
}

/** A library animation (define_anim / the project's bricks) played from the playhead. */
export function addAnimation(ids: string[], key: string) {
  const layers = sceneLayers();
  const ops: Op[] = ids.map((id) => {
    const l = layers.find((x) => x.id === id);
    const at = Math.max(0, +(l ? localTime(l) : 0).toFixed(3));
    return { op: MoreOp.AddAnim, id, anim: { use: key, at } };
  });
  runOps(ops, `Plays ${key} on ${ids.join(", ")}`);
}

/** A 3D prefab: an object layer shows it (an object layer already selected takes it instead). */
export function addPrefab(ids: string[], name: string) {
  const node = { prefab: name };
  const objects = ids.filter((id) => engineHost.layer(id)?.type === LayerKind.Object);
  if (objects.length) return void runOps([{ op: OpName.Patch, ids: objects, fields: { node } }], `${objects.join(", ")} now show${objects.length > 1 ? "" : "s"} ${name}`);
  const [W, H] = useEditor.getState().sceneSize;
  const side = Math.round(Math.min(W, H) * SHAPE_SIDE);
  const id = uniqueId(name);
  const layer = { id, type: LayerKind.Object, node, x: Math.round(W / 2), y: Math.round(H / 2), w: side, h: side };
  if (runOps([{ op: OpName.AddLayer, layer }, ...placeAboveSelection(id)], `Adds ${name} as layer ${id}`)) selectLayer(id);
}

/** Something from Effects & Presets, as dragged or double-clicked. */
export const PresetKind = { Effect: "effect", Style: "style", Animation: "animation", Prefab: "prefab" } as const;
export type PresetKind = (typeof PresetKind)[keyof typeof PresetKind];
export type Preset = { kind: PresetKind; key: string };

export function applyPreset(p: Preset, ids = selectedIds()) {
  if (!ids.length && p.kind !== PresetKind.Prefab) return notify("Select a layer to apply it to.");
  switch (p.kind) {
    case PresetKind.Effect: {
      const def = effectDef(p.key);
      return def && addEffect(ids, def);
    }
    case PresetKind.Style: {
      const def = LAYER_STYLES.find((s) => s.kind === p.key);
      return def && addLayerStyle(ids, def);
    }
    case PresetKind.Animation:
      return addAnimation(ids, p.key);
    case PresetKind.Prefab:
      return addPrefab(ids, p.key);
  }
}

/** Instances of a component, in stack order. */
export function instancesOf(component: string): string[] {
  return sceneLayers()
    .filter((l) => l.type === INSTANCE_TYPE && l.comp === component)
    .map((l) => l.id);
}

/** Rename a component: define it under the new name, point its instances there, drop the old one. */
export function renameComponent(from: string, to: string): boolean {
  const def = readScene()?.library?.components?.[from];
  const name = slug(to);
  if (!def || name === from) return false;
  if (componentNames().includes(name)) {
    notify(`A component named ${name} already exists.`);
    return false;
  }
  const ids = instancesOf(from);
  return runOps(
    [
      { op: OpName.DefineComponent, name, component: def },
      ...(ids.length ? [{ op: OpName.Patch, ids, fields: { comp: name } }] : []),
      { op: OpName.RemoveComponent, name: from },
    ],
    `Renames component ${from} to ${name}`,
  );
}
