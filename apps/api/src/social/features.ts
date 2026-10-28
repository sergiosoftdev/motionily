/**
 * What a posted video is like, read from its scene: the line it opens with, its length and pace, and
 * whether it has a voice, captions and music. Kept with each post so the channel's numbers can be
 * compared by what the videos did (mirrors VideoFeatures and videoFeatures in @motionily/protocol).
 */

/** Seconds the hook covers (what decides the 3-second skip). */
const HOOK = 3;

export type VideoFeatures = {
  duration: number;
  /** What it opens with: the voice's first words, else the text on screen in the first seconds. */
  hook: string;
  /** Layers that come in per minute after the first frame: how often something new happens. */
  beatsPerMin: number;
  /** Words spoken per second (0 without a voice). */
  wordsPerSec: number;
  voice: boolean;
  captions: boolean;
  music: boolean;
  genre: string | null;
  format: string | null;
  /** What comes on screen and when (no shapes): to line up with where the audience leaves. */
  timeline?: Moment[];
  /** Every second something new comes in, shapes included (where nothing new happens for a while). */
  starts?: number[];
};

/** One element on screen: from `start` to `end` (s), what it is (`kind`) and what it says or is called. */
export type Moment = { start: number; end: number; kind: MomentKind; label: string };

export enum MomentKind {
  Chart = "chart",
  Table = "table",
  Map = "map",
  Code = "code",
  Ui = "ui",
  Logo = "logo",
  Cta = "cta",
  Price = "price",
  Footage = "footage",
  Image = "image",
  Character = "character",
  Object3d = "object",
  Icon = "icon",
  Vector = "vector",
  Effect = "effect",
  Title = "title",
  Text = "text",
}

/** Words in a layer's id, group or component that say what it is, before what kind of layer it is. */
const NAMED: [MomentKind, RegExp][] = [
  [MomentKind.Chart, /^(chart|graph|bars?|pie|donut|plot|axis|kpi|sparkline|histogram)$/],
  [MomentKind.Table, /^(table|spreadsheet|cells?|leaderboard)$/],
  [MomentKind.Map, /^(map|globe|route|country|countries)$/],
  [MomentKind.Code, /^(code|terminal|snippet|cli|editor)$/],
  [MomentKind.Ui, /^(ui|screen|dashboard|app|phone|mockup|browser|laptop|device)$/],
  [MomentKind.Logo, /^(logo|brand|wordmark)$/],
  [MomentKind.Cta, /^(cta|button|subscribe|follow|signup)$/],
  [MomentKind.Price, /^(price|pricing|cost|plan|plans)$/],
];
/** Text this big (scene px) is a title, not a line of copy. */
const TITLE_SIZE = 90;
const MAX_MOMENTS = 150;

type Layer = { id?: unknown; type?: unknown; text?: unknown; size?: unknown; start?: unknown; end?: unknown; visible?: unknown; group?: unknown; comp?: unknown; icon?: unknown };

type Word = { text?: unknown; word?: unknown; start?: unknown };
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const words = (v: unknown): Word[] => (Array.isArray(v) ? (v as Word[]) : []);
const wordText = (w: Word) => String(w.text ?? w.word ?? "").trim();
const clean = (t: string) => t.replace(/[*_]/g, "").replace(/\s+/g, " ").trim();
const round = (v: number) => Math.round(v * 10) / 10;

/** What a layer is to a viewer: a chart, a clip, a title… (null for shapes, sounds and cameras). */
export function momentKind(l: Layer): MomentKind | null {
  const names = [l.id, l.group, l.comp].filter((v): v is string => typeof v === "string").join(" ");
  const tokens = names.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const [kind, re] of NAMED) if (tokens.some((t) => re.test(t))) return kind;
  switch (l.type) {
    case "video":
      return MomentKind.Footage;
    case "image":
      return MomentKind.Image;
    case "character":
      return MomentKind.Character;
    case "object":
      return MomentKind.Object3d;
    case "particles":
    case "shader":
      return MomentKind.Effect;
    case "path":
      return typeof l.icon === "string" ? MomentKind.Icon : MomentKind.Vector;
    case "text":
      return num(l.size) >= TITLE_SIZE ? MomentKind.Title : MomentKind.Text;
    default:
      return null;
  }
}

function momentLabel(l: Layer): string {
  if (l.type === "text" && typeof l.text === "string") return `"${clean(l.text).slice(0, 50)}"`;
  return String(l.group ?? l.comp ?? l.icon ?? l.id ?? l.type ?? "");
}

export function videoFeatures(p: { scene: Record<string, unknown> | null; audio?: { words?: unknown } | null; direction?: { genre?: unknown } | null; format?: string | null }): VideoFeatures | null {
  const scene = p.scene;
  if (!scene) return null;
  const duration = num(scene.duration);
  const layers = (Array.isArray(scene.layers) ? (scene.layers as Layer[]) : []).filter((l) => l.visible !== false);
  const spoken = words(p.audio?.words);
  const opening = spoken.filter((w) => num(w.start, Infinity) < HOOK).map(wordText).filter(Boolean);
  const onScreen = layers
    .filter((l) => l.type === "text" && typeof l.text === "string" && num(l.start) < HOOK)
    .sort((a, b) => num(a.start) - num(b.start))
    .map((l) => clean(l.text as string));
  const hook = (opening.length ? opening.join(" ") : onScreen.slice(0, 2).join(" / ")).slice(0, 140);
  const starts = new Set(layers.map((l) => Math.round(num(l.start) * 10)).filter((t) => t > 0));
  const timeline: Moment[] = [];
  for (const l of layers) {
    const kind = momentKind(l);
    if (kind) timeline.push({ start: round(num(l.start)), end: round(l.end == null ? duration : num(l.end, duration)), kind, label: momentLabel(l) });
  }
  timeline.sort((a, b) => a.start - b.start);
  const captions = scene.captions as { words?: unknown } | null | undefined;
  return {
    duration,
    hook,
    beatsPerMin: duration > 0 ? Math.round((starts.size / duration) * 60) : 0,
    wordsPerSec: duration > 0 ? Math.round((spoken.length / duration) * 10) / 10 : 0,
    voice: spoken.length > 0 || !!scene.audio,
    captions: words(captions?.words).length > 0,
    music: !!scene.music,
    genre: typeof p.direction?.genre === "string" ? p.direction.genre : null,
    format: p.format ?? null,
    timeline: timeline.slice(0, MAX_MOMENTS),
    starts: [...starts].sort((a, b) => a - b).map((t) => t / 10),
  };
}
