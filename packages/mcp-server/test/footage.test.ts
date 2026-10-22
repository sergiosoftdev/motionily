import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLines } from "../src/compact.js";
import { buildEdit, DEFAULT_EDIT, footageLines, parseSegments, transcriptLines, type FootageClip } from "../src/footage.js";

/** "So today, um, I want to show you this. [1.5 s pause] Okay so today I want to show you this." */
const clip: FootageClip = {
  id: "c1",
  name: "take.mov",
  url: "/media/0f1e2d3c-0000-4000-8000-000000000000.mov",
  duration: 12,
  width: 1080,
  height: 1920,
  poster: null,
  words: [
    { text: "So", start: 0.5, end: 0.7 }, // 0
    { text: "today,", start: 0.75, end: 1.1 }, // 1
    { text: "um,", start: 1.3, end: 1.6 }, // 2 filler
    { text: "I", start: 1.8, end: 1.9 }, // 3
    { text: "want", start: 1.95, end: 2.2 }, // 4
    { text: "to", start: 2.25, end: 2.35 }, // 5
    { text: "show", start: 2.4, end: 2.7 }, // 6
    { text: "you", start: 2.75, end: 2.9 }, // 7
    { text: "this.", start: 2.95, end: 3.3 }, // 8
    { text: "Okay", start: 4.8, end: 5.1 }, // 9 (after a 1.5 s pause: a second take)
    { text: "so", start: 5.15, end: 5.3 }, // 10
    { text: "today", start: 5.35, end: 5.7 }, // 11
    { text: "I", start: 5.75, end: 5.85 }, // 12
    { text: "want", start: 5.9, end: 6.1 }, // 13
    { text: "to", start: 6.15, end: 6.25 }, // 14
    { text: "show", start: 6.3, end: 6.6 }, // 15
    { text: "you", start: 6.65, end: 6.8 }, // 16
    { text: "THIS.", start: 6.85, end: 7.3 }, // 17
  ],
};

test("cut specs read as clip:from-to, in order", () => {
  assert.deepEqual(parseSegments("c1:10-17, c1:0-1\nc2:4"), [
    { clip: "c1", from: 10, to: 17 },
    { clip: "c1", from: 0, to: 1 },
    { clip: "c2", from: 4, to: 4 },
  ]);
  assert.throws(() => parseSegments("c1:9-3"), /ends before it starts/);
  assert.throws(() => parseSegments("first take"), /not clip:from-to/);
});

test("a kept range loses its filler: the cut splits around it and the timeline closes the gap", () => {
  const { pieces, captions, duration } = buildEdit([clip], parseSegments("c1:0-8"));
  assert.equal(pieces.length, 2);
  // "So today," then "I want to show you this." — the "um" between them is gone.
  assert.equal(pieces[0]!.text, "So today,");
  assert.equal(pieces[1]!.text, "I want to show you this.");
  assert.equal(pieces[0]!.in, 0.44); // pad before the first word
  assert.ok(pieces[0]!.out <= 1.45 && pieces[1]!.in >= 1.45, "the two cuts never share the filler's sound");
  assert.equal(pieces[1]!.start, round(pieces[0]!.out - pieces[0]!.in));
  assert.equal(duration, round(pieces[0]!.out - pieces[0]!.in + pieces[1]!.out - pieces[1]!.in));
  assert.deepEqual(captions.map((w) => w.text), ["So", "today,", "I", "want", "to", "show", "you", "this."]);
  // Words move with their cut: "I" starts as far into the second cut as it did into the file.
  assert.equal(captions[2]!.start, round(pieces[1]!.start + (1.8 - pieces[1]!.in)));
});

test("only the chosen take is kept, long pauses are cut, and key words are flagged", () => {
  const { pieces, captions } = buildEdit([clip], parseSegments("c1:9-17"));
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0]!.start, 0);
  assert.equal(captions[0]!.start, 0.06);
  assert.equal(captions.at(-1)!.emphasis, true); // "THIS."
  assert.throws(() => buildEdit([clip], parseSegments("c1:15-30")), /words 0-17/);
  assert.throws(() => buildEdit([clip], parseSegments("c9:0-3")), /no clip 'c9'/);
});

test("back-to-back ranges of one take never repeat a sliver of sound", () => {
  const { pieces } = buildEdit([clip], parseSegments("c1:9-12, c1:13-17"));
  assert.equal(pieces.length, 2);
  assert.ok(pieces[1]!.in >= pieces[0]!.out);
});

test("the edit becomes video layers that parse, alternating the framing", () => {
  const { pieces } = buildEdit([clip], parseSegments("c1:0-8"), { ...DEFAULT_EDIT, punchIn: 1.1 });
  const layers = parseLines(footageLines(pieces, 1080, 1920, 1.1)) as Record<string, unknown>[];
  assert.equal(layers.length, 2);
  assert.equal(layers[0]!.type, "video");
  assert.equal(layers[0]!.group, "footage");
  assert.ok(!("scale" in layers[0]!) || layers[0]!.scale === undefined);
  assert.equal(JSON.stringify(layers[1]).includes("1.1"), true);
});

test("the transcript reads in numbered lines, with long pauses called out", () => {
  assert.deepEqual(transcriptLines(clip.words!), [
    '#0-8 0.50-3.30s "So today, um, I want to show you this." · pause 1.5s',
    '#9-17 4.80-7.30s "Okay so today I want to show you THIS."',
  ]);
});

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
