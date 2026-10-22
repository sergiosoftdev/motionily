import { memo, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { commit, preview } from "../../../editing/direct";
import { engineHost } from "../../../engine/host";
import { isKeys, keyTimes, snap, type Anim, type PropDef } from "../keys";
import { runOps } from "../layerActions";
import type { TimelineLayer, TimelineScene } from "./contract";
import { BEZIER, deleteKeys, Ease, EaseSide, easyEase, editSelected, keyInterp, keySides, KeySide, moveKeys, setInterpolation } from "./keyEdit";
import { sameKey, setKeySelection, useTimelineSelection, type KeyRef } from "./selection";

const DRAG_THRESHOLD = 3;
const PICKED = "#4aa3f0";
const KEY = "#b9b9b9";

/** Half of a key icon, on a 10×10 box: AE's diamond (linear), hourglass (easy ease), square (hold), circle (overshoot). */
function half(side: KeySide, right: boolean): string {
  const m = (x: number) => (right ? 10 - x : x);
  switch (side) {
    case KeySide.Linear:
      return `M5 0.5L${m(0.5)} 5L5 9.5Z`;
    case KeySide.Eased:
      return `M5 0.5H${m(1)}L5 5L${m(1)} 9.5H5Z`;
    case KeySide.Hold:
      return `M5 1H${m(1)}V9H5Z`;
    default:
      return `M5 1A4 4 0 0 ${right ? 1 : 0} 5 9Z`;
  }
}

/** Every keyframe command of the key menu and the F9 keys, on the selected keys. */
export const KeyCommand = { Interp: "interp", Ease: "ease", Delete: "delete" } as const;
export type KeyCommand =
  | { kind: typeof KeyCommand.Interp; value: Ease | typeof BEZIER }
  | { kind: typeof KeyCommand.Ease; side: EaseSide }
  | { kind: typeof KeyCommand.Delete };

export function runKeyCommand(scene: TimelineScene, refs: KeyRef[], fps: number, cmd: KeyCommand): boolean {
  if (!refs.length) return false;
  const n = `${refs.length} key${refs.length > 1 ? "s" : ""}`;
  if (cmd.kind === KeyCommand.Delete) {
    const ok = runOps(editSelected(scene, refs, (keys, times) => deleteKeys(keys, times, fps)), `Removes ${n}`);
    if (ok) setKeySelection([]);
    return ok;
  }
  if (cmd.kind === KeyCommand.Ease)
    return runOps(editSelected(scene, refs, (keys, times) => easyEase(keys, times, cmd.side, fps)), `Easy Ease${cmd.side === EaseSide.Both ? "" : cmd.side === EaseSide.In ? " In" : " Out"} on ${n}`);
  return runOps(editSelected(scene, refs, (keys, times) => setInterpolation(keys, times, cmd.value, fps)), `${INTERP_LABEL[cmd.value]} interpolation on ${n}`);
}

/**
 * Press on a key: click picks it (and jumps there), Shift-click adds or removes it, dragging
 * moves every picked key together (snapped to frames, never before the layer start).
 */
export function pressKey(e: ReactPointerEvent, ref: KeyRef, scene: TimelineScene, fps: number, pps: number) {
  e.stopPropagation();
  if (e.button !== 0) return;
  const sel = useTimelineSelection.getState().keys;
  const isSel = sel.some((k) => sameKey(k, ref, fps));
  if (e.shiftKey) return setKeySelection(isSel ? sel.filter((k) => !sameKey(k, ref, fps)) : [...sel, ref]);
  const refs = isSel ? sel : [ref];
  if (!isSel) setKeySelection(refs);
  const x0 = e.clientX;
  const minT = Math.min(...refs.map((r) => r.t));
  let moved = false;
  let dt = 0;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD) return;
    moved = true;
    dt = snap(Math.max(-minT, (ev.clientX - x0) / pps), fps);
    preview(editSelected(scene, refs, (keys, times) => moveKeys(keys, times, dt, fps)));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    if (moved) {
      commit(`Moves ${refs.length} key${refs.length > 1 ? "s" : ""} ${dt >= 0 ? "+" : ""}${dt.toFixed(2)} s`);
      setKeySelection(refs.map((r) => ({ ...r, t: snap(r.t + dt, fps) })));
    } else {
      const start = scene.layers.find((l) => l.id === ref.id)?.start ?? 0;
      engineHost.pause();
      engineHost.seek(start + ref.t);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

type TrackProps = {
  scene: TimelineScene;
  layer: TimelineLayer;
  def: PropDef;
  fps: number;
  pps: number;
  /** Picked local times on this row, joined (a cheap memo key). */
  picked: string;
  locked: boolean;
  onMenu: (e: React.MouseEvent, ref: KeyRef) => void;
};

/** The keyframes of one property row, drawn with AE's interpolation icons (left half = in, right half = out). */
export const KeyTrack = memo(function KeyTrack({ scene, layer, def, fps, pps, picked, locked, onMenu }: TrackProps) {
  const start = layer.start ?? 0;
  const anims = def.props.map((p) => layer[p] as Anim | undefined);
  const pickedT = picked ? picked.split(",").map(Number) : [];
  return (
    <>
      {keyTimes(anims, fps).map((k) => {
        const ref: KeyRef = { id: layer.id, props: def.props, t: k.t };
        const keys = anims.find((a) => isKeys(a) && a.some((x) => Math.abs(x.t - k.t) < 0.5 / fps)) as typeof k[] | undefined;
        const i = keys?.findIndex((x) => Math.abs(x.t - k.t) < 0.5 / fps) ?? -1;
        const [left, right] = keys && i >= 0 ? keySides(keys, i) : [KeySide.Linear, KeySide.Linear];
        const on = pickedT.some((t) => Math.abs(t - k.t) < 0.5 / fps);
        const interp = keyInterp(k);
        return (
          <span
            key={k.t}
            data-key-id={layer.id}
            data-key-props={def.props.join(",")}
            data-key-t={k.t}
            title={`${def.label} · ${(start + k.t).toFixed(2)} s · ${INTERP_LABEL[interp] ?? interp}`}
            onPointerDown={(e) => !locked && pressKey(e, ref, scene, fps, pps)}
            onContextMenu={(e) => !locked && onMenu(e, ref)}
            className={`absolute top-1/2 z-10 flex size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center ${locked ? "" : "cursor-pointer"}`}
            style={{ left: (start + k.t) * pps }}
          >
            <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
              <path d={half(left, false)} fill={on ? PICKED : KEY} />
              <path d={half(right, true)} fill={on ? PICKED : KEY} />
            </svg>
          </span>
        );
      })}
    </>
  );
});

export const INTERP_LABEL: Record<string, string> = {
  [Ease.Linear]: "Linear",
  [BEZIER]: "Bezier",
  [Ease.Hold]: "Hold",
  [Ease.EaseInOut]: "Ease In Out",
  [Ease.EaseIn]: "Ease In",
  [Ease.EaseOut]: "Ease Out",
  [Ease.ExpoIn]: "Expo In",
  [Ease.ExpoOut]: "Expo Out",
  [Ease.ExpoInOut]: "Expo In Out",
  [Ease.Back]: "Back",
  [Ease.Elastic]: "Elastic",
  [Ease.Bounce]: "Bounce",
  [Ease.Spring]: "Spring",
};
const NAMED: Ease[] = [Ease.EaseInOut, Ease.EaseIn, Ease.EaseOut, Ease.ExpoInOut, Ease.ExpoIn, Ease.ExpoOut, Ease.Back, Ease.Elastic, Ease.Bounce, Ease.Spring];

/** Right-click on a key: AE's Keyframe Interpolation, plus the engine's named eases. */
export function KeyMenu({ x, y, current, onPick, onClose }: { x: number; y: number; current: string | null; onPick: (c: KeyCommand) => void; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("pointerdown", close), window.removeEventListener("keydown", esc));
  }, [onClose]);
  const item = (label: string, cmd: KeyCommand, checked = false, hint?: string) => (
    <button
      key={label}
      type="button"
      onClick={() => (onPick(cmd), onClose())}
      className="flex items-center gap-2 px-3 py-[3px] text-left hover:bg-[#2d8ceb] hover:text-white"
    >
      <span className="w-3 text-[10px]">{checked ? "✓" : ""}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[10px] text-[#8a8a8a]">{hint}</span>}
    </button>
  );
  const sep = (k: string) => <span key={k} className="my-1 h-px bg-[#3a3a3a]" />;
  return (
    <div
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-[100] flex w-56 flex-col rounded-[3px] bg-[#2b2b2b] py-1 text-[12px] text-[#d6d6d6] shadow-xl ring-1 ring-black/60"
      style={{ left: x, top: Math.min(y, innerHeight - 420) }}
    >
      <span className="px-3 pb-1 text-[10px] text-[#8a8a8a]">Keyframe Interpolation</span>
      {item("Linear", { kind: KeyCommand.Interp, value: Ease.Linear }, current === Ease.Linear)}
      {item("Bezier (Easy Ease)", { kind: KeyCommand.Interp, value: BEZIER }, current === BEZIER, "F9")}
      {item("Hold", { kind: KeyCommand.Interp, value: Ease.Hold }, current === Ease.Hold)}
      {sep("s1")}
      {item("Easy Ease In", { kind: KeyCommand.Ease, side: EaseSide.In }, false, "⇧F9")}
      {item("Easy Ease Out", { kind: KeyCommand.Ease, side: EaseSide.Out }, false, "⌘⇧F9")}
      {sep("s2")}
      {NAMED.map((e) => item(INTERP_LABEL[e]!, { kind: KeyCommand.Interp, value: e }, current === e))}
      {sep("s3")}
      {item("Delete", { kind: KeyCommand.Delete }, false, "Del")}
    </div>
  );
}
