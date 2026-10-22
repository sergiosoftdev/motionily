import { useState, type ReactNode } from "react";
import { OpName, type Op } from "@motionily/protocol";
import { preview } from "../../../editing/direct";
import { engineHost } from "../../../engine/host";
import { GoogleFontSearch } from "../../../components/style/GoogleFontSearch";
import { useEditor } from "../../../store";
import { landingTime, type SceneLayerView, type SceneView } from "../../sceneView";
import { isExpr, setAt, setProp, type Anim } from "../keys";
import { ScrubNumber } from "../ScrubNumber";
import { instancesOf, renameComponent } from "./actions";
import { ColorField, Line, selectClass } from "./fields";
import { notify } from "./notice";
import { INSTANCE_TYPE, runOps, selectLayer, useSelectedIds, type SceneJson } from "./scene";

const TEXT_TYPE = "text";
const Role = { Heading: "heading", Body: "body" } as const;
const Align = { Left: "left", Center: "center", Right: "right" } as const;
type Align = (typeof Align)[keyof typeof Align];
/** The engine's font when the video has none set (crates/scene/src/text.rs). */
const DEFAULT_FAMILY = "Inter";

const useTextLayers = (scene: SceneView | null) => {
  const ids = useSelectedIds(scene);
  return (scene?.layers ?? []).filter((l) => ids.includes(l.id) && l.type === TEXT_TYPE);
};

/** Patch the same fields on several layers: live while scrubbing, one logged op at the end. */
function patchAll(ids: string[], fields: Record<string, unknown>, done: boolean, what: string) {
  const ops: Op[] = [{ op: OpName.Patch, ids, fields }];
  if (done) runOps(ops, what);
  else preview(ops);
}

const Empty = ({ children }: { children: ReactNode }) => <p className="p-3 text-[#8a8a8a]">{children}</p>;

/** AE's Character panel for the selected text layers. The font family is the whole video's typography. */
export function CharacterPanel({ scene, projectId }: { scene: SceneView | null; projectId: string }) {
  const texts = useTextLayers(scene);
  const [fonts, setFonts] = useState(false);
  const typo = (scene as SceneJson | null)?.typography;
  const family = typo?.family ?? DEFAULT_FAMILY;
  const t = texts[0];
  if (!t) return <Empty>Select a text layer.</Empty>;
  const ids = texts.map((l) => l.id);
  const set = (field: string) => (v: unknown, done: boolean) => patchAll(ids, { [field]: v }, done, `Sets ${field} of ${ids.join(", ")}`);
  const fill = t.fill;

  return (
    <div className="flex flex-col gap-0.5 py-2">
      <Line label="Font">
        <button type="button" onClick={() => setFonts((f) => !f)} className="max-w-40 truncate rounded-sm bg-[#1b1b1b] px-2 py-0.5 text-[#e6e6e6] hover:bg-[#2e2e2e]" style={{ fontFamily: `"${family}"` }} title="The whole video's font (set_typography)">
          {family} ▾
        </button>
      </Line>
      {fonts && (
        <div className="flex h-64 flex-col">
          <GoogleFontSearch
            projectId={projectId}
            current={family}
            onChosen={(brick) => {
              const typography = brick.payload as { family: string };
              if (runOps([{ op: OpName.SetTypography, typography }], `Font: ${typography.family}`)) void engineHost.ensureFonts(typography.family);
              setFonts(false);
            }}
          />
        </div>
      )}
      <Line label="Weight">
        <select value={(t.role as string | undefined) ?? Role.Heading} onChange={(e) => set("role")(e.target.value, true)} className={selectClass}>
          <option value={Role.Heading}>Heading{typo ? ` (${typo.heading})` : ""}</option>
          <option value={Role.Body}>Body{typo ? ` (${typo.body})` : ""}</option>
        </select>
      </Line>
      <Line label="Size">
        <ScrubNumber value={(t.size as number) ?? 0} step={1} decimals={0} unit=" px" min={1} onChange={set("size")} />
      </Line>
      <Line label="Tracking">
        <ScrubNumber value={(t.letter_spacing as number) ?? 0} step={0.5} decimals={1} unit=" px" onChange={set("letter_spacing")} />
      </Line>
      <Line label="Leading">
        <ScrubNumber value={(t.line_height as number) ?? 1.2} step={0.01} decimals={2} unit="×" min={0.5} onChange={set("line_height")} />
      </Line>
      {typeof fill === "string" || fill === undefined ? <ColorField name="Fill Color" value={fill as string | undefined} onChange={set("fill")} /> : <Line label="Fill Color">animated</Line>}
      <ColorField name="Marked words (*word*)" value={typeof t.accent === "string" ? t.accent : undefined} auto="accent" onChange={set("accent")} />
      <p className="px-3 pt-2 text-[10px] text-[#666]">2D text has no stroke or caps option in the engine yet.</p>
    </div>
  );
}

