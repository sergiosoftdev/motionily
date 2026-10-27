import { useEffect } from "react";
import { engineHost } from "../engine/host";
import { useEditor } from "../store";
import { commandFor, isTyping as typing, KeyScope } from "../keys/keymap";
import { openGoToTime } from "../time/TimecodeField";

/** Step the playhead by `frames` frames (paused), playing the sound of that frame. */
export function stepFrames(frames: number, fps: number) {
  const { time, duration } = useEditor.getState();
  engineHost.pause();
  engineHost.scrub(Math.min(duration, Math.max(0, Math.round(time * fps + frames) / fps)));
}

/**
 * Playback keys (the keymap's transport commands): play/pause; with `frames`, also shuttle (J/K/L by
 * default; again = faster), first/last frame and one frame back/forward. Never while typing.
 */
export function useTransportKeys(fps: number, frames: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const { playing, duration } = useEditor.getState();
      const c = commandFor(e, KeyScope.Transport);
      if (c?.id === "transport.go_to_time") {
        e.preventDefault();
        return openGoToTime();
      }
      // Typing digits, + or - over the timeline starts a go-to-time, as in NLEs ("512", "+10").
      if (!c && frames && !e.metaKey && !e.ctrlKey && !e.altKey && /^[0-9+-]$/.test(e.key)) {
        e.preventDefault();
        return openGoToTime(e.key);
      }
      if (!c) return;
      if (c.id === "transport.play_pause") {
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
      const r = engineHost.shuttleRate;
      switch (c.id) {
        // J/K/L shuttle: forward (again = faster), backwards (again = faster), stop.
        case "transport.shuttle_stop":
          engineHost.pause();
          break;
        case "transport.shuttle_forward":
          engineHost.shuttle(r >= 1 ? Math.min(4, r * 2) : 1);
          break;
        case "transport.shuttle_back":
          engineHost.shuttle(r <= -1 ? Math.max(-4, r * 2) : -1);
          break;
        case "transport.go_start":
          engineHost.pause();
          engineHost.seek(0);
          break;
        case "transport.go_end":
          engineHost.pause();
          engineHost.seek(duration);
          break;
        case "transport.prev_frame":
          stepFrames(-1, fps);
          break;
        case "transport.next_frame":
          stepFrames(1, fps);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fps, frames]);
}
