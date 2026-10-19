import { useEffect, useState, type RefObject } from "react";
import { api } from "../api/client";
import { engineHost } from "../engine/host";
import { ActivitySource, logActivity, useEditor } from "../store";
import { GenerateEventKind, GenerateStatus, loadPrefs, TOOL_LABEL, type GenerateState } from "../components/GeneratePanel";

const POLL_MS = 1200;

/**
 * Click an object in the preview to select it, then ask the agent about it.
 * The comment travels with the layer id, so the agent reads only that layer.
 */
export function SelectionOverlay({ canvas, projectId }: { canvas: RefObject<HTMLCanvasElement | null>; projectId: string }) {
  const selected = useEditor((s) => s.selectedLayerId);
  const time = useEditor((s) => s.time);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number; rotation: number } | null>(null);
  const [text, setText] = useState("");
  /** Agent run started from this popover, shown live next to the object. */
  const [run, setRun] = useState<GenerateState | null>(null);
  const running = run?.status === GenerateStatus.Running;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void api.generateStatus(projectId).then(setRun, () => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [running, projectId]);

  // Hit-test clicks on the canvas.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onClick = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      const [sw, sh] = engineHost.sceneSize();
      const id = engineHost.pick(((e.clientX - r.left) / r.width) * sw, ((e.clientY - r.top) / r.height) * sh);
      useEditor.setState({ selectedLayerId: id ?? null });
    };
    c.addEventListener("click", onClick);
    return () => c.removeEventListener("click", onClick);
  }, [canvas]);

  // Follow the selected layer as time moves.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !selected) return setBox(null);
    const b = engineHost.layerBounds(selected);
    if (!b) return setBox(null);
    const [sw, sh] = engineHost.sceneSize();
    const kx = c.clientWidth / sw;
    const ky = c.clientHeight / sh;
    const [cx = 0, cy = 0, w = 0, h = 0, rot = 0] = b;
    setBox({ left: c.offsetLeft + (cx - w / 2) * kx, top: c.offsetTop + (cy - h / 2) * ky, width: w * kx, height: h * ky, rotation: rot });
  }, [canvas, selected, time]);

  if (!selected || !box) return null;

  const send = async () => {
    const t = text.trim();
    if (!t || running) return;
    logActivity(ActivitySource.User, `${selected}: ${t}`);
    setText("");
    try {
      // The agent goes straight to this layer instead of re-reading the whole project.
      setRun(
        await api.generate(
          projectId,
          `Only about layer '${selected}' (around ${time.toFixed(1)}s): ${t}. Read it with get_layer ${selected}, change just that layer (or the options it needs), then render_frames at ${time.toFixed(1)}s to check.`,
          loadPrefs(),
        ),
      );
    } catch (e) {
      // Agent busy or unavailable: keep the request as a comment for the next run.
      await api.addComment(projectId, t, time, selected).catch(() => undefined);
      logActivity(ActivitySource.System, e instanceof Error ? e.message : String(e));
    }
  };

  const steps = (run?.events ?? []).filter((e) => e.kind !== GenerateEventKind.Text).slice(-4);
  const thought = [...(run?.events ?? [])].reverse().find((e) => e.kind === GenerateEventKind.Text);

  return (
    <>
      <div
        className="pointer-events-none absolute rounded-sm ring-2 ring-sky-400"
        style={{ ...box, transform: `rotate(${box.rotation}rad)` }}
      />
      <form
        className="absolute z-10 flex w-72 items-center gap-1 rounded-xl bg-neutral-900/95 p-1.5 shadow-xl ring-1 ring-white/10"
        style={{ left: Math.max(8, box.left + box.width / 2 - 144), top: box.top + box.height + 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span className="shrink-0 rounded-md bg-sky-500/20 px-2 py-1 text-[11px] text-sky-200">{selected}</span>
        <input
          autoFocus
          disabled={running}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={running ? "El agente está en ello…" : "Pídele algo sobre esto…"}
          className="min-w-0 flex-1 bg-transparent px-1 text-xs placeholder:text-neutral-500 focus:outline-none"
        />
      </form>
      {run && run.status !== GenerateStatus.Idle && (
        <div
          className="absolute z-10 flex w-64 flex-col gap-1.5 rounded-xl bg-neutral-900/95 p-3 text-xs shadow-xl ring-1 ring-white/10"
          style={{ left: box.left + box.width + 12, top: box.top }}
        >
          <span className="flex items-center gap-2 font-medium">
            {running && <span className="size-2 animate-pulse rounded-full bg-emerald-400" />}
            {running ? "Trabajando en " : "Listo: "}
            <span className="text-sky-300">{selected}</span>
          </span>
          {steps.map((e, i) => (
            <span key={i} className={e.kind === GenerateEventKind.Error ? "text-red-400" : "text-neutral-400"}>
              {TOOL_LABEL[e.text] ?? e.text}
            </span>
          ))}
          {(running ? thought?.text : run.summary) && (
            <span className="line-clamp-4 text-neutral-300">{running ? thought?.text : run.summary}</span>
          )}
          {running ? (
            <button type="button" onClick={() => void api.stopGenerate(projectId).then(setRun)} className="self-start text-neutral-500 hover:text-white">
              Parar
            </button>
          ) : (
            <button type="button" onClick={() => setRun(null)} className="self-start text-neutral-500 hover:text-white">
              Cerrar
            </button>
          )}
        </div>
      )}
    </>
  );
}
