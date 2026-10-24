import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { WHEELS_NEUTRAL, type Wheels } from "@motionily/protocol";

type Rgb = [number, number, number];
const WHEELS: { key: keyof Wheels; label: string; reach: number; master: [number, number] }[] = [
  { key: "lift", label: "Lift", reach: 0.25, master: [-0.5, 0.5] },
  { key: "gamma", label: "Gamma", reach: 0.4, master: [0.5, 1.5] },
  { key: "gain", label: "Gain", reach: 0.4, master: [0.5, 1.6] },
  { key: "offset", label: "Offset", reach: 0.2, master: [-0.3, 0.3] },
];
const SIZE = 64;

/** The color a point of the wheel pushes toward (angle = hue, radius = amount), as an rgb delta around 0. */
function push(dx: number, dy: number, reach: number): Rgb {
  const a = Math.atan2(-dy, dx);
  const r = Math.min(1, Math.hypot(dx, dy)) * reach;
  // Three axes 120° apart: red at 0°, green at 120°, blue at 240°; mean-free so it tints without brightening.
  const ch = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((o) => Math.cos(a - o) * r);
  return [ch[0]!, ch[1]!, ch[2]!];
}

/** The wheel point back from a channel triple (inverse of `push` with its master taken out). */
function pointOf(v: Rgb, reach: number): [number, number] {
  const m = (v[0] + v[1] + v[2]) / 3;
  const d = v.map((x) => x - m) as Rgb;
  // Project onto the red axis and the axis 90° after it.
  const x = (d[0] * 2) / 3 + (d[1] * Math.cos((2 * Math.PI) / 3) * 2) / 3 + (d[2] * Math.cos((4 * Math.PI) / 3) * 2) / 3;
  const y = (d[1] * Math.sin((2 * Math.PI) / 3) * 2) / 3 + (d[2] * Math.sin((4 * Math.PI) / 3) * 2) / 3;
  return [x / reach, -y / reach];
}

/**
 * Lift / gamma / gain / offset as a colorist's wheels: drag the dot toward a hue to tint that range,
 * the slider under it moves its level. Double-click a wheel to reset it.
 */
export function ColorWheels({ wheels, onChange, onDone }: { wheels: Wheels; onChange: (w: Wheels) => void; onDone: (what: string) => void }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {WHEELS.map((w) => (
        <Wheel key={w.key} spec={w} value={wheels[w.key]} onChange={(v) => onChange({ ...wheels, [w.key]: v })} onDone={() => onDone(w.label)} onReset={() => (onChange({ ...wheels, [w.key]: [...WHEELS_NEUTRAL[w.key]] as Rgb }), onDone(w.label))} />
      ))}
    </div>
  );
}

function Wheel({ spec, value, onChange, onDone, onReset }: { spec: (typeof WHEELS)[number]; value: Rgb; onChange: (v: Rgb) => void; onDone: () => void; onReset: () => void }) {
  const level = (value[0] + value[1] + value[2]) / 3;
  const [px, py] = pointOf(value, spec.reach);
  const pad = useRef<HTMLDivElement>(null);
  const set = (e: PointerEvent | ReactPointerEvent) => {
    const r = pad.current!.getBoundingClientRect();
    const dx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const dy = ((e.clientY - r.top) / r.height) * 2 - 1;
    const d = push(dx, dy, spec.reach);
    onChange([level + d[0], level + d[1], level + d[2]]);
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        ref={pad}
        onDoubleClick={onReset}
        onPointerDown={(e) => {
          e.preventDefault();
          set(e);
          const move = (ev: PointerEvent) => set(ev);
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            onDone();
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        title={`${spec.label}: drag toward a color, double-click to reset`}
        className="relative cursor-crosshair rounded-full ring-1 ring-white/10"
        style={{ width: SIZE, height: SIZE, background: "conic-gradient(from 90deg, #ff4d4d, #ff4dff, #4d4dff, #4dffff, #4dff4d, #ffff4d, #ff4d4d)", opacity: 0.85 }}
      >
        <span className="absolute inset-[18%] rounded-full bg-neutral-900/70" />
        <span className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-2 ring-black/60" style={{ left: `${50 + Math.max(-1, Math.min(1, px)) * 50}%`, top: `${50 + Math.max(-1, Math.min(1, py)) * 50}%` }} />
      </div>
      <span className="text-[10px] text-neutral-400">{spec.label}</span>
      <input
        type="range"
        min={spec.master[0]}
        max={spec.master[1]}
        step={0.01}
        value={level}
        onChange={(e) => {
          const l = Number(e.target.value);
          onChange(value.map((x) => x - level + l) as Rgb);
        }}
        onPointerUp={onDone}
        className="w-full accent-white"
        aria-label={`${spec.label} level`}
      />
    </div>
  );
}
