import { useState } from "react";
import { OpName, type Op } from "@motionily/protocol";
import { commit, preview } from "../../editing/direct";
import { groupLayerIds } from "../../editing/groups";
import { engineHost } from "../../engine/host";
import { useEditor, usePlayheadTime } from "../../store";
import { landingTime, type SceneView } from "../sceneView";
import { rowsFor, TRANSFORM_PROPS } from "./keys";
import { setMatte } from "./panels/actions";
import { BLEND_MODES, MATTE_MODES, MatteMode, NORMAL_BLEND, type Matte } from "./panels/effects";
import { EffectStack } from "./panels/EffectStack";
import { Field, Line, selectClass, Twirl, type Change } from "./panels/fields";
import { PropRow } from "./PropRow";
import { ScrubNumber } from "./ScrubNumber";
import { labelColor, typeIcon } from "./theme";

/** Fields shown by their own controls above the generic list. */
const OWN_FIELDS = new Set([
  "id",
  "type",
  "start",
  "end",
  "group",
  "visible",
  "blend",
  "matte",
  "parent",
  "adjustment",
  "fixed",
  "effects",
  "solo",
  "locked",
  "shy",
  "text",
  "fill",
  ...TRANSFORM_PROPS,
]);

/** Marks the panel as a drop target for Effects & Presets. */
export const FX_DROP_ATTR = "data-fx-drop";

/**
 * AE's Effect Controls for the selected layer: Layer (timing, blend, matte, parent), Transform with
 * stopwatches and expressions, the effect stack, then every other field of the layer, each one
 * editable (numbers scrub, colors pick, text types).
 */
