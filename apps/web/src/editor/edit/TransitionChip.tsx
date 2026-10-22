import { memo, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { SceneView } from "../sceneView";
import type { EditClip } from "./tracks";
import { addTransitionOps, changeTransitionOps, removeTransitionOps, retimeTransitionOps, TRANSITION_LABEL, TransitionKind } from "./transitions";
import type { EditActions } from "./useEditActions";

const DRAG_THRESHOLD = 3;
/** Narrowest a transition chip is drawn (px), however short it is. */
const MIN_CHIP = 16;
const Side = { Left: "left", Right: "right" } as const;
type Side = (typeof Side)[keyof typeof Side];

const KINDS = Object.values(TransitionKind);
const CHIP_FILL: Record<TransitionKind, string> = {
  [TransitionKind.Dissolve]: "bg-white/85 text-neutral-900",
  [TransitionKind.DipToBlack]: "bg-neutral-900/90 text-white ring-1 ring-white/60",
  [TransitionKind.DipToWhite]: "bg-white text-neutral-900 ring-1 ring-neutral-900/40",
};

function BowTie() {
  return (
    <svg viewBox="0 0 16 16" className="size-3 fill-current" aria-hidden>
      <path d="M2 3l6 5-6 5zM14 3L8 8l6 5z" />
    </svg>
  );
}

/**
 * The cut between two touching clips of the main track (`a` then `b`): a small handle that adds a
 * transition, or the transition itself, as wide as it lasts. Click for the kinds (and Remove); drag
 * an edge of a transition to change its length. Every change is one undoable edit.
 */
export const TransitionChip = memo(function TransitionChip({ a, b, scene, pps, edits }: { a: EditClip; b: EditClip; scene: SceneView; pps: number; edits: EditActions }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const tr = b.transition;

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => (e instanceof KeyboardEvent ? e.key === "Escape" && setMenu(null) : setMenu(null));
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const pick = (kind: TransitionKind) => {
    setMenu(null);
    const ops = tr ? changeTransitionOps(scene, a, b, kind) : addTransitionOps(scene, a, b, kind);
    if (ops?.length) edits.apply(ops, `${TRANSITION_LABEL[kind]} into ${b.id}`, true);
  };
  const remove = () => {
    setMenu(null);
    edits.apply(removeTransitionOps(scene, a, b), `Removes the transition into ${b.id}`, true);
  };
  const openMenu = (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left + r.width / 2, y: r.top });
  };

  /** Drag an edge: outward makes it longer (the clips after it slide to keep the overlap). */
  const resize = (side: Side) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!tr) return;
    const x0 = e.clientX;
    let moved = false;
    let d = tr.duration;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD) return;
      if (!moved) edits.begin();
      moved = true;
      const dt = (ev.clientX - x0) / pps;
      d = side === Side.Left ? tr.duration - dt : tr.duration + dt;
      edits.preview(retimeTransitionOps(scene, a, b, d));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) edits.end(`${TRANSITION_LABEL[tr.kind]} into ${b.id}: ${Math.max(0, d).toFixed(2)} s`, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const width = tr ? Math.max(MIN_CHIP, tr.duration * pps) : MIN_CHIP;
  const center = tr ? (b.start + a.end) / 2 : a.end;
  return (
    <>
      {tr ? (
        <div
          data-transition={b.id}
          title={`${TRANSITION_LABEL[tr.kind]} · ${tr.duration.toFixed(2)} s — click to change, drag an edge to resize`}
          onPointerDown={openMenu}
          className={`absolute top-1/2 z-10 flex h-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md shadow-md shadow-black/40 ${CHIP_FILL[tr.kind]}`}
          style={{ left: center * pps, width }}
        >
          <BowTie />
          <span onPointerDown={resize(Side.Left)} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-md hover:bg-sky-400/70" />
          <span onPointerDown={resize(Side.Right)} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-md hover:bg-sky-400/70" />
        </div>
      ) : (
        <button
          type="button"
          data-cut={b.id}
          title="Add a transition"
          onPointerDown={openMenu}
          className="absolute top-1/2 z-10 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-neutral-950/80 text-white/70 ring-1 ring-white/40 hover:bg-white hover:text-neutral-900"
          style={{ left: center * pps }}
        >
          <BowTie />
        </button>
      )}
      {menu &&
        createPortal(
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="fixed z-50 flex min-w-36 -translate-x-1/2 -translate-y-full flex-col rounded-lg bg-neutral-900 p-1 text-xs shadow-xl ring-1 ring-white/10"
            style={{ left: menu.x, top: menu.y - 6 }}
          >
            {KINDS.map((k) => (
              <button key={k} type="button" onClick={() => pick(k)} className="flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-neutral-200 hover:bg-neutral-800">
                {TRANSITION_LABEL[k]}
                {tr?.kind === k && <span className="text-neutral-500">✓</span>}
              </button>
            ))}
            {tr && (
              <button type="button" onClick={remove} className="rounded-md px-2.5 py-1.5 text-left text-neutral-400 hover:bg-neutral-800 hover:text-red-400">
                Remove
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
});
