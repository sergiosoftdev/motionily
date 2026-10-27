import { useRef, useState } from "react";
import { api } from "../../api/client";
import { ActivitySource, logActivity } from "../../store";
import type { EditorProps } from "../context";
import type { SceneView } from "../sceneView";
import type { MediaPoolState } from "./MediaPool";
import { placeImport, poolFiles, prepareImport, type PendingImport } from "./importTimelineFile";
import { TIMELINE_ACCEPT, matchFiles } from "./timelinePlan";
import type { EditActions } from "./useEditActions";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const FORMAT = { fcpxml: "FCPXML", xmeml: "Final Cut Pro 7 XML", otio: "OpenTimelineIO" } as const;

/**
 * File › Import timeline, as in any editor: a Final Cut Pro / Resolve FCPXML, a Premiere or Resolve XML
 * (Final Cut Pro 7) or an OpenTimelineIO file. Its clips find their files among the project's media by
 * name; the desktop app brings the others in from where the other editor had them, the browser asks for
 * them. Then they go on the Edit timeline (after what is already there) with their tracks and in points.
 */
export function TimelineImport({ ed, scene, pool, edits }: { ed: EditorProps; scene: SceneView | null; pool: MediaPoolState; edits: EditActions }) {
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const timelineInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const project = ed.project;
  if (!project) return null;

  /** The project and its pool again, after files were brought in. */
  const refresh = async () => {
    const p = await api.project(project.id);
    ed.setProject(p);
    await pool.reload();
    return p;
  };

  const open = async (file: File | undefined) => {
    if (!file) return;
    setNote(null);
    try {
      const p = await prepareImport(await file.text(), project, pool.items, setBusy);
      if (p.brought) await refresh();
      setPending(p);
      if (p.failed.length) setNote(p.failed.join("; "));
    } catch (e) {
      setNote(`${file.name}: ${message(e)}`);
    } finally {
      setBusy(null);
    }
  };

  /** The browser: the user points at the missing files; they join the project, then match by name. */
  const addFiles = async (picked: File[]) => {
    if (!pending || !picked.length) return;
    try {
      for (const [i, f] of picked.entries()) {
        setBusy(`Uploading ${i + 1} of ${picked.length}…`);
        if (f.type.startsWith("video/")) await api.uploadFootage(project.id, f, "en");
        else await api.uploadMedia(project.id, f);
      }
      const p = await refresh();
      const files = poolFiles(p, await api.projectMedia(project.id));
      setPending({ ...pending, files, missing: matchFiles(pending.t, files).missing });
    } catch (e) {
      setNote(message(e));
    } finally {
      setBusy(null);
    }
  };

  const place = () => {
    if (!pending || !scene) return;
    const r = placeImport(pending, scene, project, pool.items);
    if (r.placed) {
      edits.apply(r.ops, `Imports the timeline ${pending.t.name} (${r.placed} clips)`, true);
      logActivity(ActivitySource.User, `Imported ${pending.t.name}: ${r.placed} clips`);
      setPending(null);
    }
    setNote(r.text);
  };

  return (
    <div className="flex flex-col gap-1 px-1 text-[11px] text-neutral-500">
      <button type="button" onClick={() => timelineInput.current?.click()} disabled={!!busy} className="self-start hover:text-white disabled:opacity-50" title="A timeline from Final Cut Pro or DaVinci Resolve (FCPXML), Premiere or Resolve (XML) or OpenTimelineIO (.otio)">
        Import timeline…
      </button>
      <input ref={timelineInput} type="file" accept={TIMELINE_ACCEPT} className="hidden" onChange={(e) => void open(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
      {busy && <span>{busy}</span>}
      {pending && !busy && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-neutral-950 p-2 text-neutral-300">
          <span className="font-medium text-neutral-100">
            {pending.t.name} · {FORMAT[pending.t.format]}
          </span>
          <span>
            {pending.t.clips.length} clips, {pending.t.duration.toFixed(1)} s{pending.t.fps ? ` at ${+pending.t.fps.toFixed(3)} fps` : ""}
            {pending.t.width ? ` · ${pending.t.width}×${pending.t.height}` : ""}
          </span>
          {pending.missing.length > 0 && (
            <span className="text-amber-200" title={pending.missing.map((c) => c.url).join("\n")}>
              Not in the project: {pending.missing.map((c) => c.file).join(", ")}
            </span>
          )}
          <span className="flex gap-2">
            <button type="button" onClick={place} className="rounded-md bg-white px-2 py-0.5 font-semibold text-black hover:bg-neutral-200">
              {pending.missing.length ? "Place the rest" : "Place on the timeline"}
            </button>
            {pending.missing.length > 0 && (
              <button type="button" onClick={() => filesInput.current?.click()} className="hover:text-white">
                Find the files…
              </button>
            )}
            <button type="button" onClick={() => setPending(null)} className="ml-auto hover:text-white">
              Cancel
            </button>
          </span>
          <input ref={filesInput} type="file" multiple className="hidden" onChange={(e) => void addFiles([...(e.target.files ?? [])]).finally(() => (e.target.value = ""))} />
        </div>
      )}
      {note && <span className="text-neutral-400">{note}</span>}
    </div>
  );
}
