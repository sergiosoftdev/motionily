import { useRef, useState } from "react";
import { CURVE_CHANNELS, type CurveChannel, type Curves } from "@motionily/protocol";

const SIZE = 168;
const MAX_POINTS = 6;
const COLOR: Record<CurveChannel, string> = { master: "#e5e5e5", red: "#ff6b6b", green: "#6bdc7a", blue: "#6b9bff" };
const LABEL: Record<CurveChannel, string> = { master: "Master", red: "R", green: "G", blue: "B" };

/** A curve's points, sorted (the identity when it has none). */
const pointsOf = (c: Curves, ch: CurveChannel): [number, number][] => (c[ch]?.length ? [...c[ch]!].sort((a, b) => a[0] - b[0]) : [[0, 0], [1, 1]]);

/**
 * Colorist's curves: click to add a point (up to 6), drag to shape, double-click a point to remove it.
 * Master acts on every channel, then R, G and B on their own.
 */
export function CurvesEditor({ curves, onChange, onDone }: { curves: Curves; onChange: (c: Curves) => void; onDone: (what: string) => void }) {
  const [ch, setCh] = useState<CurveChannel>("master");
  const svg = useRef<SVGSVGElement>(null);
  const pts = pointsOf(curves, ch);
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    const round = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
    return [round((e.clientX - r.left) / r.width), round(1 - (e.clientY - r.top) / r.height)];
  };
  const write = (next: [number, number][]) => onChange({ ...curves, [ch]: next });
  const dragPoint = (index: number, list: [number, number][]) => {
    const move = (ev: PointerEvent) => {
      const p = at(ev);
      const next = list.map((q, i) => (i === index ? p : q));
      write(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onDone(`${LABEL[ch]} curve`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x * SIZE},${(1 - y) * SIZE}`).join(" ");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {CURVE_CHANNELS.map((c) => (
            <button key={c} type="button" onClick={() => setCh(c)} className={`rounded px-1.5 py-0.5 text-[10px] ${ch === c ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-white"}`} style={ch === c ? { color: COLOR[c] } : undefined}>
              {LABEL[c]}
            </button>
          ))}
        </div>
        {curves[ch]?.length ? (
          <button type="button" onClick={() => (onChange({ ...curves, [ch]: [] }), onDone(`${LABEL[ch]} curve reset`))} className="text-[10px] text-neutral-500 hover:text-white">
            Reset
          </button>
        ) : null}
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full cursor-crosshair rounded-md bg-neutral-950 ring-1 ring-white/10"
        onPointerDown={(e) => {
          if ((e.target as Element).tagName === "circle" || pts.length >= MAX_POINTS) return;
          const p = at(e);
          const list = [...pts, p].sort((a, b) => a[0] - b[0]);
          write(list);
          dragPoint(list.indexOf(p), list);
        }}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="#262626" strokeWidth={1}>
            <line x1={g * SIZE} y1={0} x2={g * SIZE} y2={SIZE} />
            <line x1={0} y1={g * SIZE} x2={SIZE} y2={g * SIZE} />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="#3f3f3f" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={COLOR[ch]} strokeWidth={1.6} />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * SIZE}
            cy={(1 - y) * SIZE}
            r={4.5}
            fill={COLOR[ch]}
            stroke="#000"
            onPointerDown={(e) => {
              e.stopPropagation();
              dragPoint(i, pts);
            }}
            onDoubleClick={() => (write(pts.filter((_, j) => j !== i)), onDone(`${LABEL[ch]} curve`))}
            className="cursor-grab"
          />
        ))}
      </svg>
    </div>
  );
}
