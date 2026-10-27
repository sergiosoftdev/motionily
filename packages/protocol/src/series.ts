/**
 * Series templates: the structure of a video that worked (its beats and their timing, rhythm,
 * captions, type, palette, sound pattern, voice pace), saved to make the next episodes with other
 * content. The blueprint is measured from the scene alone, so the editor and the agent read the
 * same one, and an episode can be checked against it while it is built.
 */
import { attentionMoments, AttentionEvent } from "./attention.js";

/** One block of the video (a `g=` group): when it runs and what it carries. */
export type SeriesBeat = {
  group: string;
  start: number;
  end: number;
  /** What it said (its texts, shortened): shows the role of the beat, not content to copy. */
  texts: string[];
  /** Layer types in it (text, image, video, shape…), with counts. */
  kinds: Record<string, number>;
};

export type SeriesBlueprint = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  beats: SeriesBeat[];
  /** Moments that win attention back (beat changes, cuts, camera moves, entrances with a sound), seconds. */
  rehooks: number[];
  transitions: { at: number; use: string }[];
  captions: { style: string | null; shown: boolean };
  typography: { family: string; heading?: number; body?: number } | null;
  palette: Record<string, string> | null;
  sfx: { at: number; sound: string }[];
  music: boolean;
  /** Spoken pace (words per second) and when the first word lands, when the video has a voice. */
  voice: { wordsPerSecond: number; firstWordAt: number } | null;
  layers: number;
};

/** How a saved series' source video did, when it was posted (best numbers per platform). */
export type SeriesPerformance = { platform: string; views: number | null; avgWatch: number | null; skipRate: number | null; duration: number | null };

export type Series = {
  id: string;
  name: string;
  /** Why it worked / what to keep, in the user's words. */
  note: string;
  sourceProjectId: string | null;
  sourceName: string | null;
  format: string;
  blueprint: SeriesBlueprint;
  performance: SeriesPerformance[];
  episodes: number;
  createdAt: string;
};

type Obj = Record<string, unknown>;
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Groups that are scaffolding, not beats: the persistent world behind every beat. */
const NOT_BEATS = new Set(["world", "camera", "bg", "background"]);
const MAX_TEXTS = 3;
const TEXT_CHARS = 60;
/** Strong moments: what re-hooks (see attention.ts). */
const STRONG = new Set<string>([AttentionEvent.Beat, AttentionEvent.Cut, AttentionEvent.Camera]);

/** The blueprint of a scene (any scene JSON as the editor or the agent holds it). */
export function seriesBlueprint(scene: Obj): SeriesBlueprint {
  const duration = num(scene.duration, 0);
  const layers = list(scene.layers);
  const groups = new Map<string, SeriesBeat>();
  for (const l of layers) {
    const g = typeof l.group === "string" ? l.group : null;
    if (!g || NOT_BEATS.has(g) || l.camera !== undefined) continue;
    const start = num(l.start);
    const end = l.end == null ? duration : num(l.end, duration);
    const b = groups.get(g) ?? { group: g, start, end, texts: [], kinds: {} };
    b.start = Math.min(b.start, start);
    b.end = Math.max(b.end, end);
    const kind = String(l.type ?? "layer");
    b.kinds[kind] = (b.kinds[kind] ?? 0) + 1;
    if (l.type === "text" && typeof l.text === "string" && b.texts.length < MAX_TEXTS) b.texts.push(l.text.replace(/\s+/g, " ").slice(0, TEXT_CHARS));
    groups.set(g, b);
  }
  const beats = [...groups.values()].map((b) => ({ ...b, start: r2(b.start), end: r2(Math.min(b.end, duration || b.end)) })).sort((a, b) => a.start - b.start || a.end - b.end);
  const rehooks = [...new Set(attentionMoments(scene).filter((m) => STRONG.has(m.kind) && m.t <= duration).map((m) => r2(m.t)))].sort((a, b) => a - b);
  const words = list((scene.captions as Obj | undefined)?.words).map((w) => ({ start: num(w.start), end: num(w.end) }));
  const spoken = words.length >= 2 ? words.at(-1)!.end - words[0]!.start : 0;
  const typography = scene.typography as Obj | null | undefined;
  return {
    width: num(scene.width, 1080),
    height: num(scene.height, 1920),
    fps: num(scene.fps, 30),
    duration: r2(duration),
    beats,
    rehooks,
    transitions: list(scene.transitions).map((t) => ({ at: r2(num(t.at)), use: String(t.use ?? "") })),
    captions: { style: typeof scene.caption_style === "string" ? scene.caption_style : null, shown: words.length > 0 },
    typography: typography && typeof typography.family === "string" ? { family: typography.family, heading: num(typography.heading) || undefined, body: num(typography.body) || undefined } : null,
    palette: scene.palette && typeof scene.palette === "object" ? Object.fromEntries(Object.entries(scene.palette as Obj).filter(([, v]) => typeof v === "string")) as Record<string, string> : null,
    sfx: list(scene.sfx).map((c) => ({ at: r2(num(c.at)), sound: String(c.sound ?? "") })),
    music: !!scene.music,
    voice: spoken > 0 ? { wordsPerSecond: r2(words.length / spoken), firstWordAt: r2(words[0]!.start) } : null,
    layers: layers.length,
  };
}

