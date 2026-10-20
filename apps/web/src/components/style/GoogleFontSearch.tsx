import { useEffect, useState } from "react";
import { BrickSlot, type Brick } from "@motionily/protocol";
import { api, type GoogleFont } from "../../api/client";

const Category = { All: "", Sans: "Sans Serif", Serif: "Serif", Display: "Display", Handwriting: "Handwriting", Mono: "Monospace" } as const;
type Category = (typeof Category)[keyof typeof Category];
const CATEGORY_LABEL: Record<Category, string> = { "": "Todas", "Sans Serif": "Sans", Serif: "Serif", Display: "Display", Handwriting: "Manuscrita", Monospace: "Mono" };

const SEARCH_DEBOUNCE_MS = 250;
const previewed = new Set<string>();

/** Load just the glyphs of the family name so each row previews its own font. */
function preview(family: string) {
  if (previewed.has(family)) return;
  previewed.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?${new URLSearchParams({ family, text: family, display: "swap" })}`;
  document.head.appendChild(link);
}

const nearest = (weights: number[], wanted: number) => weights.reduce((b, w) => (Math.abs(w - wanted) < Math.abs(b - wanted) ? w : b));

/** Any Google Font as the video's typography. It becomes a private option of the project. */
export function GoogleFontSearch({ projectId, current, onChosen }: { projectId: string; current: string; onChosen: (brick: Brick) => void }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<Category>(Category.All);
  const [fonts, setFonts] = useState<GoogleFont[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => api.googleFonts(q, category || undefined).then(setFonts, () => setFonts([])), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, category]);

  useEffect(() => fonts.forEach((f) => preview(f.family)), [fonts]);

  const choose = async (f: GoogleFont) => {
    setBusy(f.family);
    try {
      const brick = await api.createProjectBrick(projectId, {
        slot: BrickSlot.Typography,
        id: `gf_${f.family.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 36)}`,
        name: f.family,
        description: `${f.category} · Google Fonts`,
        payload: { family: f.family, body: nearest(f.weights, 500), heading: nearest(f.weights, 700) },
      });
      onChosen(brick);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-3">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search Google Fonts…"
        className="rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
      />
      <div className="flex flex-wrap gap-1">
        {Object.values(Category).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={`rounded-full px-2.5 py-1 text-[11px] ${category === c ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {fonts.map((f) => (
          <button
            key={f.family}
            type="button"
            disabled={busy !== null}
            onClick={() => void choose(f)}
            className={`flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-neutral-900 ${current === f.family ? "bg-neutral-800" : ""}`}
          >
            <span className="truncate text-lg" style={{ fontFamily: `"${f.family}"` }}>
              {f.family}
            </span>
            <span className="shrink-0 text-[11px] text-neutral-500">{busy === f.family ? "…" : CATEGORY_LABEL[f.category as Category] ?? f.category}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
