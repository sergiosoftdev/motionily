import { useEffect, useState, type RefObject } from "react";
import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import type { SceneView } from "../../sceneView";
import { FX_DROP_ATTR } from "../EffectControls";
import { applyPreset, PresetKind, type Preset } from "./actions";
import { EFFECTS, EffectCategory, LAYER_STYLES } from "./effects";
import type { SceneJson } from "./scene";
import { selectedIds, selectLayer } from "./scene";

/** Drag payload of a preset (JSON `Preset`). */
const PRESET_MIME = "application/x-motionily-preset";

type Entry = { preset: Preset; name: string; hint: string };
type Folder = { title: string; entries: Entry[] };

function folders(scene: SceneJson | null): Folder[] {
  const lib = scene?.library;
  const animations = Object.keys(lib?.animations ?? {}).map((k) => ({ preset: { kind: PresetKind.Animation, key: k }, name: k.replace(/^animation\//, ""), hint: `Plays ${k} from the playhead (add_anim)` }));
  const prefabs = Object.keys(lib?.prefabs ?? {}).map((k) => ({ preset: { kind: PresetKind.Prefab, key: k }, name: k, hint: "3D prefab: an object layer shows it" }));
  return [
    { title: "Animation Presets", entries: animations },
    { title: "3D Prefabs", entries: prefabs },
    ...Object.values(EffectCategory).map((c) => ({
      title: c,
      entries: EFFECTS.filter((d) => d.category === c).map((d) => ({ preset: { kind: PresetKind.Effect, key: d.kind }, name: d.name, hint: d.hint })),
    })),
    { title: "Layer Styles", entries: LAYER_STYLES.map((s) => ({ preset: { kind: PresetKind.Style, key: s.kind }, name: s.name, hint: s.hint })) },
  ];
}

const presetIcon = (k: PresetKind) => (k === PresetKind.Effect ? "fx" : k === PresetKind.Style ? "◩" : k === PresetKind.Animation ? "◆" : "⬢");

/** Where a dragged preset is over: the composition (the layer under the pointer) or Effect Controls. */
function dropTarget(e: DragEvent, canvas: HTMLCanvasElement | null): { ok: boolean; layer?: string } {
  const el = e.target as HTMLElement | null;
  if (el?.closest(`[${FX_DROP_ATTR}]`)) return { ok: true };
  if (!canvas || !(el === canvas || canvas.contains(el))) return { ok: false };
  const r = canvas.getBoundingClientRect();
  const [W, H] = useEditor.getState().sceneSize;
  const hits = engineHost.pickStack(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
  const front = hits.find((h) => !h.cover) ?? hits[0];
  return { ok: true, layer: front?.id };
}

/** Drop a preset on the composition (onto the layer there) or on Effect Controls (the selection). */
function usePresetDrop(canvas: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(PRESET_MIME) || !dropTarget(e, canvas.current).ok) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(PRESET_MIME);
      if (!raw) return;
      const target = dropTarget(e, canvas.current);
      if (!target.ok) return;
      e.preventDefault();
      if (target.layer) selectLayer(target.layer);
      applyPreset(JSON.parse(raw) as Preset, target.layer ? [target.layer] : selectedIds());
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [canvas]);
}

/**
 * AE's Effects & Presets: every engine effect by category, layer styles, the scene library's
 * animations and the user's 3D prefabs. Double-click applies to the selected layers; drag onto
 * the composition (the layer there) or onto Effect Controls.
 */
export function EffectsPresets({ scene, canvas }: { scene: SceneView | null; canvas: RefObject<HTMLCanvasElement | null> }) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  usePresetDrop(canvas);
  const needle = q.trim().toLowerCase();
  const list = folders(scene as SceneJson | null)
    .map((f) => ({ ...f, entries: needle ? f.entries.filter((e) => `${e.name} ${f.title}`.toLowerCase().includes(needle)) : f.entries }))
    .filter((f) => f.entries.length || (!needle && f.title === "Animation Presets"));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Search effects and presets"
          className="w-full rounded-sm bg-[#1b1b1b] px-2 py-1 text-[12px] text-[#e6e6e6] placeholder:text-[#666] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {list.map((f) => {
          const open = needle !== "" || !closed.has(f.title);
          return (
            <div key={f.title}>
              <button
                type="button"
                onClick={() => setClosed((s) => (s.has(f.title) ? new Set([...s].filter((x) => x !== f.title)) : new Set([...s, f.title])))}
                className="flex h-6 w-full items-center gap-1.5 px-2 text-left text-[#e6e6e6] hover:bg-[#2a2a2a]"
              >
                <span className="w-2.5 text-[9px] text-[#8a8a8a]">{open ? "▼" : "▶"}</span>
                <span className="text-[#8a8a8a]">▤</span>
                {f.title}
              </button>
              {open && !f.entries.length && <p className="py-1 pl-9 text-[11px] text-[#666]">None in this video yet</p>}
              {open &&
                f.entries.map((e) => (
                  <div
                    key={`${e.preset.kind}:${e.preset.key}`}
                    draggable
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData(PRESET_MIME, JSON.stringify(e.preset));
                      ev.dataTransfer.effectAllowed = "copy";
                    }}
                    onDoubleClick={() => applyPreset(e.preset)}
                    title={`${e.hint} · double-click or drag onto a layer`}
                    className="flex h-6 cursor-default items-center gap-2 pr-2 pl-7 select-none hover:bg-[#2a2a2a]"
                  >
                    <span className="w-4 text-center text-[9px] text-[#8a8a8a] italic">{presetIcon(e.preset.kind)}</span>
                    <span className="truncate">{e.name}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
