import { useState, type ReactNode } from "react";
import { OpName, type Op } from "@motionily/protocol";
import { commit, preview } from "../../editing/direct";
import { groupLayerIds } from "../../editing/groups";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import { landingTime, type SceneView } from "../sceneView";
import { rowsFor, TRANSFORM_PROPS } from "./keys";
import { PropRow } from "./PropRow";
import { ScrubNumber } from "./ScrubNumber";
import { labelColor, typeIcon } from "./theme";

/** Palette slots: a color written by name follows the palette. */
const SLOTS = ["background", "surface", "primary", "accent", "text"];
const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;
const BLEND_MODES = ["normal", "add", "screen", "multiply"];
/** Fields shown by their own controls above the generic list. */
const OWN_FIELDS = new Set(["id", "type", "start", "end", "group", "visible", "blend", "text", "fill", ...TRANSFORM_PROPS]);
/** Longer strings get a text area (formulas, shader code, paths). */
const LONG_TEXT = 40;

type Change = (value: unknown, done: boolean) => void;

/**
 * AE's Effect Controls for the selected layer: Layer (timing, blend), Transform with stopwatches,
 * then every other field of the layer, each one editable (numbers scrub, colors pick, text types).
 */
export function EffectControls({ scene }: { scene: SceneView | null }) {
  const selected = useEditor((s) => s.selectedLayerId);
  const group = useEditor((s) => s.selectedGroup);
  const [error, setError] = useState<string | null>(null);
  const fps = scene?.fps ?? 30;
  const duration = scene?.duration ?? 0;

  if (group) return <GroupControls group={group} scene={scene} />;
  const layer = selected ? scene?.layers.find((l) => l.id === selected) : undefined;
  if (!selected || !layer) return <p className="p-4 text-[#8a8a8a]">Select a layer in the composition or the timeline.</p>;

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
  const patch = (field: string): Change => (value, done) => apply([{ op: OpName.Patch, id: selected, fields: { [field]: value } }], done, `Sets ${field} of ${selected}`);
  const start = layer.start ?? 0;
  const end = layer.end ?? duration;
  const timing = (s: number, e: number, done: boolean) => apply([{ op: OpName.SetTiming, id: selected, start: s, end: e }], done, `Timing of ${selected}: ${s.toFixed(2)}–${e.toFixed(2)} s`);
  const rest = Object.entries(layer).filter(([k]) => !OWN_FIELDS.has(k));

  return (
    <div className="flex flex-col pb-4">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="size-2.5 rounded-[2px]" style={{ background: labelColor(layer) }} />
        <span className="text-[#8a8a8a]">{typeIcon(layer)}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-[#e6e6e6]">{selected}</span>
        <span className="text-[#8a8a8a]">{layer.type}</span>
      </div>
      {error && <p className="mx-3 mb-2 rounded-sm bg-[#e5484d]/15 px-2 py-1 text-[11px] text-[#ff8a8e]">{error}</p>}

      <Twirl title="Layer">
        <Line label="In">
          <ScrubNumber value={start} step={0.01} decimals={2} unit=" s" min={0} max={end - 0.05} onChange={(v, done) => timing(v, end, done)} />
        </Line>
        <Line label="Out">
          <ScrubNumber value={end} step={0.01} decimals={2} unit=" s" min={start + 0.05} max={duration} onChange={(v, done) => timing(start, v, done)} />
        </Line>
        <Line label="Blend mode">
          <select
            value={(layer.blend as string | undefined) ?? "normal"}
            onChange={(e) => patch("blend")(e.target.value === "normal" ? null : e.target.value, true)}
            className="rounded-sm bg-[#1b1b1b] px-1 py-0.5 text-[#c9c9c9] focus:outline-none"
          >
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>
                {m[0]!.toUpperCase() + m.slice(1)}
              </option>
            ))}
          </select>
        </Line>
        <Line label="Visible">
          <input type="checkbox" checked={layer.visible !== false} onChange={(e) => patch("visible")(e.target.checked ? null : false, true)} className="accent-[#2d8ceb]" />
        </Line>
      </Twirl>

      <Twirl title="Transform">
        {rowsFor(layer).map((def) => (
          <PropRow key={def.label} id={selected} layer={layer} def={def} fps={fps} indent={4} />
        ))}
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
    <div className="flex flex-col pb-4">
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

