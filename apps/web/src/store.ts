import type { GenerateState } from "./components/GeneratePanel";
import { create } from "zustand";
import type { CaptionStyle, StylePreset } from "@motionily/protocol";

export const ActivitySource = {
  Agent: "agent",
  User: "user",
  /** What the user asked Claude (Edit mode shows these as the conversation). */
  Ask: "ask",
  System: "system",
} as const;
export type ActivitySource = (typeof ActivitySource)[keyof typeof ActivitySource];

/** `images`: what the user attached to an ask (/media/… paths), shown under the message. */
export type Activity = { id: number; source: ActivitySource; text: string; at: Date; images?: string[] };

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
  /** Another tab or window took this video over: this one stopped talking to the agent. */
  openElsewhere: boolean;
  time: number;
  duration: number;
  playing: boolean;
  style: StylePreset | null;
  captionStyle: CaptionStyle | null;
  activity: Activity[];
  /** Scene size in pixels; the preview keeps this aspect ratio. */
  sceneSize: [number, number];
  /** Layer clicked in the preview or the timeline; comments go to it. */
  selectedLayerId: string | null;
  /** Whole group selected (first click on a grouped layer); exclusive with selectedLayerId. */
  selectedGroup: string | null;
  /** Requests are about the moment on screen (picked on the timeline), not the whole video. */
  pinnedMoment: boolean;
  /** Live state of the agent run (shared by the side panel and the canvas overlay). */
  agentRun: GenerateState | null;
};

let nextId = 0;

export const useEditor = create<EditorState>(() => ({
  engineStatus: EngineStatus.Loading,
  engineError: null,
  adapter: "",
  agentConnected: false,
  openElsewhere: false,
  time: 0,
  duration: 0,
  playing: false,
  style: null,
  captionStyle: null,
  activity: [],
  selectedLayerId: null,
  selectedGroup: null,
  pinnedMoment: false,
  agentRun: null,
  sceneSize: [1080, 1920],
}));

/** Entries kept: enough for a session's asks and the agent's steps between them. */
const MAX_ACTIVITY = 200;

export function logActivity(source: ActivitySource, text: string, images: string[] = []) {
  useEditor.setState((s) => ({
    activity: [{ id: nextId++, source, text, at: new Date(), images: images.length ? images : undefined }, ...s.activity].slice(0, MAX_ACTIVITY),
  }));
}
