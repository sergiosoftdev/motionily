import { useEffect, useState } from "react";
import { api, type SceneVersionRow } from "../../api/client";
import { agentBridge } from "../../bridge";
import { engineHost } from "../../engine/host";
import { ActivitySource, logActivity } from "../../store";

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The video's history: a version every minute of editing and named snapshots; restoring one loads it (undo still works). */
export function VersionsSection({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<SceneVersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const load = () => api.versions(projectId).then(setRows, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const restore = async (v: SceneVersionRow) => {
    try {
      // The current scene is kept as a version first, so a restore is never a loss.
      await api.saveVersion(projectId, "Before restoring");
      const { scene } = await api.version(projectId, v.id);
      engineHost.loadScene(JSON.stringify(scene));
      agentBridge.sceneChanged();
      logActivity(ActivitySource.User, `Restores the version of ${time(v.at)}${v.label ? ` (${v.label})` : ""}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-neutral-400">Versions</span>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void api.saveVersion(projectId, label).then(() => {
            setLabel("");
            return load();
          }, (er: Error) => setError(er.message));
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" className="min-w-0 flex-1 rounded-md bg-neutral-900 px-2 py-1 text-[11px] placeholder:text-neutral-600 focus:outline-none" />
        <button type="submit" className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] hover:bg-neutral-700">
          Save version
        </button>
      </form>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {rows && !rows.length && <p className="text-[11px] text-neutral-500">Versions appear as you edit (one a minute) and when you save one.</p>}
      <ul className="flex max-h-56 flex-col overflow-y-auto">
        {(rows ?? []).slice(0, 40).map((v) => (
          <li key={v.id} className="group flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[11px] hover:bg-neutral-800/60">
            <span className="min-w-0 truncate">
              <span className={v.label ? "text-neutral-200" : "text-neutral-400"}>{v.label || "Autosave"}</span>
              <span className="text-neutral-500"> · {time(v.at)} · {v.layers} layers</span>
            </span>
            <button type="button" onClick={() => void restore(v)} className="shrink-0 text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-white">
              Restore
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
