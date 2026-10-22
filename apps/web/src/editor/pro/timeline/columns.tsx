import { memo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { OpName } from "@motionily/protocol";
import { commit, preview } from "../../../editing/direct";
import { runOps } from "../layerActions";
import { ScrubNumber } from "../ScrubNumber";
import { BLEND_GROUPS, BlendMode, isLocked, LayerSwitch, MatteMode, type TimelineLayer, type TimelineScene } from "./contract";
import { descendants, parentOps } from "./parenting";

/**
 * AE's layer columns besides the name: the A/V switches (solo, lock), the shy switch, Mode,
 * TrkMat and Parent & Link. Every change is a `patch` (parenting also rewrites the transform so
 * nothing jumps), the same op the agent would send.
 */

/** Column widths, px. */
export const COL = { eye: 22, sw: 18, label: 18, num: 24, twirl: 14, mode: 84, matte: 112, parent: 112 } as const;

const iconBtn = "flex shrink-0 items-center justify-center hover:text-white disabled:opacity-30";

export function SwitchButton({ on, title, onClick, children, dim = false }: { on: boolean; title: string; onClick: () => void; children: ReactNode; dim?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`${iconBtn} ${on ? "text-[#e6e6e6]" : dim ? "text-[#3a3a3a]" : "text-[#555]"}`}
      style={{ width: COL.sw }}
    >
      {children}
    </button>
  );
}

export const SoloIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 16 16" className="size-3" aria-hidden>
    <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth={1.3} />
    {on && <circle cx="8" cy="8" r="3" fill="currentColor" />}
  </svg>
);
export const LockIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1" fill={on ? "currentColor" : "none"} />
    <path d={on ? "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" : "M5.5 7V5a2.5 2.5 0 0 1 5 0"} />
  </svg>
);
/** AE's shy guy: a face peeking over a line. */
export const ShyIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden>
    <path d="M2 10h12" />
    <path d={on ? "M4.5 10a3.5 3.5 0 0 1 7 0" : "M4.5 10a3.5 3.5 0 0 1 7 0M6.5 8.3v.1M9.5 8.3v.1"} />
  </svg>
);

/** Patch one switch of a layer (`null` drops the field back to its default). */
export function toggleSwitch(l: TimelineLayer, sw: LayerSwitch) {
  const on = l[sw] === true;
  runOps([{ op: OpName.Patch, id: l.id, fields: { [sw]: on ? null : true } }], `${on ? "Turns off" : "Turns on"} ${sw} on ${l.id}`);
}

const selectCls = "min-w-0 rounded-sm bg-transparent px-0.5 text-[#c9c9c9] hover:bg-[#1b1b1b] focus:outline-none disabled:opacity-40";

