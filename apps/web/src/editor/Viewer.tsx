import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { BuildOverlay } from "../timeline/BuildOverlay";
import { SelectionOverlay } from "../timeline/SelectionOverlay";
import { EngineStatus, useEditor } from "../store";
import { PerfHud } from "./PerfHud";

/** A zoomed view: CSS px per scene px, and the frame center's offset from the stage center. */
export type ViewerZoom = { scale: number; pan: [number, number] };
/** Largest GPU surface a zoomed canvas gets (device px per side, and in total). */
const MAX_SURFACE_SIDE = 8192;
const MAX_SURFACE_PIXELS = 4096 * 4096;

/**
 * The video preview: the editor's one engine canvas, fitted to its frame size, with the build and
 * selection overlays. Both editor modes render it; switching moves the canvas instead of
 * restarting the engine.
 */
export function Viewer({
  canvas,
  error,
  maxWidth = Infinity,
  canvasClass = "",
  zoom = null,
  overlay,
}: {
  canvas: RefObject<HTMLCanvasElement>;
  error: string | null;
  /** Widest the frame gets (wide formats stop at a player-like width). */
  maxWidth?: number;
  canvasClass?: string;
  /** Pro's magnification: CSS px per scene px and the frame's offset (CSS px) from the stage center. Unset = fit. */
  zoom?: ViewerZoom | null;
  /** Replaces the default selection overlay (Pro draws its own gizmos). */
  overlay?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const status = useEditor((s) => s.engineStatus);
  const engineError = useEditor((s) => s.engineError);
  const [sceneW, sceneH] = useEditor((s) => s.sceneSize);

  useLayoutEffect(() => {
    const c = canvas.current;
    stage.current?.prepend(c);
    c.className = canvasClass;
  }, [canvas, canvasClass]);

  // Fit the frame inside the stage keeping its exact aspect ratio (CSS alone stretches it when
  // both width and height are constrained).
  useEffect(() => {
    const el = stage.current;
    const c = canvas.current;
    if (!el) return;
    if (zoom) {
      // Zoomed: the canvas keeps its real size (sharp), capped so the GPU surface stays reasonable;
      // past the cap CSS scales it the rest of the way.
      const place = () => {
        const [dw, dh] = [sceneW * zoom.scale, sceneH * zoom.scale];
        const dpr = window.devicePixelRatio || 1;
        const cap = Math.min(1, MAX_SURFACE_SIDE / (Math.max(dw, dh) * dpr), Math.sqrt(MAX_SURFACE_PIXELS / (dw * dh * dpr * dpr)));
        const [cw, ch] = [Math.max(1, Math.floor(dw * cap)), Math.max(1, Math.floor(dh * cap))];
        Object.assign(c.style, {
          position: "absolute",
          width: `${cw}px`,
          height: `${ch}px`,
          left: `${el.clientWidth / 2 - dw / 2 + zoom.pan[0]}px`,
          top: `${el.clientHeight / 2 - dh / 2 + zoom.pan[1]}px`,
          transformOrigin: "0 0",
          transform: cap < 1 ? `scale(${dw / cw}, ${dh / ch})` : "",
          visibility: "visible",
        });
      };
      place();
      const ro = new ResizeObserver(place);
      ro.observe(el);
      return () => {
        ro.disconnect();
        Object.assign(c.style, { position: "", left: "", top: "", transform: "", transformOrigin: "" });
      };
    }
    const fit = () => {
      const k = Math.min(Math.min(el.clientWidth, maxWidth) / sceneW, el.clientHeight / sceneH);
      c.style.width = `${Math.floor(sceneW * k)}px`;
      c.style.height = `${Math.floor(sceneH * k)}px`;
      c.style.visibility = k > 0 ? "visible" : "hidden";
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvas, sceneW, sceneH, maxWidth, zoom]);

  return (
    <div ref={stage} className={`relative flex min-h-0 w-full flex-1 items-center justify-center ${zoom ? "overflow-hidden" : ""}`}>
      <BuildOverlay canvas={canvas} />
      <PerfHud />
      {overlay ?? <SelectionOverlay canvas={canvas} />}
      {status === EngineStatus.Loading && !error && <p className="absolute text-sm text-neutral-400">Starting the engine…</p>}
      {(error || status === EngineStatus.Failed) && (
        <p className="absolute max-w-sm text-center text-sm text-red-400">{error ?? `The engine could not start: ${engineError}`}</p>
      )}
    </div>
  );
}
