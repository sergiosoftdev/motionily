import { test } from "node:test";
import assert from "node:assert/strict";
import { blueprintLines, seriesBlueprint, seriesDrift } from "@motionily/protocol";

const text = (id: string, group: string, t: string, start: number, end: number) => ({ id, type: "text", group, text: t, start, end });
const source = {
  width: 1080,
  height: 1920,
  fps: 30,
  duration: 12,
  caption_style: "pop_word",
  typography: { family: "Fraunces", heading: 800, body: 400 },
  palette: { background: "#111111", primary: "#E9573F" },
  sfx: [{ at: 3, sound: "whoosh" }],
  music: { src: "/media/song.mp3" },
  captions: { words: [{ text: "Bulls", start: 0.2, end: 0.5 }, { text: "hate", start: 0.5, end: 0.9 }, { text: "motion", start: 1.0, end: 1.4 }] },
  layers: [
    { id: "bg", type: "shape", group: "world", start: 0 },
    text("h1", "hook", "Bulls don't hate red.", 0, 3),
    text("w1", "why", "They hate the motion.", 3, 9),
    { id: "w2", type: "image", group: "why", start: 3.5, end: 9 },
    text("c1", "cta", "Follow for myth #2", 9, 12),
  ],
};

test("the blueprint: beats from groups (not the world), type, palette, captions, sound, voice pace", () => {
  const b = seriesBlueprint(source);
  assert.deepEqual(b.beats.map((x) => [x.group, x.start, x.end]), [["hook", 0, 3], ["why", 3, 9], ["cta", 9, 12]]);
  assert.deepEqual(b.beats[1]!.kinds, { text: 1, image: 1 });
  assert.deepEqual(b.beats[0]!.texts, ["Bulls don't hate red."]);
  assert.deepEqual(b.captions, { style: "pop_word", shown: true });
  assert.equal(b.typography?.family, "Fraunces");
  assert.equal(b.palette?.primary, "#E9573F");
  assert.deepEqual(b.sfx, [{ at: 3, sound: "whoosh" }]);
  assert.equal(b.music, true);
  assert.equal(b.voice?.wordsPerSecond, 2.5);
  assert.ok(b.rehooks.includes(3) && b.rehooks.includes(9), "beat changes re-hook");
});

test("an episode that follows the series has no drift; one that does not says where", () => {
  const b = seriesBlueprint(source);
  const episode = { ...source, layers: [text("h", "hook", "Goldfish forget in 3 s?", 0, 3), text("w", "why", "They remember for months.", 3, 9), text("c", "cta", "Follow", 9, 12)] };
  assert.deepEqual(seriesDrift(episode, b), []);
  const off = { ...episode, caption_style: "karaoke", typography: { family: "Inter" }, palette: { background: "#ffffff", primary: "#E9573F" }, layers: [text("h", "hook", "x", 0, 5), text("w", "why", "y", 5, 12)] };
  const drift = seriesDrift(off, b);
  assert.ok(drift.some((d) => d.startsWith("2 beats, the series has 3")));
  assert.ok(drift.some((d) => d.includes("beat 2 (g=why) starts at 5s, the series' at 3s")));
  assert.ok(drift.some((d) => d.includes("captions karaoke")));
  assert.ok(drift.some((d) => d.includes("font Inter")));
  assert.ok(drift.some((d) => d.includes("palette differs in background")));
  // A longer episode keeps the beats in proportion.
  const longer = { ...episode, duration: 24, layers: [text("h", "hook", "a", 0, 6), text("w", "why", "b", 6, 18), text("c", "cta", "c", 18, 24)] };
  assert.deepEqual(seriesDrift(longer, b), []);
});

test("the agent's view scales the beats to the episode and carries the user's note", () => {
  const lines = blueprintLines({ name: "Myths", note: "Myth first, payoff by 9 s", blueprint: seriesBlueprint(source), performance: [{ platform: "Instagram", views: 18400, avgWatch: 6, skipRate: 0.3, duration: 12 }] }, 24).join("\n");
  assert.match(lines, /scaled ×2\.00/);
  assert.match(lines, /6s–18s g=why: 1 text, 1 image · it said "They hate the motion\."/);
  assert.match(lines, /Why it worked \/ what to keep \(the user\): Myth first/);
  assert.match(lines, /Instagram: 18400 views · average view 50% · 30% skipped in 3 s/);
});
