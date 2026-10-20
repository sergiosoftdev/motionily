import { test } from "node:test";
import assert from "node:assert/strict";
import { phrasesOf, resolveRef, resolveLayerTimes, type Word } from "../src/timing.js";

const words: Word[] = [
  { text: "Your", start: 0.1, end: 0.3 },
  { text: "agenda,", start: 0.35, end: 0.8 },
  { text: "always", start: 1.4, end: 1.8 }, // 0.6 s silence: new phrase
  { text: "ready.", start: 1.85, end: 2.3 },
  { text: "Now", start: 3.0, end: 3.2 }, // 0.7 s silence: new phrase
];

test("phrases split at silences of 0.25 s or more", () => {
  const p = phrasesOf(words);
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((x) => x.words.length), [2, 2, 1]);
});

test("@phrase:N counts from 1 and takes an offset", () => {
  assert.equal(resolveRef("@phrase:2", words), 1.4);
  assert.ok(Math.abs(resolveRef("@phrase:2+0.2", words) - 1.6) < 1e-9);
  assert.throws(() => resolveRef("@phrase:9", words), /has 3 phrases/);
});

test("@word:TEXT ignores case and punctuation", () => {
  assert.equal(resolveRef("@word:agenda", words), 0.35);
  assert.equal(resolveRef("@word:READY", words), 1.85);
  assert.throws(() => resolveRef("@word:nope", words), /not in the voice/);
});

test("references in layers become seconds; plain numbers are untouched", () => {
  const layers = [{ id: "a", start: "@phrase:3", end: 5 }, { id: "b", start: "@word:ready", end: "@word:ready+0.5" }];
  resolveLayerTimes(layers, words);
  assert.equal(layers[0]!.start, 3.0);
  assert.equal(layers[1]!.start, 1.85);
  assert.ok(Math.abs((layers[1]!.end as number) - 2.35) < 1e-9);
});

test("without a voice, references explain how to proceed", () => {
  assert.throws(() => resolveRef("@phrase:1", []), /no voice/);
});
