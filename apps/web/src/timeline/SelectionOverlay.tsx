import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { OpName } from "@motionily/protocol";
import { ReferenceStrip, useReferences } from "../components/References";
import { apply, commit, moveOps, preview, resizeOps } from "../editing/direct";
import {
  groupLayerIds,
  moveGroupOps,
  removeGroupOps,
  resizeGroupOps,
  selectFromPick,
  snapshot,
  unionBounds,
} from "../editing/groups";
import { api } from "../api/client";
import { engineHost } from "../engine/host";
import { ActivitySource, logActivity, useEditor } from "../store";
import {
  GenerateEventKind,
  GenerateStatus,
  loadPrefs,
  TOOL_LABEL,
  type GenerateState,
} from "../components/GeneratePanel";

const POLL_MS = 1200;
/** Pointer travel (px) before a press on the selection counts as a drag, not a click. */
const DRAG_THRESHOLD = 3;
const MIN_RESIZE = 0.1;

/**
 * Click an object in the preview to select it, then ask the agent about it.
 * The comment travels with the layer id, so the agent reads only that layer.
 */
export function SelectionOverlay({
  canvas,
  projectId,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  projectId: string;
}) {
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
  const [text, setText] = useState("");
  /** Agent run started from this popover, shown live next to the object. */
  const [run, setRun] = useState<GenerateState | null>(null);
  const running = run?.status === GenerateStatus.Running;
  /** Bumped while dragging so the box follows the edit. */
  const [tick, setTick] = useState(0);
  const [editingText, setEditingText] = useState<string | null>(null);
  const refs = useReferences();

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
          `Borra ${label}`,
        );
        useEditor.setState({ selectedLayerId: null, selectedGroup: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [label, group]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(
      () => void api.generateStatus(projectId).then(setRun, () => undefined),
      POLL_MS,
    );
    return () => clearInterval(timer);
  }, [running, projectId]);

  // Hit-test clicks on the canvas.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onClick = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      const [sw, sh] = engineHost.sceneSize();
      const id = engineHost.pick(
        ((e.clientX - r.left) / r.width) * sw,
        ((e.clientY - r.top) / r.height) * sh,
      );
      selectFromPick(id ?? null);
    };
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
    setBox({
      left: c.offsetLeft + (cx - w / 2) * kx,
      top: c.offsetTop + (cy - h / 2) * ky,
      width: w * kx,
      height: h * ky,
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
    const up = () => {
      window.removeEventListener("pointermove", move);
      if (moved) commit(resize ? `Redimensiona ${label}` : `Mueve ${label}`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const layerText = () => {
    if (!selected) return null;
    const l = engineHost.layer(selected);
    return l?.type === "text" ? String(l.text ?? "") : null;
  };

  const send = async () => {
    const t = text.trim();
    if (!t || running) return;
    logActivity(ActivitySource.User, `${label}: ${t}`);
    setText("");
    try {
      // The agent goes straight to this layer instead of re-reading the whole project.
      setRun(
        await api.generate(
          projectId,
          scopedInstruction(t, time, group, selected),
          loadPrefs(),
          refs.refs,
        ),
      );
      refs.clear();
    } catch (e) {
      // Agent busy or unavailable: keep the request as a comment for the next run.
      await api.addComment(projectId, t, time, label).catch(() => undefined);
      logActivity(
        ActivitySource.System,
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  const steps = (run?.events ?? [])
    .filter((e) => e.kind !== GenerateEventKind.Text)
    .slice(-4);
  const thought = [...(run?.events ?? [])]
    .reverse()
    .find((e) => e.kind === GenerateEventKind.Text);

  return (
    <>
      <div
        className={`absolute cursor-move rounded-sm ring-2 ${group ? "ring-violet-400" : "ring-sky-400"}`}
        style={{ ...box, transform: `rotate(${box.rotation}rad)` }}
        onPointerDown={drag(false)}
        onDoubleClick={() => setEditingText(layerText())}
        title="Arrastra para mover · doble clic para editar el texto · Supr para borrar"
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
                    `Texto de ${selected}: ${editingText}`,
                  );
                setEditingText(null);
              }
            }}
            onBlur={() => setEditingText(null)}
            className="absolute inset-0 resize-none bg-neutral-950/90 p-1 text-sm text-white focus:outline-none"
          />
        )}
      </div>
      <form
        className="absolute z-10 flex w-80 flex-wrap items-center gap-1 rounded-xl bg-neutral-900/95 p-1.5 shadow-xl ring-1 ring-white/10"
        {...refs.handlers}
        style={{
          left: Math.max(8, box.left + box.width / 2 - 144),
          top: box.top + box.height + 8,
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span className="shrink-0 rounded-md bg-sky-500/20 px-2 py-1 text-[11px] text-sky-200">
          {group ? `▣ ${group}` : selected}
        </span>
        <input
          autoFocus
          disabled={running}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            running
              ? "El agente está en ello…"
              : group
                ? "Ej.: rediséñalo para que quede más limpio"
                : "Pídele algo sobre esto…"
          }
          className="min-w-0 flex-1 bg-transparent px-1 text-xs placeholder:text-neutral-500 focus:outline-none"
        />
        {!running && <ReferenceStrip r={refs} compact />}
      </form>
      {run && run.status !== GenerateStatus.Idle && (
        <div
          className="absolute z-10 flex w-64 flex-col gap-1.5 rounded-xl bg-neutral-900/95 p-3 text-xs shadow-xl ring-1 ring-white/10"
          style={{ left: box.left + box.width + 12, top: box.top }}
        >
          <span className="flex items-center gap-2 font-medium">
            {running && (
              <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
            )}
            {running ? "Trabajando en " : "Listo: "}
            <span className="text-sky-300">
              {group ? `▣ ${group}` : selected}
            </span>
          </span>
          {steps.map((e, i) => (
            <span
              key={i}
              className={
                e.kind === GenerateEventKind.Error
                  ? "text-red-400"
                  : "text-neutral-400"
              }
            >
              {TOOL_LABEL[e.text] ?? e.text}
            </span>
          ))}
          {(running ? thought?.text : run.summary) && (
            <span className="line-clamp-4 text-neutral-300">
              {running ? thought?.text : run.summary}
            </span>
          )}
          {running ? (
            <button
              type="button"
              onClick={() => void api.stopGenerate(projectId).then(setRun)}
              className="self-start text-neutral-500 hover:text-white"
            >
              Parar
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setRun(null)}
              className="self-start text-neutral-500 hover:text-white"
            >
              Cerrar
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** A request about one layer or group: the agent goes straight to it instead of re-reading the video. */
export function scopedInstruction(request: string, time: number, group: string | null, layer: string | null): string {
  const at = time.toFixed(1);
  if (group)
    return `Only about group '${group}' (around ${at}s): ${request}. Read it with get_group ${group} and change only that group — to redesign it, remove_group ${group} and add new layers with "group":"${group}" in the same time span and area. Do not touch other layers. Then render_frames at ${at}s to check.`;
  if (layer) return `Only about layer '${layer}' (around ${at}s): ${request}. Read it with get_layer ${layer}, change just that layer, then render_frames at ${at}s to check.`;
  return request;
}
