/**
 * Which video made here a video found on a connected account came from, when it was posted outside the
 * calendar: its length against the scene's, the caption's words against the video's name, script, post
 * copy and on-screen text (rare words count most), and the dates (one made after it went out is unlikely;
 * one whose other copy went out the same days is likely).
 */

/** A video made here, as the matcher reads it. */
export type MatchCandidate = {
  id: string;
  name: string;
  /** Everything it says: name, voice script, post copy, on-screen text. */
  text: string;
  /** Scene length (s). */
  duration: number | null;
  createdAt: number;
  /** When its copies already on other accounts went out (ms). */
  postedAt: number[];
};

export type MatchedVideo = { caption: string; duration: number | null; publishedAt: string | null };

export type MatchResult = { id: string; score: number; why: string[] };

/** Score a match needs, and its lead over the next one, to be linked without asking. */
export const MATCH_SURE = 3;
export const MATCH_LEAD = 2;
/** Length within this (s) matches: platforms round it. */
const SAME_LENGTH = 1.5;
const CLOSE_LENGTH = 3;
const FAR_LENGTH = 6;
/** Points for a caption word only this video uses: in its name, in the rest of what it says. */
const NAME_WORD = 3;
const SCRIPT_WORD = 1.5;
/** Another copy that went out within this of it. */
const SAME_DAYS = 2 * 86_400_000;
/** A video made up to this long after the post still counts (clocks, drafts saved later). */
const CLOCK_SLACK = 3_600_000;

const STOP = new Set(
  (
    "the and for are but not you your yours with this that these those from have has had was were will would can could " +
    "just what when where which who why how all any its it's they them their there here into out about than then too very " +
    "one two our ours his her she him himself herself itself does did doing don't isn't aren't been being also even more " +
    "most some such only own same so off over under again once each few other both because while until fyp foryou foryoupage " +
    "viral reels reel shorts tiktok instagram youtube video videos follow like share comment " +
    "los las del por para con una unos unas que como pero sus este esta estos estas ese esa eso más muy sin sobre entre " +
    "cuando donde quien porque también hay fue ser son está están tiene tienen todo toda todos todas"
  ).split(" "),
);

export function words(text: string): string[] {
  return (text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9']+/g) ?? [])
    .map((w) => w.replace(/^'+|'+$/g, "").replace(/'s$/, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Each candidate's score for one posted video, best first. */
export function rankMatches(v: MatchedVideo, candidates: MatchCandidate[]): MatchResult[] {
  const vocab = candidates.map((c) => ({ c, all: new Set(words(c.text)), name: new Set(words(c.name)) }));
  // Rare words say more: "tongue" names one video, "myth" names them all.
  const df = new Map<string, number>();
  for (const { all } of vocab) for (const w of all) df.set(w, (df.get(w) ?? 0) + 1);
  const rarity = (w: string) => 1 / (df.get(w) ?? 1);
  const caption = [...new Set(words(v.caption))];
  const at = v.publishedAt ? Date.parse(v.publishedAt) : null;

  const out: MatchResult[] = [];
  for (const { c, all, name } of vocab) {
    let score = 0;
    const why: string[] = [];
    // Made after it went out: rarely its source (a copy made later, a remake), so it counts against.
    if (at !== null && c.createdAt > at + CLOCK_SLACK) score -= 2;
    if (v.duration != null && c.duration != null && c.duration > 0) {
      const diff = Math.abs(v.duration - c.duration);
      if (diff <= SAME_LENGTH) (score += 3), why.push(`same length (${Math.round(v.duration)} s)`);
      else if (diff <= CLOSE_LENGTH) score += 1;
      else if (diff > FAR_LENGTH) score -= 3;
    }
    const shared = caption.filter((w) => all.has(w));
    // A word of its name that no other video uses is enough on its own; one of its script, half that.
    const text = shared.reduce((a, w) => a + rarity(w) * (name.has(w) ? NAME_WORD : SCRIPT_WORD), 0);
    if (text > 0) {
      score += Math.min(6, text);
      why.push(`caption says ${shared.sort((a, b) => rarity(b) - rarity(a)).slice(0, 3).map((w) => `“${w}”`).join(", ")}`);
    }
    if (at !== null && c.postedAt.some((p) => Math.abs(p - at) <= SAME_DAYS)) (score += 1.5), why.push("its other copy went out the same days");
    out.push({ id: c.id, score: Math.round(score * 10) / 10, why });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The match to link without asking, or null when none is clear. */
export function sureMatch(ranked: MatchResult[]): MatchResult | null {
  const [best, next] = ranked;
  if (!best || best.score < MATCH_SURE) return null;
  return !next || best.score - next.score >= MATCH_LEAD ? best : null;
}
