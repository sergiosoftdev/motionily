/**
 * Short-form attention curve. Vertical, portrait and square videos (Reels, TikTok, Shorts) are told
 * as a sawtooth: they start high, re-hook every few seconds, escalate and end on the highest peak
 * (docs/agent/craft.md). This file measures that curve from the scene alone, with no rendering,
 * so the agent's review_video and the editor's timelines read the same numbers.
 */

/** What a beat does for attention (concepts and plans tag each beat with one). */
export const AttentionDevice = {
  Hook: "hook",
  OpenLoop: "open_loop",
  Payoff: "payoff",
  Twist: "twist",
  StakesUp: "stakes_up",
  Reveal: "reveal",
  Proof: "proof",
  PatternInterrupt: "pattern_interrupt",
  Countdown: "countdown",
  Question: "question",
  Callback: "callback",
  Cta: "cta",
} as const;
export type AttentionDevice = (typeof AttentionDevice)[keyof typeof AttentionDevice];

/** Seconds per bin of the measured curve. */
export const ATTENTION_BIN = 0.5;
/** Longest stretch (s) a short video may go without a re-hook (beat change, cut, camera move, big entrance). */
export const MAX_REHOOK_GAP = 7;
/** Longest stretch (s) without anything new at all (an entrance, a move, a sound). */
export const MAX_QUIET_GAP = 2.5;
/** The first event must land this early (s): frame 0 is already moving. */
const HOOK_BY = 0.3;
/** The first spoken word should land this early (s). */
const FIRST_WORD_BY = 0.6;
/** Where the pattern interrupt belongs, as shares of the duration. */
const INTERRUPT_FROM = 0.2;
const INTERRUPT_TO = 0.42;
/** The ending: the last strong event must land within this many seconds of the end. */
const END_PEAK_WITHIN = 2;
/** The final 20% must be at least this dense compared with the whole video (peaks escalate). */
const FINALE_DENSITY = 1;

/** Kinds of moments that win attention back, with how much each counts. */
export const AttentionEvent = { Beat: "beat", Cut: "cut", Camera: "camera", Entrance: "entrance", Motion: "motion", Sound: "sound" } as const;
export type AttentionEvent = (typeof AttentionEvent)[keyof typeof AttentionEvent];
const WEIGHT: Record<AttentionEvent, number> = { beat: 3, cut: 2, camera: 2, entrance: 1.5, motion: 0.5, sound: 1 };
/** Weight from which a moment re-hooks (events landing together add up: an entrance + an impact sound). */
const REHOOK_WEIGHT = 2;
/** Events this close together (s) count as one moment. */
const TOGETHER = 0.35;

export type AttentionMoment = { t: number; kind: AttentionEvent; weight: number; what: string };
export type AttentionCurve = {
  /** Novelty per ATTENTION_BIN seconds, 0..1 (1 = the busiest bin of this video). */
  bins: number[];
  moments: AttentionMoment[];
  duration: number;
};

/** Any scene JSON (the engine's, as the editor or the agent holds it). */
type SceneLike = { width?: unknown; height?: unknown; duration?: unknown; layers?: unknown; sfx?: unknown; captions?: unknown };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
type LayerLike = { id?: unknown; type?: unknown; group?: unknown; start?: unknown; end?: unknown; visible?: unknown; vis?: unknown; camera?: unknown; cam?: unknown; [prop: string]: unknown };

const MOVING_PROPS = ["x", "y", "s", "scale", "sx", "sy", "r", "rotation", "w", "h", "o", "opacity", "z"];
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Video shapes told as a sawtooth: everything but 16:9. */
export function isShortFormSize(width: number, height: number) {
  return height >= width;
}