function Twirl({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 px-2 py-1 text-left font-medium text-[#e6e6e6] hover:bg-[#2a2a2a]">
        <span className="w-2.5 text-[9px] text-[#8a8a8a]">{open ? "▼" : "▶"}</span>
        {title}
      </button>
      {open && <div className="flex flex-col pb-1">{children}</div>}
    </div>
  );
}

function Line({ label, children, depth = 0 }: { label: string; children: ReactNode; depth?: number }) {
  return (
    <div className="flex min-h-6 items-center gap-2 pr-3" style={{ paddingLeft: 22 + depth * 12 }}>
      <span className="min-w-0 flex-1 truncate text-[#c9c9c9]">{label}</span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </div>
  );
}

const isKeyList = (v: unknown): v is { t: number }[] => Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && "t" in v[0];
const isColor = (v: unknown): v is string => typeof v === "string" && (HEX.test(v) || SLOTS.includes(v));

/** Any value of a layer, edited by its shape: number, color, text, flag, list or object. */
function Field({ name, value, onChange, depth = 0 }: { name: string; value: unknown; onChange: Change; depth?: number }) {
  const [open, setOpen] = useState(false);
  if (typeof value === "number")
    return (
      <Line label={name} depth={depth}>
        <ScrubNumber value={value} step={Math.abs(value) >= 10 ? 1 : 0.01} decimals={Number.isInteger(value) && Math.abs(value) >= 10 ? 0 : 2} onChange={onChange} />
      </Line>
    );
  if (typeof value === "boolean")
    return (
      <Line label={name} depth={depth}>
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked, true)} className="accent-[#2d8ceb]" />
      </Line>
    );
  if (isColor(value)) return <ColorField name={name} value={value} onChange={onChange} depth={depth} />;
  if (typeof value === "string")
    return value.length > LONG_TEXT ? (
      <div className="flex flex-col gap-1 py-1 pr-3" style={{ paddingLeft: 22 + depth * 12 }}>
        <span>{name}</span>
        <textarea
          key={value}
          defaultValue={value}
          rows={3}
          onBlur={(e) => e.target.value !== value && onChange(e.target.value, true)}
          className="resize-y rounded-sm bg-[#1b1b1b] px-1.5 py-1 font-mono text-[11px] text-[#e6e6e6] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
        />
      </div>
    ) : (
      <Line label={name} depth={depth}>
        <input
          key={value}
          defaultValue={value}
          onBlur={(e) => e.target.value !== value && onChange(e.target.value, true)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-32 rounded-sm bg-[#1b1b1b] px-1.5 py-0.5 text-right text-[#4aa3f0] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
        />
      </Line>
    );
  if (isKeyList(value))
    return (
      <Line label={name} depth={depth}>
        <span className="text-[#8a8a8a]" title="Animated: edit it with keyframes or ask the agent">
          ◆ {value.length} keyframes
        </span>
      </Line>
    );
  if (value === null || value === undefined)
    return (
      <Line label={name} depth={depth}>
        <span className="text-[#8a8a8a]">—</span>
      </Line>
    );
  // Lists and objects twirl open; a change inside sends the whole value back up.
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [typeof v === "object" && v && "fx" in v ? `${i + 1}. ${String((v as { fx: unknown }).fx)}` : String(i + 1), v])
    : Object.entries(value as Record<string, unknown>);
  const childChange = (i: number, key: string): Change => (v, done) => {
    if (Array.isArray(value)) onChange(value.map((x, j) => (j === i ? v : x)), done);
    else onChange({ ...(value as Record<string, unknown>), [key]: v }, done);
  };
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex h-6 items-center gap-1.5 pr-3 text-left hover:bg-[#2a2a2a]" style={{ paddingLeft: 10 + depth * 12 }}>
        <span className="w-2.5 text-[9px] text-[#8a8a8a]">{open ? "▼" : "▶"}</span>
        <span className="flex-1 truncate">{name}</span>
        <span className="text-[#8a8a8a]">{Array.isArray(value) ? `${value.length}` : ""}</span>
      </button>
      {open && entries.map(([k, v], i) => <Field key={k} name={k} value={v} depth={depth + 1} onChange={childChange(i, k)} />)}
    </div>
  );
}

/** A color: a palette slot (follows the palette) or a hex value; alpha is kept when picking. */
function ColorField({ name, value, onChange, depth }: { name: string; value: string; onChange: Change; depth: number }) {
  const slot = SLOTS.includes(value);
  const hex = slot ? "#808080" : value.slice(0, 7);
  return (
    <Line label={name} depth={depth}>
      <select
        value={slot ? value : "custom"}
        onChange={(e) => e.target.value !== "custom" && onChange(e.target.value, true)}
        className="rounded-sm bg-[#1b1b1b] px-1 py-0.5 text-[#c9c9c9] focus:outline-none"
      >
        {SLOTS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value="custom">custom</option>
      </select>
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value + (slot ? "" : value.slice(7)), false)}
        onBlur={(e) => e.target.value !== hex && onChange(e.target.value + (slot ? "" : value.slice(7)), true)}
        className="h-5 w-7 cursor-pointer rounded-sm bg-transparent"
        title={slot ? "Pick a color instead of the palette's" : value}
      />
    </Line>
  );
}
