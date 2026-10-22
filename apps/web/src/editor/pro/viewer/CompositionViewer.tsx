import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { OpName, type Op } from "@motionily/protocol";
import { apply } from "../../../editing/direct";
import { engineHost } from "../../../engine/host";
import { ActivitySource, logActivity, useEditor } from "../../../store";
import { Viewer } from "../../Viewer";
import { editable, measure, nudgeOps, type Frame } from "./frame";
import { currentScale, hold, Rulers, RULER_PX, setSpace, ViewerOverlay, zoomTo } from "./Overlay";
import {
  cycleShape,
  followStoreSelection,
  openProject,
  Overlay,
  PLATFORMS,
  SHAPE_KINDS,
  ShapeKind,
  selectedIds,
  setGuides,
  setPlatform,
  setSelection,
  setTool,
  stepZoom,
  toggleOverlay,
  Tool,
  useViewer,
  ZOOM_PRESETS,
  zoomLabel,
  type Platform,
} from "./state";

const typing = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

/** AE's single-key tools (Q and ⌘T are handled apart). */
const TOOL_KEYS: Record<string, Tool> = { v: Tool.Select, h: Tool.Hand, z: Tool.Zoom, w: Tool.Rotate, y: Tool.PanBehind, g: Tool.Pen };
const NUDGE = 1;
const NUDGE_BIG = 10;