/** Set an x/y/w/h-like prop to `v` at the playhead: a key when animated, the value otherwise. */
function propOp(l: SceneLayerView, prop: string, v: number, fps: number): Op | null {
  const a = l[prop] as Anim | undefined;
  if (isExpr(a)) return null;
  return setProp(l.id, prop, setAt(a, useEditor.getState().time - (l.start ?? 0), v, fps));
}

/** AE's Paragraph panel: alignment and the text box. */
export function ParagraphPanel({ scene }: { scene: SceneView | null }) {
  const texts = useTextLayers(scene);
  const t = texts[0];
  if (!t) return <Empty>Select a text layer.</Empty>;
  const ids = texts.map((l) => l.id);
  const fps = scene?.fps ?? 30;
  const values = engineHost.propValues(t.id) ?? {};
  const align = (t.align as Align | undefined) ?? Align.Center;
  const box = (prop: string) => (v: number, done: boolean) => {
    const ops = texts.map((l) => propOp(l, prop, v, fps)).filter((o): o is Op => !!o);
    if (done) runOps(ops, `Text box ${prop} of ${ids.join(", ")}: ${Math.round(v)}`);
    else preview(ops);
  };
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex gap-1 px-3">
        {Object.values(Align).map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => patchAll(ids, { align: a }, true, `Aligns ${ids.join(", ")} ${a}`)}
            title={`Align text ${a}`}
            className={`flex h-6 w-8 items-center justify-center rounded-sm ${align === a ? "bg-[#3e3e3e] text-white" : "text-[#8a8a8a] hover:text-white"}`}
          >
            <AlignGlyph a={a} />
          </button>
        ))}
      </div>
      <Line label="Box Width">
        <ScrubNumber value={values.w ?? 0} step={1} decimals={0} unit=" px" min={1} onChange={box("w")} />
      </Line>
      <Line label="Box Height">
        <ScrubNumber value={values.h ?? 0} step={1} decimals={0} unit=" px" min={1} onChange={box("h")} />
      </Line>
      <p className="px-3 pt-1 text-[10px] text-[#666]">The type shrinks until it fits the box. No justify mode in the engine yet.</p>
    </div>
  );
}

function AlignGlyph({ a }: { a: Align }) {
  const x = (w: number) => (a === Align.Left ? 2 : a === Align.Right ? 14 - w : 8 - w / 2);
  return (
    <svg viewBox="0 0 16 12" className="h-3 w-4" fill="currentColor" aria-hidden>
      {[12, 8, 11, 6].map((w, i) => (
        <rect key={i} x={x(w)} y={i * 3} width={w} height={1.6} />
      ))}
    </svg>
  );
}

const AlignTo = { Selection: "selection", Composition: "composition" } as const;
type AlignTo = (typeof AlignTo)[keyof typeof AlignTo];
const Edge = { Left: "left", HCenter: "hcenter", Right: "right", Top: "top", VCenter: "vcenter", Bottom: "bottom" } as const;
type Edge = (typeof Edge)[keyof typeof Edge];
const EDGES: [Edge, string][] = [
  [Edge.Left, "Left"],
  [Edge.HCenter, "Horizontal Center"],
  [Edge.Right, "Right"],
  [Edge.Top, "Top"],
  [Edge.VCenter, "Vertical Center"],
  [Edge.Bottom, "Bottom"],
];
const horizontal = (e: Edge) => e === Edge.Left || e === Edge.HCenter || e === Edge.Right;

