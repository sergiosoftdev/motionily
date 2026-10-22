import { useId } from "react";

/** Height of the drawing in its own units (the SVG scales to its box). */
const VIEW_H = 40;
const VIEW_W = 200;

/**
 * An attention curve as a filled sawtooth: the planned energy of a concept's beats or the curve
 * measured from a scene. `values` are 0..1; `at` (optional, same length) places each value in time,
 * otherwise they are evenly spaced. `floor` is the value drawn at the bottom (planned energies never
 * dip under ~35, so 0.3 shows their teeth). `dots` marks every value. `time` draws the playhead.
 */
export function AttentionCurve({
  values,
  at,
  duration,
  time,
  floor = 0,
  dots = false,
  className = "",
  color = "currentColor",
}: {
  values: number[];
  at?: number[];
  duration?: number;
  time?: number;
  floor?: number;
  dots?: boolean;
  className?: string;
  color?: string;
}) {
  const id = useId();
  if (!values.length) return null;
  const end = duration ?? (at?.length ? Math.max(...at) : values.length - 1) ?? 1;
  const x = (i: number) => (values.length === 1 ? VIEW_W / 2 : ((at ? at[i]! : i) / Math.max(end, 1e-6)) * VIEW_W);
  const y = (v: number) => VIEW_H - 3 - Math.max(0, Math.min(1, (v - floor) / (1 - floor))) * (VIEW_H - 6);
  // Straight segments: the teeth of the sawtooth should read as teeth.
  const d = values.map((v, i) => `${i ? "L" : "M"} ${x(i)} ${y(v)}`).join(" ");
  const area = `${d} L ${x(values.length - 1)} ${VIEW_H} L ${x(0)} ${VIEW_H} Z`;
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {/* Zero-length round-capped lines: dots that stay round however the SVG stretches. */}
      {dots && values.map((v, i) => <line key={i} x1={x(i)} x2={x(i)} y1={y(v)} y2={y(v)} stroke={color} strokeWidth="4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
      {time !== undefined && duration ? <line x1={(time / duration) * VIEW_W} x2={(time / duration) * VIEW_W} y1="0" y2={VIEW_H} stroke="#f87171" strokeWidth="1" vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  );
}
