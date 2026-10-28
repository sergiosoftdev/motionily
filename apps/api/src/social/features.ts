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
};

type Layer = { type?: unknown; text?: unknown; start?: unknown; end?: unknown; visible?: unknown };
type Word = { text?: unknown; word?: unknown; start?: unknown };
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const words = (v: unknown): Word[] => (Array.isArray(v) ? (v as Word[]) : []);
const wordText = (w: Word) => String(w.text ?? w.word ?? "").trim();

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
    .map((l) => (l.text as string).replace(/[*_]/g, "").replace(/\s+/g, " ").trim());
  const hook = (opening.length ? opening.join(" ") : onScreen.slice(0, 2).join(" / ")).slice(0, 140);
  const starts = new Set(layers.map((l) => Math.round(num(l.start) * 10)).filter((t) => t > 0));
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
  };
}
