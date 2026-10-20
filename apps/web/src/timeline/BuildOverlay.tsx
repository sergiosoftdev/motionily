import { useEffect, useState, type RefObject } from "react";
import { Phase, readState, type Lane } from "../components/AgentWorkshop";
import { GenerateStatus } from "../components/GeneratePanel";
import { useEditor } from "../store";

/** Rough layouts the "pencil" sketches while the art director plans (x, y, w, h in % of the frame). */
const SKETCHES: { r?: number; box: [number, number, number, number] }[][] = [
  [{ box: [10, 12, 80, 14] }, { box: [10, 32, 55, 6] }, { box: [10, 50, 38, 34] }, { box: [52, 50, 38, 34] }],
  [{ box: [15, 15, 70, 40] }, { r: 1, box: [62, 62, 22, 22] }, { box: [15, 66, 40, 7] }, { box: [15, 77, 28, 7] }],
  [{ box: [8, 40, 84, 18] }, { box: [30, 64, 40, 8] }, { r: 1, box: [42, 14, 16, 16] }],
  [{ box: [12, 14, 34, 72] }, { box: [54, 14, 34, 32] }, { box: [54, 54, 34, 32] }],
];
const SKETCH_MS = 3200;
/** Tool calls a beat usually takes; progress caps below 100% until the builder reports done. */
const TYPICAL_STEPS = 4;

/**
 * Over the preview while the agent team builds: a blueprint while planning (grid, crop marks,
 * rulers measuring the frame, layouts sketched in pencil), then it steps aside so the live build
 * shows, with a construction bar per beat and its stickman; a scanner sweeps during review.
 */
export function BuildOverlay({ canvas }: { canvas: RefObject<HTMLCanvasElement | null> }) {
  const run = useEditor((s) => s.agentRun);
  const [w, h] = useEditor((s) => s.sceneSize);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [sketch, setSketch] = useState(0);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const place = () => setBox({ left: c.offsetLeft, top: c.offsetTop, width: c.clientWidth, height: c.clientHeight });
    place();
    const ro = new ResizeObserver(place);
    ro.observe(c);
    return () => ro.disconnect();
  }, [canvas]);
  useEffect(() => {
    const t = setInterval(() => setSketch((n) => (n + 1) % SKETCHES.length), SKETCH_MS);
    return () => clearInterval(t);
  }, []);

  if (!run || run.status !== GenerateStatus.Running || !box) return null;
  const { phase, lanes, direction } = readState(run);
  if (!phase) return null;
  const duration = Math.max(1, ...lanes.map((l) => l.end));

  return (
    <div className="pointer-events-none absolute overflow-hidden rounded-[inherit]" style={box}>
      {phase === Phase.Plan && <Blueprint w={w} h={h} sketch={sketch} direction={direction} />}
      {phase !== Phase.Plan && (
        <>
          {/* Thin blueprint frame so the live build stays visible. */}
          <div className="absolute inset-0 ring-2 ring-sky-300/40 ring-inset" />
          <CropMarks />
          <BuildBar lanes={lanes} duration={duration} reviewing={phase === Phase.Review} />
          {phase === Phase.Review && (
            <div className="bp-scan absolute top-0 bottom-0 w-[8%]" style={{ background: "linear-gradient(90deg, transparent, rgb(253 230 138 / 0.35), transparent)" }} />
          )}
        </>
      )}
    </div>
  );
}

