import { useEffect, useRef, useState } from "react";
import type { Project, SunoPrompt } from "@motionily/protocol";
import { api } from "../../api/client";
import { useAgentName } from "../../agentName";

const SUNO_URL = "https://suno.com/create";
const SUNO_LOGO = "/brand/suno.png";

/**
 * Music made in Suno for this video: Claude writes the style and the structure (timed to the video), the
 * user pastes them in Suno and brings the song back; Motionily lines its loud part up with the key moment.
 * The prompt stays with the video until the user asks for another.
 */
export function SunoDialog({ project, onProject, onSong, onClose }: { project: Project; onProject: (p: Project) => void; onSong: (file: File) => Promise<void>; onClose: () => void }) {
  const agent = useAgentName();
  const [prompt, setPrompt] = useState<SunoPrompt | null>(project.sunoPrompt);
  const [busy, setBusy] = useState<string | null>(null);
  const [steer, setSteer] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const write = async (change?: string) => {
    setBusy(`${agent} is writing the prompt…`);
    setError(null);
    try {
      const p = await api.sunoPrompt(project.id, change);
      setPrompt(p);
      onProject({ ...project, sunoPrompt: p });
      setSteer("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  // The first time only: afterwards the saved prompt is shown as it is. The ref keeps a re-run effect
  // (React's dev double mount) from asking Claude twice.
  const asked = useRef(false);
  useEffect(() => {
    if (prompt || asked.current) return;
    asked.current = true;
    void write();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy("Uploading and lining the song up with the video…");
    setError(null);
    try {
      await onSong(file);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const field = (key: string, label: string, text: string) => (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-neutral-400">{label}</span>
        <button type="button" onClick={() => void copy(key, text)} className="text-xs font-semibold text-white hover:underline">
          {copied === key ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-48 overflow-y-auto rounded-lg bg-neutral-950 px-3 py-2 font-sans text-sm leading-relaxed whitespace-pre-wrap text-neutral-100">{text}</pre>
    </section>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => !busy && onClose()}>
      <div className="flex max-h-[90dvh] w-full max-w-xl flex-col gap-5 overflow-y-auto rounded-2xl bg-neutral-900 p-6" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <img src={SUNO_LOGO} alt="" className="size-6 rounded-full" />
            Music with Suno
          </h2>
          <p className="mt-1 text-sm text-neutral-400">
            {agent} wrote this for your video. Paste it in Suno, generate, and bring the song back: Motionily lines its big moment up with the video.
          </p>
        </div>

        {prompt ? (
          <>
            <ol className="flex flex-col gap-1 text-sm text-neutral-300">
              <li>
                1.{" "}
                <a href={SUNO_URL} target="_blank" rel="noreferrer" className="font-semibold text-white underline">
                  Open Suno
                </a>{" "}
                (Custom mode) and turn on Instrumental.
              </li>
              <li>2. Paste the style and the structure below, then Create.</li>
              <li>3. Download the version you like and upload it here.</li>
            </ol>
            {field("style", "Style of music", prompt.style)}
            {field("structure", "Lyrics (the structure: sections only)", prompt.structure)}
            <p className="text-xs text-neutral-500">
              {prompt.title && <span className="text-neutral-300">“{prompt.title}” · </span>}
              {prompt.dropAt !== null && <>The drop lands at {prompt.dropAt.toFixed(1)} s of the video. </>}
              {prompt.notes}
            </p>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => input.current?.click()}
              className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
            >
              Upload the song from Suno
            </button>
            <input ref={input} type="file" accept="audio/*" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
            <div className="flex gap-2">
              <input
                value={steer}
                disabled={!!busy}
                onChange={(e) => setSteer(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void write(steer)}
                placeholder="Want something else? darker, more electronic, slower…"
                className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-3 py-2 text-sm placeholder:text-neutral-500"
              />
              <button type="button" disabled={!!busy} onClick={() => void write(steer)} className="shrink-0 rounded-lg bg-neutral-800 px-3 py-2 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-50">
                Write another
              </button>
            </div>
          </>
        ) : (
          !busy && !error && <p className="text-sm text-neutral-500">No prompt yet.</p>
        )}

        {busy && <p className="text-xs text-neutral-400">{busy}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button type="button" disabled={!!busy} onClick={onClose} className="self-end rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white">
          Close
        </button>
      </div>
    </div>
  );
}
