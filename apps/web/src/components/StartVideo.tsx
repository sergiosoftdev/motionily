import { useState } from "react";
import { VideoFormat } from "@motionily/protocol";
import { api, type BrandSummary } from "../api/client";
import { EditorMode, saveEditorMode } from "../editor/mode";
import { navigate, RouteName } from "../router";
import { FormatPicker } from "./FormatPicker";

/** Ways to start a video from the dashboard: straight into an editor, or the guided wizard. */
const StartKind = { Create: "create", Edit: "edit", Guided: "guided" } as const;
type StartKind = (typeof StartKind)[keyof typeof StartKind];

const STARTS: { kind: StartKind; title: string; hint: string; icon: string }[] = [
  {
    kind: StartKind.Create,
    title: "Create",
    hint: "Opens the editor right away. Tell your agent what the video is about and it builds it.",
    icon: "M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5",
  },
  {
    kind: StartKind.Edit,
    title: "Edit",
    hint: "Opens the multitrack editor. Upload your clips, cut them by hand and ask for graphics anywhere.",
    icon: "M3 6h9M3 12h18M3 18h12M16 3v18",
  },
  {
    kind: StartKind.Guided,
    title: "Guided",
    hint: "Step by step: your idea, a few angles to pick from, the script and the voice.",
    icon: "M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11",
  },
];

const UNTITLED = "Untitled video";
/** Name of the project made when the user has none yet (the guided flow needs one). */
const FIRST_PROJECT = "My project";

/**
 * The dashboard's start row: Create and Edit make an empty video and open its editor (Simple or
 * Edit mode) with no questions asked; Guided is the wizard. Videos land in the picked project.
 */
export function StartVideo({ brands }: { brands: BrandSummary[] }) {
  const [format, setFormat] = useState<VideoFormat>(VideoFormat.Vertical);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<StartKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The picked project, else the last one touched (the API puts the video in a default one when there is none). */
  const brandId = picked ?? brands[0]?.id;

  const start = async (kind: StartKind) => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === StartKind.Guided) {
        navigate({ name: RouteName.NewVideo, brandId: brandId ?? (await api.createBrand(FIRST_PROJECT)).id });
        return;
      }
      const p = await api.createProject(UNTITLED, "", format, brandId);
      saveEditorMode(kind === StartKind.Edit ? EditorMode.Edit : EditorMode.Simple);
      navigate({ name: RouteName.Editor, id: p.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Start a video</h2>
        <div className="flex flex-wrap items-center gap-3">
          {brands.length > 1 && (
            <select
              value={brandId}
              onChange={(e) => setPicked(e.target.value)}
              aria-label="Project"
              className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
            >
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <div className="w-64">
            <FormatPicker value={format} onChange={setFormat} />
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {STARTS.map((s) => (
          <button
            key={s.kind}
            type="button"
            disabled={busy !== null}
            onClick={() => void start(s.kind)}
            className="flex flex-col gap-3 rounded-xl bg-neutral-900 p-5 text-left transition hover:bg-neutral-800 disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" className="size-5 text-neutral-300" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={s.icon} />
            </svg>
            <span className="font-semibold">{busy === s.kind ? "Opening…" : s.title}</span>
            <span className="text-sm text-neutral-400">{s.hint}</span>
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
