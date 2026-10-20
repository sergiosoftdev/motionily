import { commit, preview } from "../../editing/direct";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import { addKey, isExpr, isKeys, keyAt, keyTimes, removeKey, setAt, setProp, type Anim, type PropDef } from "./keys";
import { ScrubNumber } from "./ScrubNumber";

/** AE's stopwatch: blue when the property is animated. */
function Stopwatch({ on, disabled, onClick }: { on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={on ? "Stop animating (keeps the current value)" : "Animate: adds a keyframe here"}
      className={`flex size-4 shrink-0 items-center justify-center ${on ? "text-[#4aa3f0]" : "text-[#8a8a8a] hover:text-[#c9c9c9]"} disabled:opacity-30`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
        <circle cx="8" cy="9" r="5.5" />
        <path d="M8 9V6M6.5 2h3" strokeLinecap="round" />
        {on && <path d="M8 9 10.5 7" strokeLinecap="round" />}
      </svg>
    </button>
  );
}

/**
 * One Transform property of a layer (Position, Scale…): keyframe navigator, stopwatch, name and
 * blue values. Editing an animated property adds or updates the key at the current time, as in AE.
 */
export function PropRow({ id, layer, def, fps, indent = 0 }: { id: string; layer: Record<string, unknown>; def: PropDef; fps: number; indent?: number }) {
  const time = useEditor((s) => s.time);
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

  const run = (ops: ReturnType<typeof setProp>[], what: string) => {
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

  return (
    <div className="flex h-6 items-center gap-1.5 pr-2" style={{ paddingLeft: indent }}>
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
        disabled={formula}
        onClick={() =>
          run(
            // On: a first key here. Off: every key goes and the value on screen stays.
            def.props.map((p, i) => setProp(id, p, animated ? (values[p] ?? 0) : addKey(anims[i], lt, values[p] ?? 0, fps))),
            animated ? `Stops animating ${name}` : `Animates ${name}`,
          )
        }
      />
      <span className="min-w-0 flex-1 truncate" title={formula ? `Formula: ${anims.filter(isExpr).join(" · ")}` : undefined}>
        {def.label}
        {formula && <span className="ml-1 text-[#e5484d]">ƒ</span>}
      </span>
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
  );
}