function run(ops: Op[], what: string) {
  if (!ops.length) return;
  try {
    apply(ops, what);
  } catch (e) {
    logActivity(ActivitySource.System, `${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Keys of the Composition panel (Pro only, never while typing): tools, zoom (`.` `,` ⇧/), overlays
 * (⌘' grid, ⌘R rulers, ⌘; guides, ⌘⇧; snapping, ' safe areas), arrows nudge, Delete removes,
 * Escape deselects, and Space held over the viewer pans (a tap still plays).
 */
function useViewerKeys(canvas: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target)) return;
      const c = canvas.current;
      const k = e.key.toLowerCase();
      let handled = true;
      if (e.metaKey || e.ctrlKey) {
        if (e.code === "Quote") toggleOverlay(Overlay.Grid);
        else if (k === "r" && !e.shiftKey && !e.altKey) toggleOverlay(Overlay.Rulers);
        else if (e.code === "Semicolon") toggleOverlay(e.shiftKey ? Overlay.Snap : Overlay.Guides);
        else if (k === "t") setTool(Tool.Type);
        else handled = false;
      } else if (e.altKey) handled = false;
      else if (e.code === "Slash" && e.shiftKey) c && zoomTo(c, null);
      else if (e.code === "Period" || e.code === "Comma") c && zoomTo(c, stepZoom(currentScale(c), e.code === "Period" ? 1 : -1));
      else if (e.code === "Quote") toggleOverlay(Overlay.Safe);
      else if (TOOL_KEYS[k] && !e.shiftKey) setTool(TOOL_KEYS[k]);
      else if (k === "q") cycleShape();
      else if (k.startsWith("arrow")) {
        const frames = selectedIds()
          .filter(editable)
          .flatMap((id) => measure(id) ?? ([] as Frame[]));
        const step = e.shiftKey ? NUDGE_BIG : NUDGE;
        const d: [number, number] = k === "arrowleft" ? [-step, 0] : k === "arrowright" ? [step, 0] : k === "arrowup" ? [0, -step] : [0, step];
        if (frames.length) run(nudgeOps(frames, d), `Nudges ${frames.length === 1 ? frames[0]!.id : `${frames.length} layers`}`);
        else handled = false;
      } else if (k === "escape") {
        if (selectedIds().length) setSelection([]);
        else handled = false;
      } else if (k === "delete" || k === "backspace") {
        const { selectedGroup } = useEditor.getState();
        const ids = selectedIds();
        if (!ids.length) handled = false;
        else {
          run(selectedGroup ? [{ op: OpName.RemoveGroup, group: selectedGroup }] : ids.map((id) => ({ op: OpName.RemoveLayer, id })), `Removes ${selectedGroup ?? ids.join(", ")}`);
          setSelection([]);
        }
      } else handled = false;
      if (handled) e.preventDefault();
    };
    // Space over the viewer: held = hand tool; released without panning = play/pause.
    const spaceDown = (e: KeyboardEvent) => {
      if (e.key !== " " || !hold.hover || typing(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || hold.space) return;
      hold.panned = false;
      setSpace(true);
    };
    const spaceUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !hold.space) return;
      e.preventDefault();
      setSpace(false);
      if (hold.panned) return;
      if (useEditor.getState().playing) engineHost.pause();
      else engineHost.play();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", spaceDown, { capture: true });
    window.addEventListener("keyup", spaceUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", spaceDown, { capture: true });
      window.removeEventListener("keyup", spaceUp, { capture: true });
    };
  }, [canvas]);
}

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" aria-hidden>
    {d}
  </svg>
);
const SHAPE_ICON: Record<ShapeKind, ReactNode> = {
  rect: <rect x="2.5" y="3.5" width="11" height="9" />,
  round_rect: <rect x="2.5" y="3.5" width="11" height="9" rx="2.5" />,
  ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="4.5" />,
  polygon: <path d="M8 2.5 13.5 6.5 11.4 13H4.6L2.5 6.5Z" />,
  star: <path d="m8 2 1.8 3.8 4.2.5-3.1 2.8.8 4.1L8 11.2 4.3 13.2l.8-4.1L2 6.3l4.2-.5Z" />,
};
const TOOLS: [Tool, string, ReactNode][] = [
  [Tool.Select, "Selection Tool (V)", <path d="M4 2.5v10l2.7-2.4 1.8 4 1.6-.7-1.8-3.9H12Z" />],
  [Tool.Hand, "Hand Tool (H, or hold Space)", <path d="M5.5 8.5V4a1 1 0 0 1 2 0v3.5m0-.5V3a1 1 0 0 1 2 0v4m0 0V4a1 1 0 0 1 2 0v4.5m0-1a1 1 0 0 1 2 0V10c0 2.5-2 4.5-4.5 4.5S5 13.5 4 12L2.6 9.6a1 1 0 0 1 1.7-1l1.2 1.4" />],
  [Tool.Zoom, "Zoom Tool (Z) · Alt-click zooms out", <><circle cx="7" cy="7" r="4" /><path d="m10 10 3.5 3.5M5 7h4M7 5v4" /></>],
  [Tool.Rotate, "Rotation Tool (W)", <><path d="M12.5 8A4.5 4.5 0 1 1 8 3.5h2" /><path d="m8.5 1.5 2 2-2 2" /></>],
  [Tool.PanBehind, "Pan Behind (Anchor Point) Tool (Y)", <><circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4" /></>],
];

/** AE's Tools bar across the top of the Composition panel. */
function ToolsBar() {
  const tool = useViewer((s) => s.tool);
  const shape = useViewer((s) => s.shape);
  const button = (t: Tool, title: string, glyph: ReactNode, onClick = () => setTool(t)) => (
    <button
      key={t}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={tool === t}
      onClick={onClick}
      className={`flex size-6 items-center justify-center rounded-sm ${tool === t ? "bg-[#3e3e3e] text-[#4aa3f0]" : "text-[#a8a8a8] hover:bg-[#2e2e2e] hover:text-[#e6e6e6]"}`}
    >
      {icon(glyph)}
    </button>
  );
  const shapeLabel = SHAPE_KINDS.find(([k]) => k === shape)?.[1] ?? "Shape";
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-[#151515] px-2" role="toolbar" aria-label="Tools">
      {TOOLS.map(([t, title, glyph]) => button(t, title, glyph))}
      <span className="mx-1 h-4 w-px bg-[#3a3a3a]" />
      {button(Tool.Shape, `${shapeLabel} Tool (Q cycles shapes)`, SHAPE_ICON[shape], cycleShape)}
      {button(Tool.Pen, "Pen Tool (G) · click the first point to close", <path d="m3 13 1.5-5L10 2.5l3.5 3.5L8 11.5Zm0 0 3.5-3.5" />)}
      {button(Tool.Type, "Horizontal Type Tool (⌘T)", <path d="M3.5 3.5h9M8 3.5v9M6 12.5h4" />)}
      {tool === Tool.Shape && (
        <span className="ml-2 flex gap-0.5">
          {SHAPE_KINDS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => useViewer.setState({ shape: k })}
              className={`flex size-6 items-center justify-center rounded-sm ${shape === k ? "text-[#4aa3f0]" : "text-[#8a8a8a] hover:text-[#e6e6e6]"}`}
            >
              {icon(SHAPE_ICON[k])}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The Composition panel body: tools bar, rulers and the zoomable viewer with the gizmo overlay.
 * The footer controls (ZoomMenu, OverlayMenu) sit in ProEditor's footer bar.
 */
export function CompositionViewer({ canvas, error, projectId }: { canvas: RefObject<HTMLCanvasElement>; error: string | null; projectId: string }) {
  const zoom = useViewer((s) => s.zoom);
  const pan = useViewer((s) => s.pan);
  const rulers = useViewer((s) => s.overlays[Overlay.Rulers]);
  const viewZoom = useMemo(() => (zoom === null ? null : { scale: zoom, pan }), [zoom, pan]);
  useEffect(() => openProject(projectId), [projectId]);
  useEffect(() => followStoreSelection(), []);
  useViewerKeys(canvas);
  const overlay = useMemo(() => <ViewerOverlay canvas={canvas} />, [canvas]);

  return (
    <>
      <ToolsBar />
      <div className="relative flex min-h-0 flex-1 flex-col bg-[#1a1a1a]">
        {rulers && <Rulers canvas={canvas} />}
        <div className="flex min-h-0 flex-1 flex-col p-3" style={rulers ? { paddingTop: RULER_PX + 12, paddingLeft: RULER_PX + 12 } : undefined}>
          <Viewer canvas={canvas} error={error} zoom={viewZoom} overlay={overlay} />
        </div>
      </div>
    </>
  );
}

/** Footer magnification menu (AE's "Magnification ratio popup"). */
export function ZoomMenu({ canvas }: { canvas: RefObject<HTMLCanvasElement | null> }) {
  const zoom = useViewer((s) => s.zoom);
  const value = zoom === null ? "fit" : String(zoom);
  const custom = zoom !== null && !(ZOOM_PRESETS as readonly number[]).includes(zoom);
  return (
    <select
      aria-label="Magnification"
      title="Magnification (. and , zoom, ⇧/ fits)"
      value={value}
      onChange={(e) => canvas.current && zoomTo(canvas.current, e.target.value === "fit" ? null : Number(e.target.value))}
      className="rounded-sm bg-transparent py-0.5 text-[11px] text-[#c9c9c9] outline-none hover:bg-[#2e2e2e] [&>option]:bg-[#232323]"
    >
      <option value="fit">Fit</option>
      {custom && <option value={value}>{zoomLabel(zoom)}</option>}
      {ZOOM_PRESETS.map((z) => (
        <option key={z} value={String(z)}>
          {zoomLabel(z)}
        </option>
      ))}
    </select>
  );
}

const OVERLAY_ITEMS: [Overlay, string, string][] = [
  [Overlay.Safe, "Title/Action Safe", "'"],
  [Overlay.Grid, "Grid", "⌘'"],
  [Overlay.Rulers, "Rulers", "⌘R"],
  [Overlay.Guides, "Guides", "⌘;"],
  [Overlay.Snap, "Snapping", "⌘⇧;"],
];

/** Footer grid & guide options, plus the vertical-video app UI zones. */
export function OverlayMenu() {
  const overlays = useViewer((s) => s.overlays);
  const platform = useViewer((s) => s.platform);
  const guides = useViewer((s) => s.guides);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest("[data-overlay-menu]") && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const on = OVERLAY_ITEMS.some(([o]) => o !== Overlay.Snap && o !== Overlay.Guides && overlays[o]) || platform !== "none";
  return (
    <span className="relative" data-overlay-menu>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={`rounded-sm px-1 py-0.5 hover:bg-[#2e2e2e] ${on ? "text-[#4aa3f0]" : ""}`} title="Grid and guide options">
        Grid & Guides ▾
      </button>
      {open && (
        <div className="absolute bottom-7 left-0 z-30 flex w-60 flex-col gap-0.5 rounded-sm bg-[#2b2b2b] p-1.5 text-[12px] text-[#c9c9c9] shadow-xl ring-1 ring-black/40">
          {OVERLAY_ITEMS.map(([o, label, keys]) => (
            <label key={o} className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-[#3a3a3a]">
              <input type="checkbox" checked={overlays[o]} onChange={() => toggleOverlay(o)} className="accent-[#2d8ceb]" />
              <span className="flex-1">{label}</span>
              <span className="text-[11px] text-[#8a8a8a]">{keys}</span>
            </label>
          ))}
          <button
            type="button"
            disabled={!guides.x.length && !guides.y.length}
            onClick={() => setGuides({ x: [], y: [] })}
            className="rounded-sm px-1.5 py-1 text-left hover:bg-[#3a3a3a] disabled:opacity-40"
          >
            Clear guides
          </button>
          <label className="mt-1 flex items-center gap-2 border-t border-[#151515] px-1.5 pt-2">
            <span className="flex-1">App UI (vertical)</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)} className="rounded-sm bg-[#1b1b1b] px-1 py-0.5 outline-none">
              {PLATFORMS.map(([p, label]) => (
                <option key={p} value={p}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </span>
  );
}
