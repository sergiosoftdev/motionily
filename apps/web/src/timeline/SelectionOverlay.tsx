import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { OpName } from "@motionily/protocol";
import { apply, commit, moveOps, preview, resizeOps } from "../editing/direct";
import {
  groupLayerIds,
  moveGroupOps,
  removeGroupOps,
  resizeGroupOps,
  selectAt,
  snapshot,
  unionBounds,
} from "../editing/groups";
import { engineHost } from "../engine/host";
import { useEditor } from "../store";

/** Pointer travel (px) before a press on the selection counts as a drag, not a click. */
const DRAG_THRESHOLD = 3;
const MIN_RESIZE = 0.1;
/** How long a click on the selected layer waits for a second click (double-click edits text). */
const DOUBLE_CLICK_MS = 260;

/** What is under a pointer on the preview canvas, front to back. */
function stackAt(c: HTMLCanvasElement, e: { clientX: number; clientY: number }) {
  const r = c.getBoundingClientRect();
  const [sw, sh] = engineHost.sceneSize();
  return engineHost.pickStack(((e.clientX - r.left) / r.width) * sw, ((e.clientY - r.top) / r.height) * sh);
}

/**
 * Click an object in the preview to select it (requests then go to it alone), drag it to move,
 * drag the corner to resize, double-click to edit its text, Delete to remove it.
 */
