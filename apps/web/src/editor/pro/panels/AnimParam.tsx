import { useEffect, useRef, useState, type MouseEvent } from "react";
import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import { addKey, isExpr, isKeys, keyAt, keyTimes, removeKey, setAt, type Anim } from "../keys";
import { ScrubNumber } from "../ScrubNumber";
import type { ParamDef } from "./effects";
import { sampleAnim } from "./sample";

/** AE's stopwatch: blue when animated, red ƒ-tinted when a formula drives it. Alt-click = expression. */
export function Stopwatch({ on, formula, onClick, onAlt }: { on: boolean; formula?: boolean; onClick: () => void; onAlt: () => void }) {
  const click = (e: MouseEvent) => (e.altKey ? onAlt() : onClick());
  return (
    <button
      type="button"
      onClick={click}
      title={formula ? "Alt-click: remove the expression" : on ? "Stop animating (keeps the current value) · Alt-click: add an expression" : "Animate: adds a keyframe here · Alt-click: add an expression"}
      className={`flex size-4 shrink-0 items-center justify-center ${formula ? "text-[#e5484d]" : on ? "text-[#4aa3f0]" : "text-[#8a8a8a] hover:text-[#c9c9c9]"}`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
        <circle cx="8" cy="9" r="5.5" />
        <path d="M8 9V6M6.5 2h3" strokeLinecap="round" />
        {(on || formula) && <path d="M8 9 10.5 7" strokeLinecap="round" />}
      </svg>
    </button>
  );
}

/** What expressions can use (crates/scene/src/expr.rs), inserted from the ▸ menu. */
const SNIPPETS: [string, string][] = [
  ["wiggle(2, 8)", "Wiggle: freq/s, amount"],
  ["sin(t*2)*40", "Oscillate"],
  ["t*90", "Grow with time (t = layer s)"],
  ["T", "Scene seconds"],
  ["spring(t, 2.2, 7)", "Spring 0→1"],
  ["lerp(0, 1, ease(t/0.6))", "Eased ramp"],
  ["expo_out(min(1, t/0.8))", "Expo-out ramp"],
  ["mod(t, 1.2)", "Loop every 1.2 s"],
  ["noise(t)", "Smooth noise 0..1"],
  ["clamp(x, 0, 1)", "Clamp"],
  ["card.x(T-0.15)", "Another layer, delayed"],
  ["(1+0.2*vol)", "Audio loudness"],
  ["beat", "Audio beat pulse"],
];

/** Every name the formula language knows, for the ? tooltip. */
const HELP =
  "Vars: t (layer s), T (scene s), i/n (repeater copy/count), pi, $param. Funcs: sin cos tan asin acos atan atan2 abs sign floor ceil round fract sqrt pow exp log min max clamp lerp mix smoothstep step mod noise rand wiggle(freq,amp[,seed]) ease ease_in ease_out ease_in_out expo_in expo_out expo_in_out linear back elastic bounce spring(t[,freq,damping]) pulse saw tri. Operators + - * / % ^ < >. Other layers: id.x id.y id.w id.h id.s id.r id.o, or id.x(T-0.2). Audio: vol bass mid high beat beats spec(k).";

/**
 * The formula behind a property, edited in place: ⌘Enter or leaving the field applies it, Esc
 * reverts. The engine checks the formula; its refusal shows under the field.
 */
export function ExpressionEditor({ label, source, result, onApply, indent = 22 }: { label?: string; source: string; result?: number; onApply: (src: string) => string | null; indent?: number }) {
  const [draft, setDraft] = useState(source);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(source), [source]);

  const apply = (src = draft) => {
    const s = src.trim();
    if (!s || s === source) return setError(null);
    setError(onApply(s));
  };
  const insert = (snippet: string) => {
    const el = area.current;
    const [a, b] = el ? [el.selectionStart, el.selectionEnd] : [draft.length, draft.length];
    const next = draft.slice(0, a) + snippet + draft.slice(b);
    setDraft(next);
    apply(next);
  };

  return (
    <div className="flex flex-col gap-1 py-1 pr-2" style={{ paddingLeft: indent }}>
      <div className="flex items-center gap-1.5 text-[10px] text-[#8a8a8a]">
        <span className="text-[#e5484d]">ƒ</span>
        <span className="truncate">Expression{label ? `: ${label}` : ""}</span>
        <select value="" onChange={(e) => e.target.value && insert(e.target.value)} className="w-5 rounded-sm bg-[#1b1b1b] text-[10px] text-[#8a8a8a] focus:outline-none" title="Insert a function" aria-label="Insert a function">
          <option value="">▸</option>
          {SNIPPETS.map(([s, hint]) => (
            <option key={s} value={s}>
              {s} · {hint}
            </option>
          ))}
        </select>
        <span className="cursor-help" title={HELP}>
          ?
        </span>
        {result !== undefined && Number.isFinite(result) && <span className="ml-auto text-[#4aa3f0] tabular-nums">= {result.toFixed(2)}</span>}
      </div>
      <textarea
        ref={area}
        value={draft}
        rows={Math.min(4, Math.max(1, draft.split("\n").length))}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => apply()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            apply();
          } else if (e.key === "Escape") {
            setDraft(source);
            setError(null);
          }
        }}
        className={`resize-y rounded-sm bg-[#141414] px-1.5 py-1 font-mono text-[11px] text-[#e6e6e6] focus:ring-1 focus:outline-none ${error ? "ring-1 ring-[#e5484d]" : "focus:ring-[#2d8ceb]"}`}
      />
      {error && <p className="text-[10px] text-[#ff8a8e]">{error}</p>}
    </div>
  );
}

