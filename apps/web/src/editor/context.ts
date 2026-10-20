import type { RefObject } from "react";
import type { Project, VideoFormat } from "@motionily/protocol";
import type { Generation } from "../components/useGenerate";
import type { EditorMode } from "./mode";

/** What both editor modes get from the editor screen: the project, its engine canvas and actions. */
export type EditorProps = {
  id: string;
  project: Project | null;
  error: string | null;
  /** The editor's one engine canvas (each mode's viewer adopts it). */
  canvas: RefObject<HTMLCanvasElement>;
  g: Generation;
  mode: EditorMode;
  setMode: (m: EditorMode) => void;
  rename: (name: string) => void;
  changeFormat: (f: VideoFormat) => void;
  saveBrief: (brief: string) => void;
  saveReferences: (refs: string[]) => void;
  setProject: (p: Project) => void;
};
