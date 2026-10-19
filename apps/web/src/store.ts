import { create } from "zustand";
import type { CaptionStyle, StylePreset } from "@motionily/protocol";

export const ActivitySource = {
  Agent: "agent",
  User: "user",
  System: "system",
} as const;
export type ActivitySource = (typeof ActivitySource)[keyof typeof ActivitySource];

export type Activity = { id: number; source: ActivitySource; text: string; at: Date };

export const EngineStatus = {
  Loading: "loading",
  Ready: "ready",
  Failed: "failed",
} as const;
export type EngineStatus = (typeof EngineStatus)[keyof typeof EngineStatus];

type EditorState = {
  engineStatus: EngineStatus;
  engineError: string | null;
  adapter: string;
  agentConnected: boolean;
  time: number;
  duration: number;
  playing: boolean;
  style: StylePreset | null;
  captionStyle: CaptionStyle | null;
  activity: Activity[];
  /** Layer clicked in the preview or the timeline; comments go to it. */
  selectedLayerId: string | null;
};

let nextId = 0;

export const useEditor = create<EditorState>(() => ({
  engineStatus: EngineStatus.Loading,
  engineError: null,
  adapter: "",
  agentConnected: false,
  time: 0,
  duration: 0,
  playing: false,
  style: null,
  captionStyle: null,
  activity: [],
  selectedLayerId: null,
}));

export function logActivity(source: ActivitySource, text: string) {
  useEditor.setState((s) => ({
    activity: [{ id: nextId++, source, text, at: new Date() }, ...s.activity].slice(0, 50),
  }));
}
