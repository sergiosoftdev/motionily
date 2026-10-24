import { useEffect, useRef, useState } from "react";
import { engineHost } from "../../engine/host";
import { OpName, WHEELS_NEUTRAL, effectsWithGrade, type Curves, type Wheels } from "@motionily/protocol";
import { GRADE_FIELDS, GRADE_GROUPS, GRADE_PRESETS, gradeOps, presetGrade, readGrade, type Grade, type GradeField } from "./colorGrade";
import { ColorWheels } from "./ColorWheels";
import { CurvesEditor } from "./CurvesEditor";
import type { EditActions } from "./useEditActions";

/**
 * Color grading of a clip, as in a grading panel: looks to start from, then light, color and vignette
 * sliders. It writes the clip's color effect, the same one the agent edits, so either can refine it.
 */
export function ColorSection({ clipId, allClipIds, edits }: { clipId: string; allClipIds: string[]; edits: EditActions }) {
  const [{ grade, animated }, setState] = useState(() => readGrade(engineHost.layer(clipId)));
  const dragging = useRef(false);
  // Wheels and curves are read from the layer, so a gesture re-renders to show where it is.
  const [, redraw] = useState(0);

  useEffect(() => setState(readGrade(engineHost.layer(clipId))), [clipId]);
  const colorFx = () => ((engineHost.layer(clipId)?.effects as Record<string, unknown>[] | undefined) ?? []).find((e) => e.fx === "color") ?? {};
  const fx = colorFx();
  const wheels: Wheels = {
    lift: (fx.lift as Wheels["lift"]) ?? [...WHEELS_NEUTRAL.lift],
    gamma: (fx.gamma as Wheels["gamma"]) ?? [...WHEELS_NEUTRAL.gamma],
    gain: (fx.gain as Wheels["gain"]) ?? [...WHEELS_NEUTRAL.gain],
    offset: (fx.offset as Wheels["offset"]) ?? [...WHEELS_NEUTRAL.offset],
  };
  const curves = (fx.curves as Curves | undefined) ?? {};
  /** Wheels or curves changed live (one undo step per gesture). */
  const extra = (x: { wheels?: Wheels; curves?: Curves }) => {
    if (!dragging.current) edits.begin();
    dragging.current = true;
    edits.preview([{ op: OpName.Patch, id: clipId, fields: { effects: effectsWithGrade(engineHost.layer(clipId)?.effects as unknown[] | undefined, grade, x) } }]);
    redraw((n) => n + 1);
  };
  const extraDone = (what: string) => {
    if (!dragging.current) return;
    dragging.current = false;
    edits.end(`${what} of ${clipId}`, false);
  };

  const ops = (ids: string[], g: Grade) => gradeOps(ids.map((id) => ({ id, layer: engineHost.layer(id) })), g);
  const set = (field: GradeField, v: number) => {
    if (!dragging.current) edits.begin();
    dragging.current = true;
    const next = { ...grade, [field]: v };
    setState({ grade: next, animated: false });
    edits.preview(ops([clipId], next));
  };
  const done = (field: GradeField) => {
    if (!dragging.current) return;
    dragging.current = false;
    edits.end(`${GRADE_FIELDS[field].label} of ${clipId}`, false);
  };
  const look = (name: string, g: Grade) => {
    setState({ grade: g, animated: false });
    edits.apply(ops([clipId], g), `Look "${name}" on ${clipId}`, false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-300">Color</span>
        {allClipIds.length > 1 && (
          <button type="button" onClick={() => edits.apply(ops(allClipIds, grade), `Same grade on all ${allClipIds.length} clips`, false)} className="text-[11px] text-neutral-400 hover:text-white">
            Apply to all clips
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {GRADE_PRESETS.map((p) => (
          <button key={p.name} type="button" onClick={() => look(p.name, presetGrade(p.grade))} className="rounded-md bg-neutral-800/70 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 hover:text-white">
            {p.name}
          </button>
        ))}
      </div>
      {animated && <p className="text-[11px] text-amber-400/80">Part of this grade is animated; moving a slider sets it to one value.</p>}
      {GRADE_GROUPS.map((g) => (
        <div key={g.title} className="flex flex-col gap-2">
          <span className="text-[11px] text-neutral-500">{g.title}</span>
          {g.fields.map((f) => {
            const spec = GRADE_FIELDS[f];
            return (
              <label key={f} className="flex flex-col gap-1 text-xs text-neutral-400">
                <span className="flex justify-between">
                  {spec.label}
                  <button type="button" onDoubleClick={() => look(`reset ${spec.label}`, { ...grade, [f]: spec.neutral })} title="Double-click to reset" className="text-neutral-200 tabular-nums">
                    {spec.format(grade[f])}
                  </button>
                </span>
                <input
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={grade[f]}
                  onChange={(e) => set(f, Number(e.target.value))}
                  onPointerUp={() => done(f)}
                  onKeyUp={() => done(f)}
                  onDoubleClick={() => look(`reset ${spec.label}`, { ...grade, [f]: spec.neutral })}
                  className="accent-white"
                />
              </label>
            );
          })}
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <span className="text-[11px] text-neutral-500">Wheels</span>
        <ColorWheels wheels={wheels} onChange={(w) => extra({ wheels: w })} onDone={extraDone} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[11px] text-neutral-500">Curves</span>
        <CurvesEditor curves={curves} onChange={(c) => extra({ curves: c })} onDone={extraDone} />
      </div>
    </div>
  );
}