/** The moments of a scene that win attention back, sorted by time. */
export function attentionMoments(scene: SceneLike): AttentionMoment[] {
  const out: AttentionMoment[] = [];
  const add = (t: number, kind: AttentionEvent, what: string) => out.push({ t: Math.max(0, t), kind, weight: WEIGHT[kind], what });
  const groups = new Map<string, number>();
  for (const raw of list(scene.layers)) {
    const l = raw as LayerLike;
    const start = num(l.start);
    const id = String(l.id ?? "");
    const isCamera = l.camera !== undefined || l.cam !== undefined;
    if (typeof l.group === "string" && l.group !== "world") groups.set(l.group, Math.min(groups.get(l.group) ?? Infinity, start));
    if (l.type === "video") add(start, AttentionEvent.Cut, `cut to ${id}`);
    else if (!isCamera && l.visible !== false && l.vis !== 0 && l.group !== "world") add(start, AttentionEvent.Entrance, `${id} enters`);
    // A keyframed move starts where its value first changes.
    for (const prop of MOVING_PROPS) {
      const keys = l[prop];
      if (!Array.isArray(keys) || keys.length < 2) continue;
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1] as { t?: unknown; v?: unknown };
        const b = keys[i] as { t?: unknown; v?: unknown };
        if (num(a.v) !== num(b.v)) add(start + num(a.t), isCamera ? AttentionEvent.Camera : AttentionEvent.Motion, `${id} ${prop}`);
      }
    }
  }
  for (const [group, t] of groups) add(t, AttentionEvent.Beat, `beat ${group}`);
  for (const raw of list(scene.sfx)) {
    const c = raw as { at?: unknown; sound?: unknown };
    add(num(c.at), AttentionEvent.Sound, String(c.sound ?? "sound"));
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Novelty over time, binned and normalized. */
export function attentionCurve(scene: SceneLike): AttentionCurve {
  const duration = num(scene.duration, 0);
  const moments = attentionMoments(scene).filter((m) => m.t <= duration);
  const bins = Array.from({ length: Math.max(1, Math.ceil(duration / ATTENTION_BIN)) }, () => 0);
  for (const m of moments) bins[Math.min(bins.length - 1, Math.floor(m.t / ATTENTION_BIN))]! += m.weight;
  const top = Math.max(...bins, 1);
  return { bins: bins.map((b) => b / top), moments, duration };
}

/** "▁▃▆█" sparkline of a curve, one character per `every` bins (for the agent's text report). */
export function attentionSparkline(bins: number[], every = 2) {
  const marks = "▁▂▃▄▅▆▇█";
  const out: string[] = [];
  for (let i = 0; i < bins.length; i += every) {
    const v = Math.max(...bins.slice(i, i + every));
    out.push(marks[Math.min(marks.length - 1, Math.round(v * (marks.length - 1)))]!);
  }
  return out.join("");
}

/**
 * Where a short video breaks the sawtooth: a still opening, a late first word, flat stretches, no
 * pattern interrupt, a weak finale or an ending that fades out. Empty for 16:9 (classic arc).
 */
export function attentionIssues(scene: SceneLike): string[] {
  const width = num(scene.width, 1080);
  const height = num(scene.height, 1920);
  const duration = num(scene.duration, 0);
  if (!isShortFormSize(width, height) || duration <= 0) return [];
  const { moments } = attentionCurve(scene);
  const issues: string[] = [];
  const strong = moments.filter((m) => moments.filter((o) => o.t >= m.t && o.t - m.t <= TOGETHER).reduce((sum, o) => sum + o.weight, 0) >= REHOOK_WEIGHT);

  if (!moments.length || moments[0]!.t > HOOK_BY) issues.push(`opening: nothing happens until ${moments[0]?.t.toFixed(1) ?? duration}s; frame 0 must already move (start at 70%, in medias res)`);
  const words = captionWords(scene.captions);
  if (words.length && words[0]!.start > FIRST_WORD_BY) issues.push(`opening: the first spoken word lands at ${words[0]!.start.toFixed(1)}s; open on the subject within ${FIRST_WORD_BY}s`);

  // Flat stretches: no re-hook for too long, or nothing new at all.
  const gaps = (list: AttentionMoment[], max: number) => {
    const found: [number, number][] = [];
    let last = 0;
    for (const t of [...list.map((m) => m.t), duration]) {
      if (t - last > max) found.push([last, t]);
      last = Math.max(last, t);
    }
    return found;
  };
  for (const [a, b] of gaps(strong, MAX_REHOOK_GAP)) issues.push(`flat stretch ${a.toFixed(1)}s-${b.toFixed(1)}s with no re-hook: add a beat change, a cut, a camera move or a reveal with an impact sound every 4-7 s`);
  for (const [a, b] of gaps(moments, MAX_QUIET_GAP)) issues.push(`quiet stretch ${a.toFixed(1)}s-${b.toFixed(1)}s: nothing new enters, moves or sounds; valleys still need motion every 0.5-1.5 s`);

  if (duration >= 10 && !strong.some((m) => m.t >= duration * INTERRUPT_FROM && m.t <= duration * INTERRUPT_TO))
    issues.push(`no pattern interrupt between ${(duration * INTERRUPT_FROM).toFixed(1)}s and ${(duration * INTERRUPT_TO).toFixed(1)}s (where viewers drop most): a twist with a hard change of color, layout or camera and a sound hit`);

  const weightIn = (from: number, to: number) => moments.filter((m) => m.t >= from && m.t < to).reduce((s, m) => s + m.weight, 0);
  const finaleFrom = duration * 0.8;
  const finale = weightIn(finaleFrom, duration + 0.01) / (duration - finaleFrom);
  const overall = weightIn(0, duration + 0.01) / duration;
  if (duration >= 10 && finale < overall * FINALE_DENSITY) issues.push(`weak finale: the last 20% is calmer than the video's average; the biggest reveal belongs there (peaks escalate)`);
  const lastStrong = strong.at(-1)?.t ?? 0;
  if (duration - lastStrong > END_PEAK_WITHIN + 1) issues.push(`ending: the last strong moment is at ${lastStrong.toFixed(1)}s; end on the peak (reveal + CTA in the final 2-3 s), no outro`);
  if (fadesOut(scene, duration)) issues.push("ending: everything fades out at the end; cut on the peak instead and let the last image hand back to the first (loop)");
  return issues;
}

function captionWords(captions: unknown): { start: number }[] {
  const words = (captions as { words?: unknown } | null | undefined)?.words;
  return Array.isArray(words) ? words.map((w) => ({ start: num((w as { start?: unknown }).start) })).sort((a, b) => a.start - b.start) : [];
}

/** Most visible layers alive at the end have their opacity keyed down to 0 in the last 2 s. */
function fadesOut(scene: SceneLike, duration: number) {
  const alive = list(scene.layers)
    .map((l) => l as LayerLike)
    .filter((l) => l.visible !== false && l.vis !== 0 && (l.end == null || num(l.end) >= duration - 0.05));
  if (!alive.length) return false;
  const fading = alive.filter((l) => {
    const keys = (l.o ?? l.opacity) as { t?: unknown; v?: unknown }[] | undefined;
    if (!Array.isArray(keys) || keys.length < 2) return false;
    const last = keys.at(-1)!;
    return num(last.v, 1) <= 0.01 && num(l.start) + num(last.t) >= duration - END_PEAK_WITHIN;
  });
  return fading.length / alive.length > 0.6;
}
