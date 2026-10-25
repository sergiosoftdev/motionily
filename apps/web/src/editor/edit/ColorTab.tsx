import { useEffect, useState } from "react";
import { OpName, type MediaItem } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import { ColorSection } from "./ColorSection";
import { Scopes } from "./ScopesPanel";
import type { EditActions } from "./useEditActions";
import { trackWindow } from "./windowTrack";
import { matchColor } from "./colorMatch";
import { copyGrade, pasteGradeOps } from "./gradeClipboard";

/** Shapes a window can take (the engine's shape layers). */
const WindowShape = { Ellipse: "ellipse", Rect: "rect" } as const;
type WindowShape = (typeof WindowShape)[keyof typeof WindowShape];
const SHAPE_LABEL: Record<WindowShape, string> = { ellipse: "Circle", rect: "Rectangle" };
/** Feather of a new window, as a share of its size. */
const NEW_SOFT = 0.15;

type WindowLayer = { id: string; shape: WindowShape; invert: boolean; soft: number; x: number; y: number; w: number; h: number };

/** The clip's windows: adjustment shapes attached to it (`attach`), in stack order. */
function windowsOf(clipId: string): WindowLayer[] {
  try {
    const scene = JSON.parse(engineHost.sceneJson()) as { layers?: Record<string, unknown>[] };
    const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
    return (scene.layers ?? [])
      .filter((l) => l.attach === clipId && l.adjustment === true)
      .map((l) => ({ id: String(l.id), shape: l.shape === WindowShape.Rect ? WindowShape.Rect : WindowShape.Ellipse, invert: l.invert === true, soft: num(l.soft, 0), x: num(l.x, 0), y: num(l.y, 0), w: num(l.w, 100), h: num(l.h, 100) }));
  } catch {
    return [];
  }
}

/**
 * The Color tab: scopes, then the grade of the clip or of one of its windows (Resolve's power windows:
 * a soft circle or rectangle graded on its own, inside or outside, tracked to follow the picture).
 */
export function ColorTab({ clipId, allClipIds, edits, luts }: { clipId: string; allClipIds: string[]; edits: EditActions; luts: MediaItem[] }) {
  const [target, setTarget] = useState(clipId);
  const [, redraw] = useState(0);
  useEffect(() => setTarget(clipId), [clipId]);
  useEffect(() => {
    const off = engineHost.onSceneChange(() => redraw((n) => n + 1));
    return () => void off();
  }, []);
  const windows = windowsOf(clipId);
  const current = windows.find((w) => w.id === target) ?? null;
  if (target !== clipId && !current) setTimeout(() => setTarget(clipId));

  const addWindow = (shape: WindowShape) => {
    const [sw, sh] = engineHost.sceneSize();
    const clip = engineHost.layer(clipId);
    const taken = new Set(JSON.parse(engineHost.sceneJson()).layers.map((l: { id: string }) => l.id));
    let n = 1;
    while (taken.has(`${clipId}-win${n}`)) n++;
    const id = `${clipId}-win${n}`;
    const side = Math.round(Math.min(sw, sh) * 0.45);
    const index = (JSON.parse(engineHost.sceneJson()).layers as { id: string }[]).findIndex((l) => l.id === clipId) + windows.length + 1;
    const layer = { id, type: "shape", shape, adjustment: true, attach: clipId, start: clip?.start ?? 0, end: clip?.end ?? null, x: sw / 2, y: sh / 2, w: side, h: shape === WindowShape.Rect ? Math.round(side * 0.6) : side, soft: Math.round(side * NEW_SOFT), fill: "#ffffff" };
    edits.apply([{ op: OpName.AddLayer, layer }, { op: OpName.Reorder, id, index }], `Adds a ${SHAPE_LABEL[shape].toLowerCase()} window on ${clipId}`, false);
    setTarget(id);
  };

  return (
    <div className="flex flex-col gap-3">
      <Scopes />
      <GradeTools clipId={clipId} allClipIds={allClipIds} edits={edits} />
      <div className="flex flex-wrap items-center gap-1">
        <Chip on={target === clipId} onClick={() => setTarget(clipId)}>
          Clip
        </Chip>
        {windows.map((w, i) => (
          <Chip key={w.id} on={target === w.id} onClick={() => setTarget(w.id)}>
            Window {i + 1}
          </Chip>
        ))}
        <button type="button" onClick={() => addWindow(WindowShape.Ellipse)} className="px-1.5 text-[11px] text-neutral-400 hover:text-white">
          + Circle
        </button>
        <button type="button" onClick={() => addWindow(WindowShape.Rect)} className="px-1.5 text-[11px] text-neutral-400 hover:text-white">
          + Rectangle
        </button>
      </div>
      {current && <WindowControls win={current} edits={edits} />}
      <ColorSection key={target} clipId={target} allClipIds={target === clipId ? allClipIds : []} edits={edits} luts={luts} />
    </div>
  );
}

