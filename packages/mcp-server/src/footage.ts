/**
 * Footage editing: the user's own clips (usually someone talking to camera) cut by their transcript.
 * The agent picks word ranges in the order it wants them; this turns them into a sequence of video
 * layers with tight cuts (long pauses and filler sounds removed), and moves the words onto the new
 * timeline so captions and @word timing keep working.
 */

import type { FootageClip as ProjectFootage, VoiceWord } from "@motionily/protocol";

export type FootageWord = VoiceWord;
/** What an edit reads of a clip (the project's footage, as the API sends it). */
export type FootageClip = Pick<ProjectFootage, "id" | "name" | "url" | "duration" | "width" | "height" | "poster" | "words">;
/** Words `from`..`to` (inclusive, numbered from 0) of a clip. */
export type Segment = { clip: string; from: number; to: number };
/** One cut of the edit: file seconds `in`..`out` of a clip, placed at `start` on the video. */
export type Piece = { clip: string; src: string; in: number; out: number; start: number; from: number; to: number; text: string };
export type CaptionWord = FootageWord & { emphasis?: boolean };
export type EditOptions = {
  /** Silences longer than this inside a kept range are cut out (s). */
  maxPause: number;
  /** Sound kept before the first word of each cut (s). */
  pad: number;
  /** Drop "um", "uh", "erm"… (each one becomes a cut). */
  dropFillers: boolean;
  /** Scale of every other cut (1 = off): alternating framing hides jump cuts. */
  punchIn: number;
};

/** Layer group of the edit: edit_footage replaces it as a whole. */
export const FOOTAGE_GROUP = "footage";
export const DEFAULT_EDIT: EditOptions = { maxPause: 0.35, pad: 0.06, dropFillers: true, punchIn: 1 };
/** Sound kept after the last word of a cut: word endings and breaths trail off. */
const TAIL = 0.12;
/** Shortest cut worth keeping (s). */
const MIN_PIECE = 0.12;
/** Pure hesitation sounds in English and Spanish; real words are never dropped. */
const FILLER = /^(u+m+|u+h+|e+r+m*|a+h+|e+h+m*|m+h*m+|h+m+)[,.!?…]*$/i;
/** A new transcript line after a pause this long, or this many words. */
const LINE_GAP = 0.5;
const LINE_WORDS = 16;

const round = (n: number) => Math.round(n * 1000) / 1000;
export const isFiller = (word: string) => FILLER.test(word.trim());

/** Numbers, long words and shouting tend to be the words worth highlighting (same rule as the editor). */
export function isKeyWord(word: string): boolean {
  const bare = word.replace(/[^\p{L}\p{N}%€$]/gu, "");
  return /\d/.test(bare) || bare.length >= 9 || (bare.length >= 3 && bare === bare.toUpperCase() && /\p{L}/u.test(bare));
}

/** "c1:0-45, c1:52-130 c2:7" → segments, in the order given. */
export function parseSegments(spec: string): Segment[] {
  const parts = spec.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) throw new Error("cut: give word ranges like `c1:0-45, c1:52-130` (clip:from-to, words numbered as in get_footage)");
  return parts.map((p) => {
    const m = /^([a-z]\w*):(\d+)(?:-(\d+))?$/i.exec(p);
    if (!m) throw new Error(`cut: '${p}' is not clip:from-to (e.g. c1:12-40)`);
    const from = Number(m[2]);
    const to = m[3] === undefined ? from : Number(m[3]);
    if (to < from) throw new Error(`cut: '${p}' ends before it starts`);
    return { clip: m[1]!, from, to };
  });
}

