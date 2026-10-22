import { create } from "zustand";

/** One keyframe picked in the timeline: a property row of a layer at local time `t` (relative to the layer start). */
export type KeyRef = { id: string; props: string[]; t: number };

type TimelineSelection = {
  /**
   * Layers picked in the timeline (Shift/⌘-click, ⌘A). Only valid while it contains the editor's
   * selected layer: clicking another layer on the canvas collapses it back to that one.
   */
  layers: string[];
  /** Keyframes picked (click, Shift-click, marquee): Delete, copy, easy ease and drags act on them. */
  keys: KeyRef[];
  /** Index of the composition marker picked on the ruler (Delete removes it). */
  marker: number | null;
};

/** Timeline-only selection, beside the store's single `selectedLayerId` (which drives Effect Controls). */
export const useTimelineSelection = create<TimelineSelection>(() => ({ layers: [], keys: [], marker: null }));

/** Two key times within half a frame are the same key. */
export const sameTime = (a: number, b: number, fps: number) => Math.abs(a - b) < 0.5 / fps;

export const sameKey = (a: KeyRef, b: KeyRef, fps: number) => a.id === b.id && a.props[0] === b.props[0] && sameTime(a.t, b.t, fps);

export function setKeySelection(keys: KeyRef[]) {
  useTimelineSelection.setState({ keys, marker: null });
}

export function clearTimelinePicks() {
  useTimelineSelection.setState({ keys: [], marker: null });
}