/** Match this clip to another one, and copy / paste whole grades between clips (⌥⌘C / ⌥⌘V). */
function GradeTools({ clipId, allClipIds, edits }: { clipId: string; allClipIds: string[]; edits: EditActions }) {
  const others = allClipIds.filter((id) => id !== clipId);
  const [source, setSource] = useState(others[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const copied = useEditor((s) => s.gradeClipboard !== null);
  useEffect(() => setNote(null), [clipId]);
  const from = others.includes(source) ? source : (others[0] ?? "");
  const match = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await matchColor(from, [clipId]);
      edits.apply(r.ops, `Matches ${clipId} to ${from}`, false);
      setNote(r.lines.join(" "));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const paste = () => {
    const ops = pasteGradeOps([clipId]);
    if (ops) edits.apply(ops, `Pastes a grade on ${clipId}`, false);
  };
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      {others.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-neutral-400">Match to</span>
          <select value={from} onChange={(e) => setSource(e.target.value)} className="min-w-0 flex-1 rounded-md bg-neutral-800 px-2 py-1 text-neutral-100">
            {others.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={() => void match()} className="rounded-md bg-neutral-800 px-3 py-1 text-neutral-100 hover:bg-neutral-700 disabled:opacity-50">
            {busy ? "Matching…" : "Match"}
          </button>
        </div>
      )}
      <div className="flex items-center gap-3 text-[11px]">
        <button type="button" onClick={() => setNote(copyGrade(clipId) ? `Copied the grade of ${clipId}.` : `${clipId} has no grade to copy.`)} className="text-neutral-400 hover:text-white" title="⌥⌘C">
          Copy grade
        </button>
        <button type="button" disabled={!copied} onClick={paste} className="text-neutral-400 hover:text-white disabled:opacity-40" title="⌥⌘V">
          Paste grade
        </button>
      </div>
      {note && <p className="text-[11px] text-neutral-500">{note}</p>}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-md px-2 py-1 text-[11px] ${on ? "bg-neutral-700 text-white" : "bg-neutral-800/60 text-neutral-400 hover:text-white"}`}>
      {children}
    </button>
  );
}

/** Shape, place, feather, inside/outside and tracking of one window. */
function WindowControls({ win, edits }: { win: WindowLayer; edits: EditActions }) {
  const [sw, sh] = engineHost.sceneSize();
  const [tracking, setTracking] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const keyed = (prop: "x" | "y") => {
    const v = (engineHost.layer(win.id) as Record<string, unknown> | undefined)?.[prop];
    return Array.isArray(v);
  };
  const live = (fields: Record<string, unknown>) => {
    edits.preview([{ op: OpName.Patch, id: win.id, fields }]);
  };
  const slider = (label: string, prop: "x" | "y" | "w" | "h" | "soft", min: number, max: number) => {
    const isKeyed = (prop === "x" || prop === "y") && keyed(prop);
    const value = isKeyed ? (engineHost.sampleProp(win.id, prop, [useEditor.getState().time])[0] ?? win[prop]) : win[prop];
    return (
      <label key={prop} className="flex flex-col gap-1 text-xs text-neutral-400">
        <span className="flex justify-between">
          {label}
          <span className="text-neutral-200 tabular-nums">{isKeyed ? "tracked" : Math.round(value)}</span>
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onPointerDown={() => edits.begin()}
          onChange={(e) => live({ [prop]: Number(e.target.value) })}
          onPointerUp={() => edits.end(`${label} of ${win.id}`, false)}
          className="accent-white"
        />
      </label>
    );
  };
  const track = async () => {
    setTracking(0);
    setNote(null);
    try {
      const r = await trackWindow(win.id, useEditor.getState().time, setTracking);
      edits.apply(r.ops, `Tracks ${win.id}`, false);
      setNote(`Tracked ${r.samples} points, ${r.from.toFixed(1)}–${r.to.toFixed(1)} s${r.lost ? " (lost the detail there; move the window and track again)" : ""}.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setTracking(null);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {Object.values(WindowShape).map((s) => (
          <Chip key={s} on={win.shape === s} onClick={() => edits.apply([{ op: OpName.Patch, id: win.id, fields: { shape: s } }], `${SHAPE_LABEL[s]} window`, false)}>
            {SHAPE_LABEL[s]}
          </Chip>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-neutral-400">
          <input type="checkbox" checked={win.invert} onChange={(e) => edits.apply([{ op: OpName.Patch, id: win.id, fields: { invert: e.target.checked } }], e.target.checked ? "Grades outside the window" : "Grades inside the window", false)} className="accent-white" />
          Outside
        </label>
      </div>
      {slider("Position X", "x", 0, sw)}
      {slider("Position Y", "y", 0, sh)}
      {slider("Width", "w", 20, sw * 1.5)}
      {slider("Height", "h", 20, sh * 1.5)}
      {slider("Softness", "soft", 0, Math.max(sw, sh) / 4)}
      <div className="flex items-center gap-3 text-xs">
        <button type="button" disabled={tracking !== null} onClick={() => void track()} className="rounded-md bg-neutral-800 px-3 py-1.5 text-neutral-100 hover:bg-neutral-700 disabled:opacity-50">
          {tracking !== null ? `Tracking… ${Math.round(tracking * 100)}%` : "Track from the playhead"}
        </button>
        {(keyed("x") || keyed("y")) && (
          <button type="button" onClick={() => edits.apply([{ op: OpName.Patch, id: win.id, fields: { x: win.x, y: win.y } }], `Clears the track of ${win.id}`, false)} className="text-neutral-500 hover:text-white">
            Clear track
          </button>
        )}
        <button type="button" onClick={() => edits.apply([{ op: OpName.RemoveLayer, id: win.id }], `Removes ${win.id}`, false)} className="ml-auto text-neutral-500 hover:text-red-300">
          Delete
        </button>
      </div>
      {note && <p className="text-[11px] text-neutral-500">{note}</p>}
    </div>
  );
}
