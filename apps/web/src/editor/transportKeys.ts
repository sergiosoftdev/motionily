import { useEffect } from "react";
import { engineHost } from "../engine/host";
import { useEditor } from "../store";

const typing = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

/** Step the playhead by `frames` frames (paused). */
export function stepFrames(frames: number, fps: number) {
  const { time, duration } = useEditor.getState();
  engineHost.pause();
  engineHost.seek(Math.min(duration, Math.max(0, Math.round(time * fps + frames) / fps)));
}

/**
 * AE's playback keys: Space plays or pauses; with `frames`, also Home/End (first/last frame) and
 * Page Up/Down or ⌘←/⌘→ (one frame back/forward). Never while typing.
 */
export function useTransportKeys(fps: number, frames: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const { playing, duration } = useEditor.getState();
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === " ") {
        e.preventDefault();
        // A focused button would also take the Space (on key up) and undo the toggle.
        if ((e.target as HTMLElement | null)?.tagName === "BUTTON") window.addEventListener("keyup", (up) => up.preventDefault(), { once: true, capture: true });
        if (playing) engineHost.pause();
        else engineHost.play();
        return;
      }
      if (!frames) return;
      if (e.key === "Home") (engineHost.pause(), engineHost.seek(0));
      else if (e.key === "End") (engineHost.pause(), engineHost.seek(duration));
      else if (e.key === "PageUp" || (meta && e.key === "ArrowLeft")) stepFrames(-1, fps);
      else if (e.key === "PageDown" || (meta && e.key === "ArrowRight")) stepFrames(1, fps);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fps, frames]);
}