/** Mode: every blend mode, grouped like AE's menu. */
export const ModeSelect = memo(function ModeSelect({ layer }: { layer: TimelineLayer }) {
  return (
    <select
      value={layer.blend ?? BlendMode.Normal}
      disabled={isLocked(layer)}
      onChange={(e) =>
        runOps([{ op: OpName.Patch, id: layer.id, fields: { blend: e.target.value === BlendMode.Normal ? null : e.target.value } }], `Blend mode of ${layer.id}: ${e.target.value}`)
      }
      className={`${selectCls} shrink-0`}
      style={{ width: COL.mode }}
      aria-label="Mode"
    >
      {BLEND_GROUPS.map(([group, modes]) => (
        <optgroup key={group} label={group} className="bg-[#232323]">
          {modes.map(([m, label]) => (
            <option key={m} value={m} className="bg-[#232323]">
              {label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
});

const isLuma = (m: MatteMode) => m === MatteMode.Luma || m === MatteMode.LumaInverted;
const isInverted = (m: MatteMode) => m === MatteMode.AlphaInverted || m === MatteMode.LumaInverted;
const matteMode = (luma: boolean, inverted: boolean): MatteMode =>
  luma ? (inverted ? MatteMode.LumaInverted : MatteMode.Luma) : inverted ? MatteMode.AlphaInverted : MatteMode.Alpha;

/** `3. title` like AE's layer menus. */
const named = (numbers: Map<string, number>, id: string) => `${numbers.get(id) ?? "?"}. ${id}`;

/**
 * TrkMat: which layer masks this one (the layer above comes first, as AE defaults to it), plus
 * Alpha/Luma and Invert toggles. Picking a matte turns the matte layer's own drawing off, like AE.
 */
export const MatteCell = memo(function MatteCell({ scene, layer, numbers }: { scene: TimelineScene; layer: TimelineLayer; numbers: Map<string, number> }) {
  const idx = scene.layers.findIndex((l) => l.id === layer.id);
  const above = scene.layers[idx + 1];
  const others = [...scene.layers].reverse().filter((l) => l.id !== layer.id && l.id !== above?.id);
  const matte = layer.matte ?? null;
  const mode = (matte?.mode ?? MatteMode.Alpha) as MatteMode;
  const locked = isLocked(layer);
  const set = (source: string | null, m: MatteMode, what: string) =>
    runOps(
      [
        { op: OpName.Patch, id: layer.id, fields: { matte: source ? { layer: source, mode: m } : null } },
        ...(source && source !== matte?.layer ? [{ op: OpName.Patch, id: source, fields: { visible: false } }] : []),
      ],
      what,
    );
  return (
    <span className="flex shrink-0 items-center gap-0.5" style={{ width: COL.matte }}>
      <select
        value={matte?.layer ?? ""}
        disabled={locked}
        onChange={(e) => set(e.target.value || null, mode, e.target.value ? `${layer.id} uses ${e.target.value} as its track matte` : `Removes the track matte of ${layer.id}`)}
        className={`${selectCls} flex-1`}
        aria-label="Track matte"
      >
        <option value="" className="bg-[#232323]">
          No Matte
        </option>
        {above && (
          <option value={above.id} className="bg-[#232323]">
            {named(numbers, above.id)} ↑
          </option>
        )}
        {others.map((l) => (
          <option key={l.id} value={l.id} className="bg-[#232323]">
            {named(numbers, l.id)}
          </option>
        ))}
      </select>
      {matte && (
        <>
          <button
            type="button"
            disabled={locked}
            onClick={() => set(matte.layer, matteMode(!isLuma(mode), isInverted(mode)), `Track matte of ${layer.id}: ${isLuma(mode) ? "alpha" : "luma"}`)}
            title={isLuma(mode) ? "Luma matte (click for alpha)" : "Alpha matte (click for luma)"}
            className={`${iconBtn} w-4 text-[10px] text-[#c9c9c9]`}
          >
            {isLuma(mode) ? "L" : "α"}
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => set(matte.layer, matteMode(isLuma(mode), !isInverted(mode)), `Track matte of ${layer.id}: ${isInverted(mode) ? "normal" : "inverted"}`)}
            title={isInverted(mode) ? "Inverted (click for normal)" : "Normal (click to invert)"}
            className={`${iconBtn} w-4 ${isInverted(mode) ? "text-[#4aa3f0]" : "text-[#666]"}`}
          >
            <svg viewBox="0 0 16 16" className="size-3" aria-hidden>
              <rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={1.3} />
              <path d="M2.5 13.5 13.5 2.5V13.5Z" fill="currentColor" />
            </svg>
          </button>
        </>
      )}
    </span>
  );
});

/** Pick-whip drag in progress: from the spiral to the pointer. */
type Whip = { x0: number; y0: number; x: number; y: number };

/**
 * Parent & Link: the pick-whip (drag the spiral onto another layer's row) and a dropdown. Both
 * keep the child where it is on screen.
 */
export const ParentCell = memo(function ParentCell({ scene, layer, numbers }: { scene: TimelineScene; layer: TimelineLayer; numbers: Map<string, number> }) {
  const [whip, setWhip] = useState<Whip | null>(null);
  const locked = isLocked(layer);
  const banned = descendants(scene, layer.id);
  const setParent = (parent: string | null) =>
    runOps(parentOps(scene, layer.id, parent), parent ? `Parents ${layer.id} to ${parent}` : `Unparents ${layer.id}`);

  const drag = (e: ReactPointerEvent) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const start = { x0: r.left + r.width / 2, y0: r.top + r.height / 2 };
    setWhip({ ...start, x: e.clientX, y: e.clientY });
    const move = (ev: PointerEvent) => setWhip({ ...start, x: ev.clientX, y: ev.clientY });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      setWhip(null);
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-layer-row]");
      const target = row?.dataset.layerRow;
      if (target && !banned.has(target) && target !== layer.parent) setParent(target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  return (
    <span className="flex shrink-0 items-center gap-1" style={{ width: COL.parent }}>
      <span
        role="button"
        tabIndex={-1}
        onPointerDown={drag}
        title="Pick whip: drag onto a layer to parent to it"
        className={`flex size-4 shrink-0 cursor-crosshair items-center justify-center ${locked ? "opacity-30" : "text-[#8a8a8a] hover:text-white"}`}
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden>
          <path d="M8 8.2a.9.9 0 1 1 .9-.9 2.4 2.4 0 1 1-2.4-2.4 3.9 3.9 0 1 1-3.9 3.9" strokeLinecap="round" />
        </svg>
      </span>
      <select
        value={layer.parent ?? ""}
        disabled={locked}
        onChange={(e) => setParent(e.target.value || null)}
        className={`${selectCls} flex-1`}
        aria-label="Parent"
        title={layer.parent ? `Parented to ${layer.parent}` : "No parent"}
      >
        <option value="" className="bg-[#232323]">
          None
        </option>
        {[...scene.layers]
          .reverse()
          .filter((l) => !banned.has(l.id))
          .map((l) => (
            <option key={l.id} value={l.id} className="bg-[#232323]">
              {named(numbers, l.id)}
            </option>
          ))}
      </select>
      {whip && (
        <svg className="pointer-events-none fixed inset-0 z-[100] h-screen w-screen" aria-hidden>
          <line x1={whip.x0} y1={whip.y0} x2={whip.x} y2={whip.y} stroke="#4aa3f0" strokeWidth={1.5} />
          <circle cx={whip.x} cy={whip.y} r={3} fill="#4aa3f0" />
        </svg>
      )}
    </span>
  );
});

/** Anchor Point row (the layer's `pivot`, px from its center). Not keyframable in the engine. */
export function AnchorRow({ layer, indent }: { layer: TimelineLayer; indent: number }) {
  const [px, py] = layer.pivot ?? [0, 0];
  const edit = (v: [number, number], done: boolean) => {
    const op = { op: OpName.Patch, id: layer.id, fields: { pivot: v } };
    preview([op]);
    if (done) commit(`Anchor point of ${layer.id}: ${v[0].toFixed(0)}, ${v[1].toFixed(0)}`);
  };
  return (
    <div className="flex h-6 w-full items-center gap-1.5 pr-2" style={{ paddingLeft: indent + 46 }}>
      <span className="min-w-0 flex-1 truncate">Anchor Point</span>
      <span className="flex shrink-0 gap-2">
        <ScrubNumber value={px} step={1} onChange={(v, done) => edit([v, py], done)} />
        <ScrubNumber value={py} step={1} onChange={(v, done) => edit([px, v], done)} />
      </span>
    </div>
  );
}