const s = (v: number) => `${+v.toFixed(1)}s`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The blueprint for the agent: what to keep from the series, with times scaled to `duration` when it differs. */
export function blueprintLines(series: Pick<Series, "name" | "note" | "blueprint" | "performance">, duration?: number): string[] {
  const b = series.blueprint;
  const k = duration && b.duration ? duration / b.duration : 1;
  const out = [`Series "${series.name}" (${b.width}×${b.height}, ${s(b.duration)}${k !== 1 ? `; times below scaled ×${k.toFixed(2)} to this episode's ${s(duration!)}` : ""})`];
  if (series.note.trim()) out.push(`Why it worked / what to keep (the user): ${series.note.trim()}`);
  for (const p of series.performance) {
    const watch = p.avgWatch !== null && p.duration ? ` · average view ${pct(p.avgWatch / p.duration)}` : "";
    out.push(`  ${p.platform}: ${p.views ?? "?"} views${watch}${p.skipRate !== null ? ` · ${pct(p.skipRate)} skipped in 3 s` : ""}`);
  }
  out.push(`Beats (${b.beats.length}), keep their order, roles and timing:`);
  for (const beat of b.beats) {
    const kinds = Object.entries(beat.kinds).map(([t, n]) => `${n} ${t}`).join(", ");
    out.push(`  ${s(beat.start * k)}–${s(beat.end * k)} g=${beat.group}: ${kinds}${beat.texts.length ? ` · it said ${beat.texts.map((t) => `"${t}"`).join(", ")}` : ""}`);
  }
  if (b.rehooks.length) out.push(`Re-hooks at: ${b.rehooks.map((t) => s(t * k)).join(", ")}`);
  if (b.transitions.length) out.push(`Transitions: ${b.transitions.map((t) => `${s(t.at * k)} ${t.use}`).join(", ")}`);
  out.push(`Captions: ${b.captions.shown ? `on, style ${b.captions.style ?? "default"}` : "none"}`);
  if (b.typography) out.push(`Type: ${b.typography.family}${b.typography.heading ? ` (heading ${b.typography.heading}${b.typography.body ? `, body ${b.typography.body}` : ""})` : ""}`);
  if (b.palette) out.push(`Palette: ${Object.entries(b.palette).map(([slot, hex]) => `${slot} ${hex}`).join(", ")}`);
  if (b.sfx.length) out.push(`Sound effects: ${b.sfx.map((c) => `${s(c.at * k)} ${c.sound}`).join(", ")}`);
  out.push(`Music: ${b.music ? "yes" : "no"}`);
  if (b.voice) out.push(`Voice pace: ${b.voice.wordsPerSecond} words/s, first word at ${s(b.voice.firstWordAt)}`);
  return out;
}

/** Beat starts this far apart (seconds, after scaling) read as a different rhythm. */
const BEAT_SLACK = 0.6;
/** Spoken pace this far off (share) reads as another voice rhythm. */
const PACE_SLACK = 0.25;

/**
 * Where an episode departs from its series so far: frame, beat count and timing, captions, type,
 * palette, voice pace. Empty when it follows it. Content is free; the structure is the series.
 */
export function seriesDrift(scene: Obj, b: SeriesBlueprint): string[] {
  const e = seriesBlueprint(scene);
  const out: string[] = [];
  if (e.width !== b.width || e.height !== b.height) out.push(`frame ${e.width}×${e.height}, the series is ${b.width}×${b.height} (set_format)`);
  if (!e.beats.length) return [...out, "no beats yet (g= groups): build them following the series' beats"];
  const k = e.duration && b.duration ? e.duration / b.duration : 1;
  if (e.beats.length !== b.beats.length) out.push(`${e.beats.length} beats, the series has ${b.beats.length}`);
  const n = Math.min(e.beats.length, b.beats.length);
  for (let i = 0; i < n; i++) {
    const [have, want] = [e.beats[i]!, b.beats[i]!];
    if (Math.abs(have.start - want.start * k) > BEAT_SLACK) out.push(`beat ${i + 1} (g=${have.group}) starts at ${s(have.start)}, the series' at ${s(want.start * k)}`);
  }
  if (b.captions.shown && e.captions.style !== b.captions.style) out.push(`captions ${e.captions.style ?? "default"}, the series uses ${b.captions.style ?? "default"} (set_caption_style)`);
  if (b.typography && e.typography?.family !== b.typography.family) out.push(`font ${e.typography?.family ?? "default"}, the series uses ${b.typography.family} (set_font)`);
  if (b.palette && e.palette) {
    const off = Object.entries(b.palette).filter(([slot, hex]) => e.palette![slot]?.toLowerCase() !== hex.toLowerCase()).map(([slot]) => slot);
    if (off.length) out.push(`palette differs in ${off.join(", ")} (set_palette, unless the user asked for new colors)`);
  } else if (b.palette && !e.palette) out.push("no palette set: the series has its own (set_palette)");
  if (b.voice && e.voice && Math.abs(e.voice.wordsPerSecond - b.voice.wordsPerSecond) / b.voice.wordsPerSecond > PACE_SLACK)
    out.push(`voice pace ${e.voice.wordsPerSecond} words/s, the series ${b.voice.wordsPerSecond}`);
  return out;
}