function Blueprint({ w, h, sketch, direction }: { w: number; h: number; sketch: number; direction: string | null }) {
  return (
    <div className="bp-fade-in absolute inset-0 bg-[#0b1d33]/95">
      <div className="bp-grid absolute inset-0" />
      <CropMarks />
      {/* Rulers measuring the frame. */}
      <div className="absolute top-[5%] right-[6%] left-[6%] flex items-center gap-2">
        <span className="bp-measure h-px flex-1 bg-sky-300/70" />
        <span className="font-mono text-[10px] text-sky-200">{w} px</span>
        <span className="bp-measure h-px flex-1 bg-sky-300/70" style={{ animationDelay: "0.2s" }} />
      </div>
      <div className="absolute top-[8%] bottom-[8%] left-[3%] flex flex-col items-center gap-2">
        <span className="bp-measure-y w-px flex-1 bg-sky-300/70" />
        <span className="font-mono text-[10px] text-sky-200 [writing-mode:vertical-rl]">{h} px</span>
        <span className="bp-measure-y w-px flex-1 bg-sky-300/70" style={{ animationDelay: "0.2s" }} />
      </div>
      {/* Layouts sketched in pencil, one after another. */}
      <svg key={sketch} viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-[8%] h-[84%] w-[84%]">
        {SKETCHES[sketch]!.map((s, i) => {
          const [x, y, bw, bh] = s.box;
          const len = s.r ? Math.PI * bw * 1.1 : 2 * (bw + bh) * 1.1;
          const style = { ["--len" as string]: len, ["--d" as string]: `${i * 0.25}s` };
          return s.r ? (
            <ellipse key={i} cx={x + bw / 2} cy={y + bh / 2} rx={bw / 2} ry={bh / 2} className="bp-draw" style={style} fill="none" stroke="#e0f2fe" strokeWidth="0.5" vectorEffect="non-scaling-stroke" strokeOpacity="0.85" />
          ) : (
            <rect key={i} x={x} y={y} width={bw} height={bh} rx="1.5" className="bp-draw" style={style} fill="none" stroke="#e0f2fe" strokeWidth="0.5" vectorEffect="non-scaling-stroke" strokeOpacity="0.85" />
          );
        })}
      </svg>
      <div className="absolute right-[6%] bottom-[6%] left-[6%] flex items-end gap-3">
        <svg viewBox="0 0 40 32" className="ws-bob h-9 w-11 shrink-0" aria-hidden>
          <circle cx="10" cy="6" r="4.5" fill="#e0f2fe" />
          <path d="M10 11 L10 21 M10 21 L6 30 M10 21 L14 30 M10 13 L17 12" stroke="#e0f2fe" strokeWidth="2.6" strokeLinecap="round" fill="none" />
          <path d="M17 9 L24 6 L24 18 L17 15 Z" fill="#34d399" />
          <g className="ws-shout">
            <path d="M27 8 Q30 12 27 16 M31 6 Q35 12 31 18" stroke="#34d399" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </g>
        </svg>
        <p className="font-mono text-[11px] leading-snug text-sky-100/90">{direction ? `“${direction}”` : "Blueprint: the director sets the art direction and splits up the shots…"}</p>
      </div>
    </div>
  );
}

function CropMarks() {
  const mark = "absolute size-5 border-sky-300/80";
  return (
    <>
      <span className={`${mark} top-2 left-2 border-t-2 border-l-2`} />
      <span className={`${mark} top-2 right-2 border-t-2 border-r-2`} />
      <span className={`${mark} bottom-2 left-2 border-b-2 border-l-2`} />
      <span className={`${mark} right-2 bottom-2 border-r-2 border-b-2`} />
    </>
  );
}

/** One construction segment per beat along the bottom of the frame, with its worker. */
function BuildBar({ lanes, duration, reviewing }: { lanes: Lane[]; duration: number; reviewing: boolean }) {
  return (
    <div className="bp-fade-in absolute right-[3%] bottom-[3%] left-[3%] flex gap-1">
      {lanes.map((l) => {
        const progress = l.done || reviewing ? 1 : Math.min(0.9, (l.tools + 0.5) / TYPICAL_STEPS);
        return (
          <div key={l.group} className="relative flex flex-col gap-1" style={{ flexGrow: Math.max(0.3, l.end - l.start) / duration, flexBasis: 0 }}>
            <span className="truncate rounded bg-black/60 px-1 font-mono text-[9px] text-white/90">{l.group}</span>
            <div className="relative h-2.5 overflow-hidden rounded-sm bg-black/50 ring-1 ring-white/15">
              <div className={`absolute inset-y-0 left-0 transition-[width] duration-700 ${l.done || reviewing ? "bg-emerald-400" : "bp-stripes"}`} style={{ width: `${progress * 100}%` }} />
            </div>
            {!l.done && !reviewing && (
              <svg viewBox="0 0 16 22" className="bp-hop absolute -top-6 h-5 w-4 drop-shadow-[0_0_1.5px_rgba(255,255,255,0.95)]" style={{ left: `calc(${progress * 100}% - 8px)` }} aria-hidden>
                <circle cx="8" cy="4" r="3.4" fill="#111" />
                <path d="M8 8 L8 15 M8 15 L5 21 M8 15 L11 21 M8 10 L13 7" stroke="#111" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            )}
          </div>
        );
      })}
    </div>
  );
}
