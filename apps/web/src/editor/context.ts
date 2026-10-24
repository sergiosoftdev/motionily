import type { RefObject } from "react";
import type { Project, VideoFormat } from "@motionily/protocol";
import type { Generation } from "../components/useGenerate";
import type { CaptionProgress } from "../captions/voiceCaptions";
import type { EditorMode } from "./mode";

/** What both editor modes get from the editor screen: the project, its engine canvas and actions. */
export type EditorProps = {
  id: string;
  project: Project | null;
  error: string | null;
  /** The editor's one engine canvas (each mode's viewer adopts it). */
  canvas: RefObject<HTMLCanvasElement>;
  g: Generation;
  /** The new video's voice being captioned before the agent starts (wizard pipeline). */
  captioning: CaptionProgress | null;
  /** Saves any waiting scene change and returns the saved revision (to tag a rendered file with). */
  flushScene: () => Promise<number>;
  mode: EditorMode;
  setMode: (m: EditorMode) => void;
  rename: (name: string) => void;
  /** New frame shape; `recompose` (default true) asks the agent to lay the graphics out again. */
  changeFormat: (f: VideoFormat, recompose?: boolean) => Promise<void>;
  saveBrief: (brief: string) => void;
  saveReferences: (refs: string[]) => void;
  setProject: (p: Project) => void;
};
