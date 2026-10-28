import { useState } from "react";
import { VideoFormat } from "@motionily/protocol";
import { api, type BrandSummary } from "../api/client";
import { EditorMode, saveEditorMode } from "../editor/mode";
import { navigate, RouteName } from "../router";
import { FormatPicker } from "./FormatPicker";
import { Dropdown, PaletteDots } from "./Dropdown";

/** A project's main colors, for its swatch. */
const paletteColors = (b: BrandSummary) => {
  const p = b.palettes[0];
  return p ? [p.primary, p.accent, p.background] : [];
};

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
    <section className="flex flex-col gap-4 rounded-2xl bg-gradient-to-br from-neutral-900 to-neutral-950 p-5 ring-1 ring-white/[0.06]">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <h2 className="text-lg font-semibold">Start a video</h2>
          <p className="text-sm text-neutral-500">Choose where it goes and its shape, then how you want to work.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {brands.length > 0 && (
            <div className="flex w-60 flex-col gap-1.5">
              <span className="text-xs text-neutral-500">Project</span>
              <Dropdown
                label="Project"
                value={brandId ?? null}
                onChange={setPicked}
                options={brands.map((b) => ({
                  value: b.id,
                  label: b.name,
                  hint: `${b.videos} ${b.videos === 1 ? "video" : "videos"}`,
                  lead: <PaletteDots colors={paletteColors(b)} />,
                }))}
              />
            </div>
          )}
          <div className="flex w-64 flex-col gap-1.5">
            <span className="text-xs text-neutral-500">Shape</span>
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
            className="group flex items-start gap-3.5 rounded-xl bg-white/[0.03] p-4 text-left ring-1 ring-white/[0.06] transition hover:bg-white/[0.07] hover:ring-white/15 disabled:opacity-60"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-200 transition group-hover:bg-[#e5484d] group-hover:text-white">
              <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={s.icon} />
              </svg>
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="font-semibold">{busy === s.kind ? "Opening…" : s.title}</span>
              <span className="text-[13px] leading-snug text-neutral-400">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
