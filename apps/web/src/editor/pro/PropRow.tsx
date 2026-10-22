import type { Op } from "@motionily/protocol";
import { commit, preview } from "../../editing/direct";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import { addKey, isExpr, isKeys, keyAt, keyTimes, removeKey, setAt, setProp, type Anim, type PropDef } from "./keys";
import { ExpressionEditor, exprFrom, Stopwatch } from "./panels/AnimParam";
import { notify } from "./panels/notice";
import { tryOps } from "./panels/scene";
import { focusProp, LeftTab, setLeft, useWorkspace } from "./panels/workspace";
import { ScrubNumber } from "./ScrubNumber";

/**
 * One Transform property of a layer (Position, Scale…): keyframe navigator, stopwatch, name and
 * blue values. Editing an animated property adds or updates the key at the current time, as in AE.
 * Alt-click on the stopwatch adds or removes an expression; `exprInline` shows its editor under
 * the row (Effect Controls), elsewhere the ƒ jumps there.
 */
export function PropRow({ id, layer, def, fps, indent = 0, exprInline = false }: { id: string; layer: Record<string, unknown>; def: PropDef; fps: number; indent?: number; exprInline?: boolean }) {
  const time = useEditor((s) => s.time);
  const focused = useWorkspace((s) => s.prop?.id === id && s.prop.label === def.label);
  const start = (layer.start as number | undefined) ?? 0;
  const lt = time - start;
  const values = engineHost.propValues(id) ?? {};
  const anims = def.props.map((p) => layer[p] as Anim | undefined);
  const animated = anims.some(isKeys);
  const formula = anims.some(isExpr);
  const keys = keyTimes(anims, fps);
  const here = anims.some((a) => keyAt(a, lt, fps));
  const factor = def.factor ?? 1;
  const name = `${def.label} of ${id}`;

  const run = (ops: Op[], what: string) => {
    preview(ops);
    commit(what);
  };
  const jump = (dir: -1 | 1) => {
    const k = dir < 0 ? [...keys].reverse().find((k) => k.t < lt - 0.5 / fps) : keys.find((k) => k.t > lt + 0.5 / fps);
    if (k) {
      engineHost.pause();
      engineHost.seek(start + k.t);
    }
  };
  /** Alt-click: every prop of the row gets a formula (its current value), or loses it. */
  const toggleExpression = () => {
    const ops = def.props.map((p, i) => setProp(id, p, isExpr(anims[i]) ? (values[p] ?? 0) : exprFrom(values[p] ?? 0)));
    const err = tryOps(ops, formula ? `Removes the expression of ${name}` : `Adds an expression to ${name}`);
    if (err) notify(err);
  };
  const select = () => focusProp({ id, props: def.props, label: def.label });

  return (
    <>
      <div className={`flex h-6 items-center gap-1.5 pr-2 ${focused ? "bg-[#2d8ceb]/15" : ""}`} style={{ paddingLeft: indent }}>
        <span className="flex w-10 shrink-0 items-center justify-between text-[10px] text-[#8a8a8a]">
          {animated && (
            <>
              <button type="button" onClick={() => jump(-1)} className="hover:text-white" aria-label="Previous keyframe">
                ◀
              </button>
              <button
                type="button"
                onClick={() =>
                  run(
                    def.props.map((p, i) => setProp(id, p, here ? removeKey(anims[i], lt, fps) : addKey(anims[i], lt, values[p] ?? 0, fps))),
                    `${here ? "Removes" : "Adds"} a ${def.label} key on ${id}`,
                  )
                }
                className={here ? "text-[#4aa3f0]" : "hover:text-white"}
                aria-label={here ? "Remove the keyframe here" : "Add a keyframe here"}
              >
                ◆
              </button>
              <button type="button" onClick={() => jump(1)} className="hover:text-white" aria-label="Next keyframe">
                ▶
              </button>
            </>
          )}
        </span>
        <Stopwatch
          on={animated}
          formula={formula}
          onAlt={toggleExpression}
          onClick={() =>
            !formula &&
            run(
              // On: a first key here. Off: every key goes and the value on screen stays.
              def.props.map((p, i) => setProp(id, p, animated ? (values[p] ?? 0) : addKey(anims[i], lt, values[p] ?? 0, fps))),
              animated ? `Stops animating ${name}` : `Animates ${name}`,
            )
          }
        />
        <button type="button" onClick={select} className="min-w-0 flex-1 truncate text-left" title={formula ? `Formula: ${anims.filter(isExpr).join(" · ")}` : "Select the property (Animation > Add Expression acts on it)"}>
          {def.label}
          {formula && (
            <span
              className="ml-1 text-[#e5484d]"
              onClick={() => {
                if (exprInline) return;
                useEditor.setState({ selectedLayerId: id, selectedGroup: null });
                setLeft(LeftTab.Controls);
              }}
            >
              ƒ
            </span>
          )}
        </button>
        <span className="flex shrink-0 gap-2">
          {def.props.map((p, i) => (
            <ScrubNumber
              key={p}
              value={(values[p] ?? 0) * factor}
              step={def.step}
              unit={def.unit}
              min={def.min}
              max={def.max}
              disabled={isExpr(anims[i])}
              title={isExpr(anims[i]) ? "Driven by a formula" : undefined}
              onChange={(v, done) => {
                const op = setProp(id, p, setAt(anims[i], lt, v / factor, fps));
                if (done) run([op], `${name}: ${v.toFixed(1)}${def.unit ?? ""}`);
                else preview([op]);
              }}
            />
          ))}
        </span>
      </div>
      {exprInline &&
        def.props.map((p, i) => {
          const a = anims[i];
          return isExpr(a) ? (
            <ExpressionEditor
              key={p}
              label={def.props.length > 1 ? p : undefined}
              source={a}
              result={values[p]}
              indent={indent + 40}
              onApply={(src) => tryOps([setProp(id, p, src)], `Expression of ${def.label} (${p}) on ${id}: ${src}`)}
            />
          ) : null;
        })}
    </>
  );
}
