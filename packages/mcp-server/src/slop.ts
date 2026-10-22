/**
 * The AI tells review_video can measure on the scene (docs/agent/craft.md, AI TELLS): devices that
 * agents repeat by default until a video smells generated. Each note names the layers so the fix is
 * a targeted edit, not a rebuild.
 */
type Layer = Record<string, unknown>;

/** Text animators with a blur start on this share of the text layers = the default blur-in everywhere. */
const BLUR_IN_SHARE = 0.4;
const MIN_TEXTS = 5;
/** Overshoot eases on this share of all eased keys = everything pops. */
const OVERSHOOT_SHARE = 0.2;
/** Static tilts between these degrees on this many layers = tilted cards everywhere. */
const TILT = [1.5, 9] as const;
const MAX_TILTS = 4;
const MAX_RINGS = 2;
const MAX_UNDERLINES = 2;
/** Shadow on this share of the layers = shadows as a default, not where things sit on things. */
const SHADOW_SHARE = 0.35;
const STAMP_MAX_CHARS = 16;
const STAMP_TILT = [2, 30] as const;

const isText3d = (l: Layer) => l.type === "object" && (l.node as { shape?: string } | undefined)?.shape === "text";
const textOf = (l: Layer) => String(l.type === "text" ? (l.text ?? "") : isText3d(l) ? ((l.node as { text?: string }).text ?? "") : "");
const num = (v: unknown) => (typeof v === "number" ? v : null);
const shapeOf = (l: Layer) => (l.type === "shape" ? String(l.shape ?? "rect") : String(l.type));
const hasStroke = (l: Layer) => !!l.stroke && typeof l.stroke === "object";
const noFill = (l: Layer) => l.fill === undefined || (typeof l.fill === "string" && /^#[0-9a-f]{6}00$/i.test(l.fill)) || l.fill === "none";
const ids = (ls: Layer[], n = 6) => ls.slice(0, n).map((l) => String(l.id)).join(", ") + (ls.length > n ? "…" : "");

function eases(v: unknown): string[] {
  return Array.isArray(v) ? v.map((k) => (k as { ease?: string }).ease).filter((e): e is string => !!e) : [];
}

/** A component that draws a stamp: a stroked unfilled box (or ring) and a text inside it. */
function stampComponent(def: { layers?: Layer[] } | undefined): boolean {
  const ls = def?.layers ?? [];
  return ls.some((l) => hasStroke(l) && noFill(l) && (shapeOf(l) === "rect" || shapeOf(l) === "ellipse")) && ls.some((l) => l.type === "text");
}

export function slopNotes(scene: { layers?: Layer[]; library?: { components?: Record<string, { layers?: Layer[] }> } } | null): string[] {
  const layers = scene?.layers ?? [];
  const components = scene?.library?.components ?? {};
  const notes: string[] = [];
  const texts = layers.filter((l) => l.type === "text" || isText3d(l));

  // Rubber stamps: a short CAPS word tilted inside (or as) a stroked box tilted the same way.
  const stamps = texts.filter((t) => {
    const word = textOf(t).replace(/\*/g, "").trim();
    const r = Math.abs(num(t.rotation) ?? 0);
    if (!word || word.length > STAMP_MAX_CHARS || word !== word.toUpperCase() || !/[A-Z]/.test(word) || r < STAMP_TILT[0] || r > STAMP_TILT[1]) return false;
    return layers.some((b) => b !== t && hasStroke(b) && noFill(b) && Math.abs((num(b.rotation) ?? 0) - (num(t.rotation) ?? 0)) < 4 && Math.abs((num(b.x) ?? -1e9) - (num(t.x) ?? 1e9)) < 120 && Math.abs((num(b.y) ?? -1e9) - (num(t.y) ?? 1e9)) < 80);
  });
  // …or a component placed tilted (`use comp=stamp`), found by its name or by what it draws.
  for (const u of layers.filter((l) => l.type === "use")) {
    const comp = String(u.comp ?? "");
    const r = Math.abs(num(u.rotation) ?? 0);
    if (/stamp|seal|badge/i.test(`${comp} ${String(u.id)}`) || (r >= STAMP_TILT[0] && r <= STAMP_TILT[1] && stampComponent(components[comp]))) stamps.push(u);
  }
  if (stamps.length) notes.push(`rubber stamps (${ids(stamps)}): the most recognizable AI tell — remove them; show a real document or mark if the story needs one`);

  const blurIn = texts.filter((t) => ((t.animate as { from?: { blur?: number } } | undefined)?.from?.blur ?? 0) > 0);
  if (texts.length >= MIN_TEXTS && blurIn.length / texts.length >= BLUR_IN_SHARE)
    notes.push(`blur-in text animator on ${blurIn.length} of ${texts.length} text layers: let most lines appear on cuts or move as blocks; keep per-word animation for one or two stressed moments`);

  const all = layers.flatMap((l) => ["x", "y", "scale", "opacity", "rotation"].flatMap((k) => eases(l[k])));
  const overshoot = all.filter((e) => e === "back" || e === "elastic" || e === "bounce");
  if (all.length >= 20 && overshoot.length / all.length >= OVERSHOOT_SHARE)
    notes.push(`overshoot (back/elastic/bounce) on ${Math.round((overshoot.length / all.length) * 100)}% of the eased keys: keep pops for physical objects landing; type and UI ease out`);

  const tilted = layers.filter((l) => {
    const r = Math.abs(num(l.rotation) ?? 0);
    return r >= TILT[0] && r <= TILT[1];
  });
  if (tilted.length > MAX_TILTS) notes.push(`${tilted.length} layers tilted ±${TILT[0]}-${TILT[1]}° (${ids(tilted)}): one deliberate tilt per film at most`);

  const rings = layers.filter((l) => shapeOf(l) === "ellipse" && hasStroke(l) && noFill(l));
  if (rings.length > MAX_RINGS) notes.push(`${rings.length} decorative rings (${ids(rings)}): every element should be information or real material`);

  // Marker underlines: thin open paths drawn on with trim, sitting just below a text layer.
  const underlines = layers.filter((l) => {
    if (l.type !== "path" || l.filled || !Array.isArray(l.trim_end)) return false;
    const d = String(l.d ?? "");
    return !/[Zz]/.test(d) && texts.some((t) => Math.abs((num(t.x) ?? 1e9) - (num(l.x) ?? 0)) < 300 && (num(l.y) ?? 0) - (num(t.y) ?? 1e9) > 0 && (num(l.y) ?? 0) - (num(t.y) ?? 1e9) < 160);
  });
  if (underlines.length > MAX_UNDERLINES) notes.push(`${underlines.length} marker strokes drawn under text (${ids(underlines)}): at most one, pointing at something real`);

  const shadowed = layers.filter((l) => ((l.effects as { fx: string }[] | undefined) ?? []).some((e) => e.fx === "shadow"));
  if (layers.length >= 20 && shadowed.length / layers.length >= SHADOW_SHARE) notes.push(`drop shadows on ${shadowed.length} of ${layers.length} layers: shadow only where something sits on something`);

  return notes;
}
