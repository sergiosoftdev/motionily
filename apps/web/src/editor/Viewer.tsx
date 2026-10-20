import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { BuildOverlay } from "../timeline/BuildOverlay";
import { SelectionOverlay } from "../timeline/SelectionOverlay";
import { EngineStatus, useEditor } from "../store";

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
}: {
  canvas: RefObject<HTMLCanvasElement>;
  error: string | null;
  /** Widest the frame gets (wide formats stop at a player-like width). */
  maxWidth?: number;
  canvasClass?: string;
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
  }, [canvas, sceneW, sceneH, maxWidth]);

  return (
    <div ref={stage} className="relative flex min-h-0 w-full flex-1 items-center justify-center">
      <BuildOverlay canvas={canvas} />
      <SelectionOverlay canvas={canvas} />
      {status === EngineStatus.Loading && !error && <p className="absolute text-sm text-neutral-400">Starting the engine…</p>}
      {(error || status === EngineStatus.Failed) && (
        <p className="absolute max-w-sm text-center text-sm text-red-400">{error ?? `The engine could not start: ${engineError}`}</p>
      )}
    </div>
  );
}
