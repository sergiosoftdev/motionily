import { OpName, type Op } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import type { SceneView } from "../sceneView";
import type { EditSelection } from "./EditTimeline";
import { ClipKind, clipLocked, freshId, rippleDeleteOps, splitClipOps, type EditClip, type EditTracks } from "./tracks";
import type { EditActions } from "./useEditActions";

/** Split, delete and their friends, shared by keys, toolbar and inspector. */
export function useEditOps(scene: SceneView | null, tracks: EditTracks | null, edits: EditActions) {
  /** Split the given clip at the playhead, or the main-track clip under it. */
  const split = (clip: EditClip | null) => {
    if (!scene || !tracks) return;
    const t = useEditor.getState().time;
    const c = clip && t > clip.start && t < clip.end ? clip : tracks.clips.find((x) => x.lane === 0 && t > x.start && t < x.end);
    const layer = c && engineHost.layer(c.id);
    if (!c || !layer || clipLocked(tracks, c)) return;
    const id = freshId(c.id, new Set(scene.layers.map((l) => l.id)));
    const o = splitClipOps(c, t, layer, id, scene.layers.findIndex((l) => l.id === c.id));
    if (o) edits.apply(o, `Splits ${c.id} at ${t.toFixed(2)} s`, true);
  };
  const remove = (sel: NonNullable<EditSelection>) => {
    if (!scene) return;
    if (sel.kind === "clip") {
      const c = sel.clip;
      // A locked track keeps its clips.
      if (tracks && clipLocked(tracks, c)) return;
      // The main video track closes its gap; an overlay or a sound just goes.
      const ripple = c.lane === 0 && c.kind !== ClipKind.Audio;
      const o = ripple ? rippleDeleteOps(c, scene) : [{ op: OpName.RemoveLayer, id: c.id }];
      edits.apply(o, ripple ? `Deletes ${c.id} and closes the gap` : `Deletes ${c.id}`, true);
    } else if (sel.kind === "block") {
      const b = sel.block;
      edits.apply(b.group ? [{ op: OpName.RemoveGroup, group: b.group }] : b.ids.map((id) => ({ op: OpName.RemoveLayer, id })), `Deletes ${b.label}`, false);
    } else if (sel.kind === "cue") edits.apply([{ op: OpName.RemoveSfx, id: sel.cue.id }], `Deletes the ${sel.cue.sound} effect`, false);
    else if (sel.kind === "many") {
      // Several pieces at once: clips go without closing gaps (one ripple per clip would shift the others).
      const o: Op[] = [
        ...sel.clips.map((c): Op => ({ op: OpName.RemoveLayer, id: c.id })),
        ...sel.blocks.flatMap((b): Op[] => (b.group ? [{ op: OpName.RemoveGroup, group: b.group }] : b.ids.map((id) => ({ op: OpName.RemoveLayer, id })))),
        ...sel.cues.map((c): Op => ({ op: OpName.RemoveSfx, id: c.id })),
      ];
      edits.apply(o, `Deletes ${sel.clips.length + sel.blocks.length + sel.cues.length} pieces`, sel.clips.length > 0);
    } else edits.apply([{ op: OpName.SetMusic, music: null }], "Removes the music", false);
    useEditor.setState({ selectedLayerId: null, selectedGroup: null });
  };
  return { split, remove };
}

export type EditOps = ReturnType<typeof useEditOps>;
