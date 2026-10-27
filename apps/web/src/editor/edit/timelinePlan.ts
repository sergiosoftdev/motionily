import type { Op, OpName } from "@motionily/protocol";

// Kept free of runtime imports so node's test runner loads it on its own.
const ADD_LAYER: typeof OpName.AddLayer = "add_layer";
const REORDER: typeof OpName.Reorder = "reorder";

/** What the engine reads out of an FCPXML, Final Cut Pro 7 XML or OpenTimelineIO file (`parseTimeline`). */
export type ImportedClip = { name: string; file: string; url: string; kind: "video" | "audio"; track: string; start: number; end: number; trim_in: number };
export type ImportedTimeline = { format: "fcpxml" | "xmeml" | "otio"; name: string; fps: number | null; width: number | null; height: number | null; duration: number; clips: ImportedClip[]; skipped: string[] };

/** A file of the project the clips can use: a clip (video), a sound or a picture. */
export type PoolFile = { name: string; url: string; kind: "video" | "audio" | "image" };

/** Timeline files the picker offers. */
export const TIMELINE_ACCEPT = ".fcpxml,.xml,.otio,.json";

const base = (s: string) => decodeURIComponent(s.split(/[?#]/)[0]!.split(/[\\/]/).pop() ?? s).toLowerCase();

/** Each file the timeline names, found among the project's files by name (or the name in their URL). */
export function matchFiles(t: ImportedTimeline, pool: PoolFile[]): { found: Map<string, PoolFile>; missing: ImportedClip[] } {
  const byName = new Map<string, PoolFile>();
  for (const p of pool) {
    for (const key of [p.name.toLowerCase(), base(p.url)]) if (!byName.has(key)) byName.set(key, p);
  }
  const found = new Map<string, PoolFile>();
  const missing: ImportedClip[] = [];
  for (const c of t.clips) {
    if (found.has(c.file)) continue;
    const hit = byName.get(c.file.toLowerCase());
    if (hit) found.set(c.file, hit);
    else if (!missing.some((m) => m.file === c.file)) missing.push(c);
  }
  return { found, missing };
}

/** The clip's file on this machine (`file://` URLs and absolute paths), for the desktop app to bring in; else null. */
export function localPath(url: string): string | null {
  if (/^file:/i.test(url)) {
    try {
      const path = decodeURIComponent(new URL(url).pathname);
      // file:///C:/clips/a.mp4 → C:/clips/a.mp4
      return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
    } catch {
      return null;
    }
  }
  return url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url) ? url : null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export type ImportPlan = {
  ops: Op[];
  /** Clips placed, and the files not found (their clips stay out). */
  placed: number;
  missing: string[];
};

/**
 * Ops that put the timeline's clips on the Edit timeline from `at` (s): each on the track of the same number
 * (`tracks` maps "V2" → the scene's track id, made beforehand), full frame, at its position and file in;
 * pictures as pictures. Videos stack in track order right under the graphics (`under` = their index).
 */
export function importOps(t: ImportedTimeline, found: Map<string, PoolFile>, opts: { at: number; size: [number, number]; under: number; taken: Set<string>; tracks: (id: string) => string }): ImportPlan {
  const [w, h] = opts.size;
  const ops: Op[] = [];
  const missing = new Set<string>();
  let under = opts.under;
  let placed = 0;
  const id = (prefix: string) => {
    let n = 1;
    while (opts.taken.has(`${prefix}${n}`)) n++;
    opts.taken.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  for (const c of t.clips) {
    const file = found.get(c.file);
    if (!file) {
      missing.add(c.file);
      continue;
    }
    const start = round(opts.at + c.start);
    const end = round(opts.at + c.end);
    const track = opts.tracks(c.kind === "video" && file.kind === "audio" ? "A1" : c.track);
    if (c.kind === "audio" || file.kind === "audio") {
      ops.push({ op: ADD_LAYER, layer: { id: id("snd"), type: "audio", start, end, x: w / 2, y: h / 2, w: 2, h: 2, src: file.url, in: round(c.trim_in), out: round(c.trim_in + c.end - c.start), volume: 1, track } });
    } else {
      const layerId = id(file.kind === "image" ? "pic" : "ft");
      const layer =
        file.kind === "image"
          ? { id: layerId, type: "image", start, end, group: "footage", x: w / 2, y: h / 2, w, h, src: file.url, fit: "cover", track }
          : { id: layerId, type: "video", start, end, group: "footage", x: w / 2, y: h / 2, w, h, src: file.url, fit: "cover", in: round(c.trim_in), out: round(c.trim_in + c.end - c.start), volume: 1, track };
      ops.push({ op: ADD_LAYER, layer }, { op: REORDER, id: layerId, index: under++ });
    }
    placed++;
  }
  return { ops, placed, missing: [...missing] };
}

/** How many video and audio tracks the timeline uses (V3 → 3). */
export function tracksUsed(t: ImportedTimeline): { video: number; audio: number } {
  const n = (kind: "V" | "A") => Math.max(0, ...t.clips.filter((c) => c.track.startsWith(kind)).map((c) => Number(c.track.slice(1)) || 1));
  return { video: n("V"), audio: n("A") };
}
