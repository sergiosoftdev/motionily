import { useEffect } from "react";
import { api } from "../api/client";
import { engineHost } from "../engine/host";
import { useEditor } from "../store";

/** How often (ms) the editor checks whether the video's card still is out of date. */
const CHECK_MS = 20_000;
/** A change this recent (ms) may be one of several: the still waits for the edit to settle. */
const SETTLE_MS = 4_000;
const WIDTH = 480;

/** The second the card shows: early, where the hook is, but past a fade in. */
const coverTime = (duration: number) => Math.min(duration * 0.25, 2);

/**
 * Keeps the video's card still (Projects, a project's videos) in step with the video: one is made when
 * the video has none, and again once an edit settles. Skipped while playing or in a hidden tab.
 */
export function useCover(projectId: string, hasCover: boolean | null) {
  useEffect(() => {
    // The project is still loading.
    if (hasCover === null) return;
    let sent = hasCover ? -2 : -1;
    let seen = -1;
    let changedAt = 0;
    let busy = false;
    const check = async () => {
      if (busy || !engineHost.ready || document.hidden || useEditor.getState().playing) return;
      const rev = engineHost.revision;
      // An existing still stays until the video first changes here.
      if (sent === -2) sent = rev;
      // The scene as it loaded counts as settled; an edit here waits a moment.
      if (rev !== seen) [seen, changedAt] = [rev, seen === -1 ? 0 : Date.now()];
      if (rev === sent || Date.now() - changedAt < SETTLE_MS) return;
      busy = true;
      try {
        const [shot] = await engineHost.snapshots([coverTime(engineHost.duration())], WIDTH);
        if (shot) await api.setCover(projectId, await (await fetch(shot)).blob());
        sent = rev;
      } catch {
        // Next check tries again.
      } finally {
        busy = false;
      }
    };
    const first = window.setTimeout(() => void check(), SETTLE_MS + 1000);
    const timer = window.setInterval(() => void check(), CHECK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      void check();
    };
  }, [projectId, hasCover]);
}
