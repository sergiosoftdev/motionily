import { useState } from "react";
import { VideoFormat } from "@motionily/protocol";
import { api } from "../api/client";
import { FormatPicker } from "../components/FormatPicker";
import { requestPipeline, VideoPipeline } from "../pipeline";
import { navigate, RouteName } from "../router";
import { browserLanguage, LANGUAGES } from "./languages";
import { useAgentName } from "../agentName";

/** Clip formats the editor decodes. */
const ACCEPT = "video/mp4,video/quicktime,video/webm";
const DEFAULT_BRIEF =
  "A tight short video from my footage: keep the best take of each idea, cut the pauses and filler, open with a strong hook and add a few titles for the key points.";

/** Start a video from the user's own clips: upload them, then the editor transcribes them and Claude cuts the edit. */
export function EditFootageButton({ brandId }: { brandId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-semibold hover:bg-neutral-700">
        Edit footage
      </button>
      {open && <EditFootageDialog brandId={brandId} onClose={() => setOpen(false)} />}
    </>
  );
}

function EditFootageDialog({ brandId, onClose }: { brandId: string; onClose: () => void }) {
  const agent = useAgentName();
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState<VideoFormat>(VideoFormat.Vertical);
  const [language, setLanguage] = useState(browserLanguage);
  const [brief, setBrief] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = status !== null;

  const add = (list: FileList | null) => setFiles((fs) => [...fs, ...[...(list ?? [])].filter((f) => f.type.startsWith("video/"))]);

  const start = async () => {
    setError(null);
    setStatus("Creating the video…");
    let projectId: string | null = null;
    try {
      const name = files[0]!.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Footage edit";
      projectId = (await api.createProject(name, brief.trim() || DEFAULT_BRIEF, format, brandId)).id;
      for (const [i, f] of files.entries()) {
        setStatus(files.length > 1 ? `Uploading clip ${i + 1} of ${files.length}…` : "Uploading the clip…");
        await api.uploadFootage(projectId, f, language);
      }
      // The editor transcribes the clips as it opens, then Claude cuts the edit.
      requestPipeline(projectId, VideoPipeline.TranscribeFootageThenGenerate);
      navigate({ name: RouteName.Editor, id: projectId });
    } catch (e) {
      if (projectId) await api.deleteProject(projectId).catch(() => undefined);
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => !busy && onClose()}>
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-6 overflow-y-auto rounded-2xl bg-neutral-900 p-6" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-bold">Edit your footage</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Upload what you recorded. Motionily transcribes it, and {agent} cuts the best takes, removes the pauses and adds captions and graphics.
          </p>
        </div>

        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            add(e.dataTransfer.files);
          }}
          className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-neutral-700 px-4 py-8 text-center hover:border-neutral-500"
        >
          <span className="text-sm font-semibold">Drop your clips here</span>
          <span className="text-xs text-neutral-500">MP4, MOV or WebM · several clips play in the order you add them</span>
          <input type="file" accept={ACCEPT} multiple disabled={busy} onChange={(e) => add(e.target.files)} className="hidden" />
        </label>
        {files.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-3">
                <span className="w-6 text-xs text-neutral-500">c{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-neutral-500">{(f.size / 1e6).toFixed(0)} MB</span>
                <button type="button" disabled={busy} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} aria-label="Remove" className="text-neutral-500 hover:text-white">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-xs text-neutral-400">Format</span>
          <FormatPicker value={format} onChange={setFormat} />
        </div>
        <label className="flex flex-col gap-2">
          <span className="text-xs text-neutral-400">Language spoken</span>
          <select value={language} disabled={busy} onChange={(e) => setLanguage(e.target.value)} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm">
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-xs text-neutral-400">What do you want?</span>
          <textarea
            value={brief}
            disabled={busy}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder={DEFAULT_BRIEF}
            className="resize-y rounded-lg bg-neutral-800 px-3 py-2 text-sm placeholder:text-neutral-500"
          />
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {status && <span className="mr-auto text-xs text-neutral-400">{status}</span>}
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !files.length}
            onClick={() => void start()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
          >
            Upload and edit
          </button>
        </div>
      </div>
    </div>
  );
}