/** The edit as cuts on the video's timeline, plus the kept words on that timeline. */
export function buildEdit(clips: FootageClip[], segments: Segment[], o: EditOptions = DEFAULT_EDIT) {
  const pieces: Piece[] = [];
  const captions: CaptionWord[] = [];
  let t = 0;
  for (const seg of segments) {
    const clip = clips.find((c) => c.id === seg.clip);
    if (!clip) throw new Error(`cut: no clip '${seg.clip}' (clips: ${clips.map((c) => c.id).join(", ") || "none"})`);
    const words = clip.words;
    if (!words?.length) throw new Error(`cut: clip ${clip.id} has no transcript yet`);
    if (seg.to >= words.length) throw new Error(`cut: clip ${clip.id} has words 0-${words.length - 1}; '${seg.clip}:${seg.from}-${seg.to}' goes past them`);
    const end = clip.duration ?? words.at(-1)!.end + 1;

    // Runs of kept words: a long pause or a dropped filler starts a new run (a new cut).
    const runs: { first: number; last: number }[] = [];
    for (let i = seg.from; i <= seg.to; i++) {
      if (o.dropFillers && isFiller(words[i]!.text)) {
        runs.push({ first: -1, last: -1 });
        continue;
      }
      const run = runs.at(-1);
      if (run && run.last >= 0 && words[i]!.start - words[run.last]!.end <= o.maxPause) run.last = i;
      else runs.push({ first: i, last: i });
    }
    const kept = runs.filter((r) => r.first >= 0);
    kept.forEach((r, k) => {
      const first = words[r.first]!;
      const last = words[r.last]!;
      let inS = Math.max(0, first.start - o.pad);
      let outS = Math.min(end, last.end + TAIL);
      // Never repeat sound across two cuts of the same take: split the gap between them.
      const prev = kept[k - 1];
      if (prev) inS = Math.max(inS, (words[prev.last]!.end + first.start) / 2);
      // The range right after another of the same take (c1:40-47, c1:48-60) starts where that cut ended.
      const before = pieces.at(-1);
      if (before?.clip === clip.id && inS < before.out && inS > before.in) inS = before.out;
      const next = kept[k + 1];
      if (next) outS = Math.min(outS, (last.end + words[next.first]!.start) / 2);
      if (outS - inS < MIN_PIECE) return;
      const piece: Piece = {
        clip: clip.id,
        src: clip.url,
        in: round(inS),
        out: round(outS),
        start: round(t),
        from: r.first,
        to: r.last,
        text: words.slice(r.first, r.last + 1).map((w) => w.text).join(" "),
      };
      pieces.push(piece);
      for (let i = r.first; i <= r.last; i++) {
        const w = words[i]!;
        const start = round(piece.start + Math.max(0, w.start - piece.in));
        captions.push({ text: w.text, start, end: round(Math.max(start + 0.05, piece.start + Math.min(w.end, piece.out) - piece.in)), ...(isKeyWord(w.text) ? { emphasis: true } : {}) });
      }
      t += piece.out - piece.in;
    });
  }
  if (!pieces.length) throw new Error("cut: nothing left to show (every range was empty or filler)");
  return { pieces, captions, duration: round(t) };
}

/** The cuts as compact layer lines (group `footage`), filling a frame of `w`×`h`. */
export function footageLines(pieces: Piece[], w: number, h: number, punchIn: number): string {
  return pieces
    .map((p, i) => {
      const end = round(p.start + (p.out - p.in));
      const scale = punchIn > 1 && i % 2 === 1 ? ` s=${punchIn}` : "";
      return `ft${i + 1} video ${p.start}-${end} g=${FOOTAGE_GROUP} x=${w / 2} y=${h / 2} w=${w} h=${h} src=${p.src} fit=cover in=${p.in} out=${p.out} volume=1${scale}`;
    })
    .join("\n");
}

/** A clip's transcript as numbered lines (a new line after a pause or every few words), with long pauses noted. */
export function transcriptLines(words: FootageWord[]): string[] {
  const lines: string[] = [];
  let a = 0;
  for (let i = 1; i <= words.length; i++) {
    const gap = i < words.length ? words[i]!.start - words[i - 1]!.end : Infinity;
    if (i < words.length && gap < LINE_GAP && i - a < LINE_WORDS) continue;
    const text = words.slice(a, i).map((w) => w.text).join(" ");
    lines.push(`#${a}-${i - 1} ${words[a]!.start.toFixed(2)}-${words[i - 1]!.end.toFixed(2)}s ${JSON.stringify(text)}${Number.isFinite(gap) && gap >= 1 ? ` · pause ${gap.toFixed(1)}s` : ""}`);
    a = i;
  }
  return lines;
}
