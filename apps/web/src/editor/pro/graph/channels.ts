import { TRANSFORM } from "../keys";

/** How a graphed prop is named, colored and shown (scale and opacity show as %, like their rows). */
export type Channel = { prop: string; label: string; color: string; factor: number; unit: string; min?: number; max?: number };

/** AE's axis colors: X red, Y green, Z blue. */
const AXIS_COLOR: Record<string, string> = { x: "#ef5350", y: "#8bd448", z: "#4f9cf5", w: "#ef5350", h: "#8bd448" };
/** Every other prop takes the next of these, in the order it is graphed. */
const PALETTE = ["#e8c84a", "#c08af5", "#3fcfd0", "#f39a4a", "#f472c0", "#9aa5ff"];
/** Separated dimensions get their own names, as AE's "Separate Dimensions" does. */
const DIM_LABEL: Record<string, string> = { x: "X Position", y: "Y Position", w: "Width", h: "Height" };

export function channelFor(prop: string, index: number): Channel {
  const def = TRANSFORM.find((d) => d.props.includes(prop));
  const factor = def?.factor ?? 1;
  return {
    prop,
    label: DIM_LABEL[prop] ?? def?.label ?? prop,
    color: AXIS_COLOR[prop] ?? PALETTE[index % PALETTE.length]!,
    factor,
    unit: def?.unit ?? "",
    min: def?.min !== undefined ? def.min / factor : undefined,
    max: def?.max !== undefined ? def.max / factor : undefined,
  };
}

/** A number for people: fewer decimals as it grows, no trailing zeros. */
export function fmt(n: number) {
  if (!Number.isFinite(n)) return "∞";
  const a = Math.abs(n);
  const s = a >= 1000 ? n.toFixed(0) : a >= 100 ? n.toFixed(1) : a >= 1 ? n.toFixed(2) : n.toFixed(3);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