export function EffectControls({ scene }: { scene: SceneView | null }) {
  const selected = useEditor((s) => s.selectedLayerId);
  const group = useEditor((s) => s.selectedGroup);
  const time = usePlayheadTime();
  const [error, setError] = useState<string | null>(null);
  const fps = scene?.fps ?? 30;
  const duration = scene?.duration ?? 0;

  if (group) return <GroupControls group={group} scene={scene} />;
  const layer = selected ? scene?.layers.find((l) => l.id === selected) : undefined;
  if (!selected || !layer)
    return (
      <p className="p-4 text-[#8a8a8a]" {...{ [FX_DROP_ATTR]: "" }}>
        Select a layer in the composition or the timeline.
      </p>
    );

  const apply = (ops: Op[], done: boolean, what: string) => {
    if (!done) return preview(ops);
    try {
      engineHost.applyOps(ops);
      setError(null);
      commit(what);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const patch =
    (field: string): Change =>
    (value, done) =>
      apply([{ op: OpName.Patch, id: selected, fields: { [field]: value } }], done, `Sets ${field} of ${selected}`);
  const start = layer.start ?? 0;
  const end = layer.end ?? duration;
  const lt = time - start;
  const timing = (s: number, e: number, done: boolean) => apply([{ op: OpName.SetTiming, id: selected, start: s, end: e }], done, `Timing of ${selected}: ${s.toFixed(2)}–${e.toFixed(2)} s`);
  const rest = Object.entries(layer).filter(([k]) => !OWN_FIELDS.has(k));
  const others = (scene?.layers ?? []).filter((l) => l.id !== selected);
  const matte = layer.matte as Matte | undefined;

  return (
    <div className="flex flex-col pb-4" {...{ [FX_DROP_ATTR]: "" }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="size-2.5 rounded-[2px]" style={{ background: labelColor(layer) }} />
        <span className="text-[#8a8a8a]">{typeIcon(layer)}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-[#e6e6e6]">{selected}</span>
        <span className="text-[#8a8a8a]">{layer.adjustment ? "adjustment" : layer.camera ? "camera" : layer.type}</span>
      </div>
      {error && <p className="mx-3 mb-2 rounded-sm bg-[#e5484d]/15 px-2 py-1 text-[11px] text-[#ff8a8e]">{error}</p>}

      <Twirl title="Layer">
        <Line label="In">
          <ScrubNumber value={start} step={0.01} decimals={2} unit=" s" min={0} max={end - 0.05} onChange={(v, done) => timing(v, end, done)} />
        </Line>
        <Line label="Out">
          <ScrubNumber value={end} step={0.01} decimals={2} unit=" s" min={start + 0.05} max={duration} onChange={(v, done) => timing(start, v, done)} />
        </Line>
        <Line label="Blend Mode">
          <select value={(layer.blend as string | undefined) ?? NORMAL_BLEND} onChange={(e) => patch("blend")(e.target.value === NORMAL_BLEND ? null : e.target.value, true)} className={selectClass}>
            {BLEND_MODES.map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </select>
        </Line>
        <Line label="Track Matte">
          <select value={matte?.layer ?? ""} onChange={(e) => setMatte(selected, e.target.value || null, matte?.mode ?? MatteMode.Alpha)} className={`${selectClass} max-w-28`}>
            <option value="">None</option>
            {others.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id}
              </option>
            ))}
          </select>
          {matte && (
            <select value={matte.mode ?? MatteMode.Alpha} onChange={(e) => setMatte(selected, matte.layer, e.target.value as MatteMode)} className={selectClass}>
              {MATTE_MODES.map(([m, label]) => (
                <option key={m} value={m}>
                  {label.replace(" Matte", "")}
                </option>
              ))}
            </select>
          )}
        </Line>
        <Line label="Parent">
          <select value={layer.parent ?? ""} onChange={(e) => patch("parent")(e.target.value || null, true)} className={`${selectClass} max-w-36`}>
            <option value="">None</option>
            {others.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id}
              </option>
            ))}
          </select>
        </Line>
        <Line label="Visible">
          <input type="checkbox" checked={layer.visible !== false} onChange={(e) => patch("visible")(e.target.checked ? null : false, true)} className="accent-[#2d8ceb]" />
        </Line>
        <Line label="Adjustment Layer">
          <input type="checkbox" checked={layer.adjustment === true} onChange={(e) => patch("adjustment")(e.target.checked ? true : null, true)} className="accent-[#2d8ceb]" />
        </Line>
        <Line label="Fixed (ignores the camera)">
          <input type="checkbox" checked={layer.fixed === true} onChange={(e) => patch("fixed")(e.target.checked ? true : null, true)} className="accent-[#2d8ceb]" />
        </Line>
      </Twirl>

      <Twirl title="Transform">
        {rowsFor(layer).map((def) => (
          <PropRow key={def.label} id={selected} layer={layer} def={def} fps={fps} indent={4} exprInline />
        ))}
      </Twirl>

      <Twirl title={`Effects${layer.effects?.length ? ` (${layer.effects.length})` : ""}`}>
        <EffectStack id={selected} layer={layer} lt={lt} fps={fps} />
      </Twirl>

      {typeof layer.text === "string" && (
        <Twirl title="Text">
          <textarea
            key={`${selected}:${layer.text}`}
            defaultValue={layer.text}
            rows={2}
            onBlur={(e) => e.target.value !== layer.text && apply([{ op: OpName.SetText, id: selected, text: e.target.value }], true, `Text of ${selected}: ${e.target.value}`)}
            className="mx-3 my-1 resize-y rounded-sm bg-[#1b1b1b] px-2 py-1 text-[#e6e6e6] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
          />
        </Twirl>
      )}

      {layer.fill !== undefined && (
        <Twirl title="Fill">
          <Field name="Color" value={layer.fill} onChange={patch("fill")} />
        </Twirl>
      )}

      {rest.length > 0 && (
        <Twirl title="Contents">
          {rest.map(([k, v]) => (
            <Field key={k} name={k} value={v} onChange={patch(k)} />
          ))}
        </Twirl>
      )}
    </div>
  );
}

/** A selected group: its layers (click one to select it) and its time span. */
function GroupControls({ group, scene }: { group: string; scene: SceneView | null }) {
  const ids = groupLayerIds(group);
  const layers = (scene?.layers ?? []).filter((l) => ids.includes(l.id));
  return (
    <div className="flex flex-col pb-4" {...{ [FX_DROP_ATTR]: "" }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-medium text-[#e6e6e6]">▣ {group}</span>
        <span className="text-[#8a8a8a]">group · {layers.length} layers</span>
      </div>
      {layers.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => {
            useEditor.setState({ selectedLayerId: l.id, selectedGroup: null });
            const t = useEditor.getState().time;
            const [s, e] = [l.start ?? 0, l.end ?? scene!.duration];
            if (t < s || t >= e) engineHost.seek(landingTime(s, e));
          }}
          className="flex items-center gap-2 px-3 py-1 text-left hover:bg-[#2a2a2a]"
        >
          <span className="size-2.5 rounded-[2px]" style={{ background: labelColor(l) }} />
          <span className="w-3 text-[#8a8a8a]">{typeIcon(l)}</span>
          <span className="truncate">{l.id}</span>
        </button>
      ))}
    </div>
  );
}