export function SelectionOverlay({ canvas }: { canvas: RefObject<HTMLCanvasElement | null> }) {
  const selected = useEditor((s) => s.selectedLayerId);
  const group = useEditor((s) => s.selectedGroup);
  /** What the selection is called (group name or layer id). */
  const label = group ?? selected;
  const time = useEditor((s) => s.time);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    rotation: number;
  } | null>(null);
  /** Bumped while dragging so the box follows the edit. */
  const [tick, setTick] = useState(0);
  const [editingText, setEditingText] = useState<string | null>(null);
  const pendingPick = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pendingPick.current), []);

  // Keyboard: Delete removes the selected layer, Escape deselects. Never while typing.
  useEffect(() => {
    if (!label) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable
      )
        return;
      if (e.key === "Escape")
        useEditor.setState({ selectedLayerId: null, selectedGroup: null });
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        apply(
          group
            ? removeGroupOps(group)
            : [{ op: OpName.RemoveLayer, id: label }],
          `Removes ${label}`,
        );
        useEditor.setState({ selectedLayerId: null, selectedGroup: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [label, group]);

  // Hit-test clicks on the canvas.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onClick = (e: MouseEvent) => selectAt(stackAt(c, e), e.metaKey || e.ctrlKey);
    c.addEventListener("click", onClick);
    return () => c.removeEventListener("click", onClick);
  }, [canvas]);

  // The preview resizes (timeline grows, window changes): re-place the box.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(c);
    return () => ro.disconnect();
  }, [canvas]);

  // Follow the selected layer as time moves.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !label) return setBox(null);
    const b = group
      ? unionBounds(groupLayerIds(group))
      : engineHost.layerBounds(selected!);
    if (!b) return setBox(null);
    const [sw, sh] = engineHost.sceneSize();
    const kx = c.clientWidth / sw;
    const ky = c.clientHeight / sh;
    const [cx = 0, cy = 0, w = 0, h = 0, rot = 0] = b;
    let [x0, y0, x1, y1] = [(cx - w / 2) * kx, (cy - h / 2) * ky, (cx + w / 2) * kx, (cy + h / 2) * ky];
    // What bleeds off the frame (backgrounds) is framed at the frame's edge, not across the page.
    if (!rot) [x0, y0, x1, y1] = [Math.max(0, x0), Math.max(0, y0), Math.min(c.clientWidth, x1), Math.min(c.clientHeight, y1)];
    setBox({
      left: c.offsetLeft + x0,
      top: c.offsetTop + y0,
      width: Math.max(0, x1 - x0),
      height: Math.max(0, y1 - y0),
      rotation: rot,
    });
  }, [canvas, selected, group, label, time, tick]);

  if (!label || !box) return null;

  /** Drag the selection: move (body) or resize (corner handle). Pure local edit, no agent. */
  const drag = (resize: boolean) => (e: ReactPointerEvent) => {
    const c = canvas.current;
    const groupBase = group ? snapshot(groupLayerIds(group)) : null;
    const base = selected ? engineHost.layer(selected) : undefined;
    if (!c || (!base && !groupBase)) return;
    const center = (group && unionBounds(groupLayerIds(group))) || [0, 0];
    e.preventDefault();
    e.stopPropagation();
    const [sw] = engineHost.sceneSize();
    const k = c.clientWidth / sw;
    const [x0, y0] = [e.clientX, e.clientY];
    const b = (selected && engineHost.layerBounds(selected)) || [0, 0, 1, 1];
    const size: [number, number] = [b[2] ?? 1, b[3] ?? 1];
    const diag0 = Math.hypot(box.width, box.height);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const [dx, dy] = [ev.clientX - x0, ev.clientY - y0];
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      const f = Math.max(MIN_RESIZE, (diag0 + (dx + dy) / Math.SQRT2) / diag0);
      if (groupBase)
        preview(
          resize
            ? resizeGroupOps(groupBase, f, [center[0]!, center[1]!])
            : moveGroupOps(groupBase, dx / k, dy / k),
        );
      else if (resize) preview(resizeOps(selected!, base!, f, size));
      else preview(moveOps(selected!, base!, dx / k, dy / k));
      setTick((t) => t + 1);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      if (moved) return commit(resize ? `Resizes ${label}` : `Moves ${label}`);
      if (resize) return;
      // A click (no drag) goes through to what is under it: into the group, or the next layer down.
      const stack = stackAt(c, ev);
      const deep = ev.metaKey || ev.ctrlKey;
      clearTimeout(pendingPick.current);
      if (group) selectAt(stack, deep);
      // A selected layer first waits out a double-click, which edits its text instead.
      else pendingPick.current = setTimeout(() => selectAt(stack, deep), DOUBLE_CLICK_MS);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const layerText = () => {
    if (!selected) return null;
    const l = engineHost.layer(selected);
    return l?.type === "text" ? String(l.text ?? "") : null;
  };

  return (
    <>
      <div
        className={`absolute cursor-move rounded-sm ring-2 ${group ? "ring-violet-400" : "ring-sky-400"}`}
        style={{ ...box, transform: `rotate(${box.rotation}rad)` }}
        onPointerDown={drag(false)}
        onDoubleClick={() => {
          clearTimeout(pendingPick.current);
          setEditingText(layerText());
        }}
        title="Click again to go inside (or to what is under it) · ⌘-click picks a layer directly · drag to move · double-click to edit the text · Delete to remove"
      >
        <span
          className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm bg-white ring-2 ring-sky-400"
          onPointerDown={drag(true)}
        />
        {editingText !== null && (
          <textarea
            autoFocus
            value={editingText}
            onChange={(e) => setEditingText(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditingText(null);
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (editingText.trim())
                  apply(
                    [{ op: OpName.SetText, id: selected, text: editingText }],
                    `Text of ${selected}: ${editingText}`,
                  );
                setEditingText(null);
              }
            }}
            onBlur={() => setEditingText(null)}
            className="absolute inset-0 resize-none bg-neutral-950/90 p-1 text-sm text-white focus:outline-none"
          />
        )}
      </div>
    </>
  );
}

/**
 * A request about one layer, one group or one moment: the agent goes straight to it instead of
 * re-reading the video.
 */
export function scopedInstruction(request: string, time: number, group: string | null, layer: string | null, moment = false): string {
  const at = time.toFixed(1);
  if (group)
    return `Only about group '${group}' (around ${at}s): ${request}. Read it with inspect group:${group} and change only that group — to redesign it, remove_group ${group} and add new layers with "group":"${group}" in the same time span and area. Do not touch other layers. Then render_frames at ${at}s to check.`;
  if (layer) return `Only about layer '${layer}' (around ${at}s): ${request}. Read it with inspect ${layer}, change just that layer, then render_frames at ${at}s to check.`;
  if (moment) return `About the moment at ${at}s: ${request}. Change only what is on screen around then (get_layout at ${at} lists it), then render_frames at ${at}s to check.`;
  return request;
}