type Box = { id: string; x0: number; y0: number; x1: number; y1: number };

/** Screen box of a layer now (rotated boxes count by their bounding box). */
function boxOf(id: string): Box | null {
  const b = engineHost.layerBounds(id);
  if (!b) return null;
  const [cx = 0, cy = 0, w = 0, h = 0, r = 0] = b;
  const a = (r * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
  const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  return { id, x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 };
}

const edgeOf = (b: Box, e: Edge) =>
  e === Edge.Left ? b.x0 : e === Edge.Right ? b.x1 : e === Edge.HCenter ? (b.x0 + b.x1) / 2 : e === Edge.Top ? b.y0 : e === Edge.Bottom ? b.y1 : (b.y0 + b.y1) / 2;

/** AE's Align panel: line the selected layers up with the selection or the comp, or space them evenly. */
export function AlignPanel({ scene }: { scene: SceneView | null }) {
  const ids = useSelectedIds(scene);
  const [to, setTo] = useState<AlignTo>(AlignTo.Selection);
  const fps = scene?.fps ?? 30;
  const target = to === AlignTo.Composition || ids.length < 2 ? AlignTo.Composition : AlignTo.Selection;

  /** Moves each box by its delta, through x/y at the playhead (keys stay keys). */
  const move = (deltas: [string, number, number][], what: string) => {
    const layers = scene?.layers ?? [];
    const ops: Op[] = [];
    const skipped: string[] = [];
    for (const [id, dx, dy] of deltas) {
      const l = layers.find((x) => x.id === id);
      const v = engineHost.propValues(id);
      if (!l || !v) continue;
      for (const [prop, d] of [["x", dx] as const, ["y", dy] as const]) {
        if (Math.abs(d) < 0.01) continue;
        const op = propOp(l, prop, (v[prop] ?? 0) + d, fps);
        if (op) ops.push(op);
        else skipped.push(id);
      }
    }
    if (skipped.length) notify(`${[...new Set(skipped)].join(", ")}: driven by an expression, left in place.`);
    if (ops.length) runOps(ops, what);
  };

  const align = (e: Edge) => {
    const boxes = ids.map(boxOf).filter((b): b is Box => !!b);
    if (!boxes.length) return notify("Select the layers to align.");
    const [W, H] = useEditor.getState().sceneSize;
    const ref: Box =
      target === AlignTo.Composition
        ? { id: "", x0: 0, y0: 0, x1: W, y1: H }
        : { id: "", x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) };
    const goal = edgeOf(ref, e);
    move(
      boxes.map((b) => [b.id, horizontal(e) ? goal - edgeOf(b, e) : 0, horizontal(e) ? 0 : goal - edgeOf(b, e)]),
      `Aligns ${ids.join(", ")} ${e} to the ${target}`,
    );
  };

  const distribute = (e: Edge) => {
    const boxes = ids
      .map(boxOf)
      .filter((b): b is Box => !!b)
      .sort((a, b) => edgeOf(a, e) - edgeOf(b, e));
    if (boxes.length < 3) return notify("Select three or more layers to distribute.");
    const first = edgeOf(boxes[0]!, e);
    const step = (edgeOf(boxes[boxes.length - 1]!, e) - first) / (boxes.length - 1);
    move(
      boxes.map((b, i) => {
        const d = first + step * i - edgeOf(b, e);
        return [b.id, horizontal(e) ? d : 0, horizontal(e) ? 0 : d];
      }),
      `Distributes ${ids.join(", ")} by ${e}`,
    );
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      <label className="flex items-center gap-2">
        <span className="text-[#8a8a8a]">Align Layers to:</span>
        <select value={to} onChange={(e) => setTo(e.target.value as AlignTo)} className={selectClass}>
          <option value={AlignTo.Selection}>Selection</option>
          <option value={AlignTo.Composition}>Composition</option>
        </select>
      </label>
      <div className="flex gap-1">
        {EDGES.map(([e, label]) => (
          <button key={e} type="button" disabled={!ids.length} onClick={() => align(e)} title={`Align ${label}`} aria-label={`Align ${label}`} className="flex size-7 items-center justify-center rounded-sm text-[#b5b5b5] hover:bg-[#2e2e2e] hover:text-white disabled:opacity-30">
            <EdgeGlyph e={e} />
          </button>
        ))}
      </div>
      <span className="text-[#8a8a8a]">Distribute Layers:</span>
      <div className="flex gap-1">
        {EDGES.map(([e, label]) => (
          <button key={e} type="button" disabled={ids.length < 3} onClick={() => distribute(e)} title={`Distribute ${label}`} aria-label={`Distribute ${label}`} className="flex size-7 items-center justify-center rounded-sm text-[#b5b5b5] hover:bg-[#2e2e2e] hover:text-white disabled:opacity-30">
            <EdgeGlyph e={e} spread />
          </button>
        ))}
      </div>
      {ids.length < 2 && <p className="text-[10px] text-[#666]">One layer aligns to the composition. Shift-click layers in the timeline to align them together.</p>}
    </div>
  );
}

