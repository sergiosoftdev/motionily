import { useEffect, useState, type RefObject } from "react";
import { api } from "../api/client";
import { engineHost } from "../engine/host";
import { ActivitySource, logActivity, useEditor } from "../store";

/**
 * Click an object in the preview to select it, then ask the agent about it.
 * The comment travels with the layer id, so the agent reads only that layer.
 */
export function SelectionOverlay({ canvas, projectId }: { canvas: RefObject<HTMLCanvasElement | null>; projectId: string }) {
  const selected = useEditor((s) => s.selectedLayerId);
  const time = useEditor((s) => s.time);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number; rotation: number } | null>(null);
  const [text, setText] = useState("");

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
    if (!t) return;
    await api.addComment(projectId, t, time, selected).catch((e: Error) => logActivity(ActivitySource.System, e.message));
    logActivity(ActivitySource.User, `${selected}: ${t}`);
    setText("");
  };

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
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Pídele algo sobre esto…"
          className="min-w-0 flex-1 bg-transparent px-1 text-xs placeholder:text-neutral-500 focus:outline-none"
        />
      </form>
    </>
  );
}
