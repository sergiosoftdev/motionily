import { useRef, useState } from "react";
import { OpName, type FootageClip, type Op } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import { agentBridge } from "../../bridge";
import { ActivitySource, logActivity } from "../../store";
import type { SceneView } from "../sceneView";
import { cutLength, editTracks, footageCaptions } from "./tracks";

/** Undo steps kept (each is a whole scene, so keep it bounded). */
const HISTORY = 60;

export type EditActions = {
  /** Remember the scene before an edit (a drag calls it once, on its first move). */
  begin: () => void;
  /** Show an edit live while dragging. */
  preview: (ops: Op[]) => void;
  /** Finish an edit: captions follow the clips when asked, then autosave and the agent catch up. */
  end: (what: string, recaption: boolean) => void;
  /** A one-shot edit (button, key). */
  apply: (ops: Op[], what: string, recaption: boolean) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

/**
 * Hand edits of the Edit view, with undo. In a video cut from the user's footage, every clip edit also
 * rebuilds the captions from the clips' transcripts (so @word timing and captions follow the cut) and
 * sets the length to the end of the last clip.
 */
export function useEditActions(footage: FootageClip[]): EditActions {
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const [, redraw] = useState(0);

  const recaption = () => {
    if (!footage.length) return;
    const { clips } = editTracks(JSON.parse(engineHost.sceneJson()) as SceneView, footage);
    if (!clips.length) return;
    engineHost.applyOps([
      { op: OpName.SetCaptions, captions: { words: footageCaptions(clips) } },
      { op: OpName.SetDuration, duration: cutLength(clips) },
    ]);
  };
  const finish = (what: string, withCaptions: boolean) => {
    if (withCaptions) recaption();
    agentBridge.sceneChanged();
    logActivity(ActivitySource.User, what);
    redraw((n) => n + 1);
  };
  const begin = () => {
    past.current = [...past.current.slice(-(HISTORY - 1)), engineHost.sceneJson()];
    future.current = [];
  };
  const restore = (from: string[], to: string[], what: string) => {
    const json = from.pop();
    if (!json) return;
    to.push(engineHost.sceneJson());
    engineHost.loadScene(json);
    agentBridge.sceneChanged();
    logActivity(ActivitySource.User, what);
    redraw((n) => n + 1);
  };

  return {
    begin,
    preview: (ops) => {
      try {
        engineHost.applyOps(ops);
      } catch {
        // A transient invalid state mid-drag: the next move fixes it.
      }
    },
    end: finish,
    apply: (ops, what, withCaptions) => {
      begin();
      try {
        engineHost.applyOps(ops);
      } catch (e) {
        past.current.pop();
        logActivity(ActivitySource.System, `${what} failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      finish(what, withCaptions);
    },
    undo: () => restore(past.current, future.current, "Undo"),
    redo: () => restore(future.current, past.current, "Redo"),
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