/** A guide line (the edge) and boxes sitting on it. */
function EdgeGlyph({ e, spread = false }: { e: Edge; spread?: boolean }) {
  const h = horizontal(e);
  const at = e === Edge.Left || e === Edge.Top ? 2 : e === Edge.Right || e === Edge.Bottom ? 14 : 8;
  const boxes = spread ? [3, 8, 13] : [5, 11];
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      {h ? <line x1={at} y1={1} x2={at} y2={15} stroke="#4aa3f0" strokeWidth={1.2} /> : <line x1={1} y1={at} x2={15} y2={at} stroke="#4aa3f0" strokeWidth={1.2} />}
      {boxes.map((p, i) => {
        const len = spread ? 4 : i ? 6 : 10;
        const s = at === 2 ? 2 : at === 14 ? 14 - len : 8 - len / 2;
        return h ? <rect key={i} x={s} y={p - 1.5} width={len} height={3} fill="currentColor" /> : <rect key={i} x={p - 1.5} y={s} width={3} height={len} fill="currentColor" />;
      })}
    </svg>
  );
}

/** Project panel: the video's components (precomps). Click selects an instance, double-click renames. */
export function ComponentsList({ scene }: { scene: SceneView | null }) {
  const [editing, setEditing] = useState<string | null>(null);
  const comps = Object.entries((scene as SceneJson | null)?.library?.components ?? {});
  const open = (name: string) => {
    const id = instancesOf(name)[0];
    if (!id) return notify(`${name} has no instance in the video.`);
    selectLayer(id);
    const l = scene?.layers.find((x) => x.id === id);
    const t = useEditor.getState().time;
    if (l && scene && (t < (l.start ?? 0) || t >= (l.end ?? scene.duration))) engineHost.seek(landingTime(l.start ?? 0, l.end ?? scene.duration));
  };
  return (
    <div className="flex flex-col">
      <span className="pb-1 text-[11px] text-[#8a8a8a]">Compositions</span>
      {!comps.length && <p className="text-[11px] text-[#666]">None yet: Layer &gt; Pre-compose turns layers into one.</p>}
      {comps.map(([name, def]) => {
        const uses = (scene?.layers ?? []).filter((l) => l.type === INSTANCE_TYPE && l.comp === name).length;
        return editing === name ? (
          <input
            key={name}
            autoFocus
            defaultValue={name}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(null);
            }}
            onBlur={(e) => {
              setEditing(null);
              if (e.target.value.trim() && e.target.value !== name) renameComponent(name, e.target.value);
            }}
            className="rounded-sm bg-[#1b1b1b] px-1.5 py-0.5 text-[#e6e6e6] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
          />
        ) : (
          <button key={name} type="button" onClick={() => open(name)} onDoubleClick={() => setEditing(name)} title="Click: select its instance · double-click: rename" className="flex h-6 items-center gap-2 rounded-sm px-1 text-left hover:bg-[#2a2a2a]">
            <span className="text-[#a89677]">⧉</span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="text-[11px] text-[#8a8a8a]">
              {def.layers.length} layers · {uses} use{uses === 1 ? "" : "s"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