/** A formula that starts out as the current value, so adding one changes nothing on screen. */
export const exprFrom = (v: number) => String(+v.toFixed(3));

/**
 * One animatable param that lives inside a layer field (an effect's radius…): navigator, stopwatch,
 * scrubber and, for formulas, the expression editor. `onChange` writes the whole new value.
 */
export function AnimParam({
  def,
  value,
  lt,
  fps,
  onChange,
  sampled,
  indent = 22,
}: {
  def: ParamDef;
  value: Anim | undefined;
  lt: number;
  fps: number;
  onChange: (v: Anim, done: boolean) => string | null;
  /** Where the engine can sample a formula (`engineHost.sampleProp`), when it can. */
  sampled?: { id: string; path: string };
  indent?: number;
}) {
  const fallback = typeof def.def === "number" ? def.def : 0;
  const shown = sampleAnim(value, lt, fallback, sampled);
  const current = shown ?? fallback;
  const animated = isKeys(value);
  const formula = isExpr(value);
  const keys = keyTimes([value], fps);
  const here = !!keyAt(value, lt, fps);
  const jump = (dir: -1 | 1) => {
    const k = dir < 0 ? [...keys].reverse().find((k) => k.t < lt - 0.5 / fps) : keys.find((k) => k.t > lt + 0.5 / fps);
    if (!k) return;
    engineHost.pause();
    // The layer starts at (now − lt): its keys are timed from there.
    engineHost.seek(useEditor.getState().time - lt + k.t);
  };
  return (
    <>
      <div className="flex h-6 items-center gap-1.5 pr-2" style={{ paddingLeft: indent }}>
        <span className="flex w-10 shrink-0 items-center justify-between text-[10px] text-[#8a8a8a]">
          {animated && (
            <>
              <button type="button" onClick={() => jump(-1)} className="hover:text-white" aria-label="Previous keyframe">
                ◀
              </button>
              <button
                type="button"
                onClick={() => onChange((here ? removeKey(value, lt, fps) : addKey(value, lt, current, fps)) ?? current, true)}
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
          onClick={() => !formula && onChange(animated ? current : addKey(value, lt, current, fps), true)}
          onAlt={() => onChange(formula ? current : exprFrom(current), true)}
        />
        <span className="min-w-0 flex-1 truncate">
          {def.label}
          {formula && <span className="ml-1 text-[#e5484d]">ƒ</span>}
        </span>
        <ScrubNumber
          value={formula && shown === undefined ? NaN : current}
          step={def.step}
          unit={def.unit}
          decimals={def.decimals}
          min={def.min}
          max={def.max}
          disabled={formula}
          title={formula ? "Driven by a formula" : undefined}
          onChange={(v, done) => onChange(setAt(value, lt, v, fps), done)}
        />
      </div>
      {formula && <ExpressionEditor source={value} result={shown} onApply={(src) => onChange(src, true)} indent={indent + 20} />}
    </>
  );
}
