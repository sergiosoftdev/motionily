import { MediaKind, OpName, type MediaItem, type Op, type Project } from "@motionily/protocol";
import { api } from "../../api/client";
import { desktop } from "../../desktop";
import { engineHost } from "../../engine/host";
import { VIDEO_LAYER } from "../../engine/video";
import type { SceneView } from "../sceneView";
import { FOOTAGE_GROUP, editTracks, importTracksOps } from "./tracks";
import { importOps, localPath, matchFiles, tracksUsed, type ImportedClip, type ImportedTimeline, type PoolFile } from "./timelinePlan";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function poolFiles(p: Project, media: MediaItem[]): PoolFile[] {
  return [
    ...p.footage.map((c): PoolFile => ({ name: c.name, url: c.url, kind: "video" })),
    ...media.filter((m) => m.kind !== MediaKind.Lut).map((m): PoolFile => ({ name: m.name, url: m.url, kind: m.kind === MediaKind.Audio ? "audio" : "image" })),
  ];
}

/** A read timeline, the project's files and the clips' files still missing from them. */
export type PendingImport = { t: ImportedTimeline; files: PoolFile[]; missing: ImportedClip[]; failed: string[]; brought: number };

/**
 * Read a timeline file and find its clips' files among the project's; the desktop app brings the missing
 * ones in from where the other editor had them (`file://` URLs, paths). Throws when the file is unreadable.
 */
export async function prepareImport(text: string, project: Project, media: MediaItem[], progress: (label: string | null) => void = () => {}): Promise<PendingImport> {
  const t = engineHost.parseTimeline(text);
  let files = poolFiles(project, media);
  let { missing } = matchFiles(t, files);
  const failed: string[] = [];
  let brought = 0;
  if (missing.length && desktop) {
    for (const [i, c] of missing.entries()) {
      const path = localPath(c.url);
      if (!path) continue;
      progress(`Bringing in ${i + 1} of ${missing.length}…`);
      try {
        await api.importMedia(project.id, path);
        brought++;
      } catch (e) {
        failed.push(`${c.file}: ${message(e)}`);
      }
    }
    progress(null);
    if (brought) {
      const [p, m] = await Promise.all([api.project(project.id), api.projectMedia(project.id)]);
      files = poolFiles(p, m);
      missing = matchFiles(t, files).missing;
    }
  }
  return { t, files, missing, failed, brought };
}

/** The ops that put a prepared timeline after what is on the Edit timeline, and a line saying what happened. */
export function placeImport(p: PendingImport, scene: SceneView, project: Project, media: MediaItem[]): { ops: Op[]; placed: number; text: string } {
  const { t, files } = p;
  const tracks = editTracks(scene, project.footage, media);
  const at = Math.max(0, ...tracks.clips.map((c) => c.end), ...tracks.audio.map((c) => c.end));
  const used = tracksUsed(t);
  const { ops: trackOps, trackOf } = importTracksOps(tracks, used.video, used.audio);
  const plan = importOps(t, matchFiles(t, files).found, {
    at,
    size: engineHost.sceneSize(),
    under: scene.layers.filter((l) => l.type === VIDEO_LAYER || l.group === FOOTAGE_GROUP).length,
    taken: new Set(scene.layers.map((l) => l.id)),
    tracks: trackOf,
  });
  if (!plan.placed) return { ops: [], placed: 0, text: `None of its files are in the project (${p.missing.map((c) => c.file).join(", ")}).` };
  const end = Math.round((at + t.duration) * 1000) / 1000;
  const longer: Op[] = end > scene.duration ? [{ op: OpName.SetDuration, duration: end }] : [];
  const left = [...plan.missing.map((f) => `${f} (missing)`), ...p.failed, ...t.skipped];
  const text = `Placed ${plan.placed} clips of ${t.name}${at > 0 ? ` from ${at.toFixed(2)} s` : ""}.${left.length ? ` Left out: ${left.join(", ")}.` : ""}`;
  return { ops: [...longer, ...trackOps, ...plan.ops], placed: plan.placed, text };
}
