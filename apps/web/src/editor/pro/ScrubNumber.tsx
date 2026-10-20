import { useState, type PointerEvent as ReactPointerEvent } from "react";

/** Pointer travel (px) before a press counts as a drag. */
const DRAG_THRESHOLD = 3;
/** Shift drags 10× faster, Alt 10× finer, as in AE. */
const FAST = 10;
const FINE = 0.1;

/**
 * AE's blue scrubby number: drag sideways to change it, click to type. `onChange(v, done)` fires
 * live while dragging (done = false) and once at the end (done = true).
 */
export function ScrubNumber({
  value,
  onChange,
  step = 1,
  unit = "",
  decimals = 1,
  min = -Infinity,
  max = Infinity,
  disabled = false,
  title,
}: {
  value: number;
  onChange: (v: number, done: boolean) => void;
  step?: number;
  unit?: string;
  decimals?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  title?: string;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = Number.isFinite(value) ? value.toFixed(decimals) : "—";

  const down = (e: ReactPointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let v = value;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      moved = true;
      v = clamp(value + dx * step * (ev.shiftKey ? FAST : ev.altKey ? FINE : 1));
      onChange(+v.toFixed(4), false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      if (moved) onChange(+v.toFixed(4), true);
      else setTyping(shown);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const finish = () => {
    const v = Number((typing ?? "").replace(",", "."));
    setTyping(null);
    if (typing !== null && Number.isFinite(v) && v.toFixed(decimals) !== shown) onChange(clamp(v), true);
  };

  if (typing !== null)
    return (
      <input
        autoFocus
        value={typing}
        onChange={(e) => setTyping(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish();
          if (e.key === "Escape") setTyping(null);
          e.stopPropagation();
        }}
        onBlur={finish}
        className="w-16 rounded-sm bg-[#1b1b1b] px-1 text-[#4aa3f0] tabular-nums ring-1 ring-[#2d8ceb] focus:outline-none"
      />
    );
  return (
    <span
      onPointerDown={down}
      title={title}
      className={`tabular-nums select-none ${disabled ? "text-[#8a8a8a]" : "cursor-ew-resize text-[#4aa3f0] hover:underline"}`}
    >
      {shown}
      {unit}
    </span>
  );
}
