import { useEffect, useState } from "react";
import type { Output, Track, WorkArea } from "@motionily/protocol";
import type { SfxCue } from "../audio/sfxPlayer";
import type { MusicTrack } from "../audio/music";
import { engineHost } from "../engine/host";

import type { AudioTrack } from "../audio/track";
export type { AudioTrack };
export type SceneLayerView = {
  id: string;
  type: string;
  text?: string;
  group?: string;
  start?: number;
  end?: number | null;
  visible?: boolean;
  blend?: string;
  parent?: string;
  effects?: unknown[];
  z?: unknown;
  rotate_x?: unknown;
  rotate_y?: unknown;
  [field: string]: unknown;
};
/** The parts of the scene JSON the editor panels read. */
export type SceneView = {
  width: number;
  height: number;
  duration: number;
  fps?: number;
  layers: SceneLayerView[];
  captions?: { words: { text: string; start: number; end: number; emphasis?: boolean }[] } | null;
  audio?: AudioTrack | null;
  music?: MusicTrack | null;
  sfx?: SfxCue[];
  sfx_volume?: number;
  output?: Partial<Output> | null;
  tracks?: Track[];
  work_area?: WorkArea;
  markers?: { t: number; label: string; color?: string }[];
};

/** The engine's scene, re-read on every change (agent or user). */
export function useSceneView(): SceneView | null {
  const [scene, setScene] = useState<SceneView | null>(null);
  useEffect(() => {
    const read = () => engineHost.ready && setScene(JSON.parse(engineHost.sceneJson()) as SceneView);
    read();
    const off = engineHost.onSceneChange(read);
    return () => void off();
  }, []);
  return scene;
}

/** Layers in stack order, grouped layers gathered under their group (in the order of its first layer). */
export function groupEntries(layers: SceneLayerView[]): { group?: string; layers: SceneLayerView[] }[] {
  const entries: { group?: string; layers: SceneLayerView[] }[] = [];
  for (const l of layers) {
    if (!l.group) entries.push({ layers: [l] });
    else {
      const e = entries.find((x) => x.group === l.group);
      if (e) e.layers.push(l);
      else entries.push({ group: l.group, layers: [l] });
    }
  }
  return entries;
}

/** Where to land when jumping to something that spans start..end: a bit in, once entrances have played. */
export function landingTime(start: number, end: number) {
  return Math.min(start + 0.6, (start + end) / 2);
}

/** `m:ss.s` for people (Simple mode). */
export function clock(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
