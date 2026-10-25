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
 * Playback keys: Space plays or pauses; with `frames`, also J/K/L (shuttle back, stop, forward;
 * again = faster), Home/End (first/last frame) and Page Up/Down or ⌘←/⌘→ (one frame). Never while typing.
 */
export function useTransportKeys(fps: number, frames: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const { playing, duration } = useEditor.getState();
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === " ") {
        e.preventDefault();
        // Holding Space would toggle on every key repeat.
        if (e.repeat) return;
        // A focused button would also take the Space (on key up) and undo the toggle.
        if ((e.target as HTMLElement | null)?.tagName === "BUTTON") window.addEventListener("keyup", (up) => up.preventDefault(), { once: true, capture: true });
        if (playing) engineHost.pause();
        else engineHost.play();
        return;
      }
      if (!frames) return;
      // J/K/L shuttle: L forward (again = faster), J backwards (again = faster), K stops.
      const k = !meta && !e.altKey ? e.key.toLowerCase() : "";
      if (k === "l" || k === "j" || k === "k") {
        e.preventDefault();
        if (k === "k") return engineHost.pause();
        const r = engineHost.shuttleRate;
        if (k === "l") engineHost.shuttle(r >= 1 ? Math.min(4, r * 2) : 1);
        else engineHost.shuttle(r <= -1 ? Math.max(-4, r * 2) : -1);
        return;
      }
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
