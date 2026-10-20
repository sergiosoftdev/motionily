import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import { stepFrames } from "../transportKeys";

/** AE's Preview panel: first frame, previous frame, play/pause, next frame, last frame, loop. */
export function PreviewControls({ fps }: { fps: number }) {
  const playing = useEditor((s) => s.playing);
  const duration = useEditor((s) => s.duration);
  const btn = "flex size-8 items-center justify-center rounded-sm text-[#c9c9c9] hover:bg-[#2e2e2e] hover:text-white";
  const icon = (d: string) => (
    <svg viewBox="0 0 16 16" className="size-3.5 fill-current" aria-hidden>
      <path d={d} />
    </svg>
  );
  return (
    <div className="flex items-center justify-center gap-1 px-2 py-2">
      <button type="button" className={btn} title="First frame (Home)" onClick={() => (engineHost.pause(), engineHost.seek(0))}>
        {icon("M3 2h2v12H3zM14 2v12L6 8z")}
      </button>
      <button type="button" className={btn} title="Previous frame (Page Up)" onClick={() => stepFrames(-1, fps)}>
        {icon("M4 2h2v12H4zM13 3v10L7 8z")}
      </button>
      <button type="button" className={`${btn} size-9`} title="Play / pause (Space)" onClick={() => (playing ? engineHost.pause() : engineHost.play())}>
        {playing ? icon("M3.5 2h3.5v12H3.5zM9 2h3.5v12H9z") : icon("M4 2v12l10-6z")}
      </button>
      <button type="button" className={btn} title="Next frame (Page Down)" onClick={() => stepFrames(1, fps)}>
        {icon("M10 2h2v12h-2zM3 3v10l6-5z")}
      </button>
      <button type="button" className={btn} title="Last frame (End)" onClick={() => (engineHost.pause(), engineHost.seek(duration))}>
        {icon("M11 2h2v12h-2zM2 2v12l8-6z")}
      </button>
    </div>
  );
}
