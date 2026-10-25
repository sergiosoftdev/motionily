import { test } from "node:test";
import assert from "node:assert/strict";
import { syncOffset } from "../src/editor/edit/audioSync.ts";

const RATE = 16000;

/** Speech-like sound: bursts of noisy tone with pauses, seeded so both "mics" hear the same performance. */
function performance(seconds: number, seed = 7): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out = new Float32Array(seconds * RATE);
  let i = 0;
  while (i < out.length) {
    const on = Math.round((0.15 + rnd() * 0.5) * RATE);
    const off = Math.round((0.05 + rnd() * 0.4) * RATE);
    const f = 120 + rnd() * 200;
    for (let j = 0; j < on && i < out.length; j++, i++) out[i] = Math.sin((2 * Math.PI * f * i) / RATE) * (0.3 + 0.3 * rnd()) * Math.sin((Math.PI * j) / on);
    i += off;
  }
  return out;
}

test("finds where a recorder's sound lines up with the camera's, to the millisecond", () => {
  const show = performance(40);
  // The camera rolled 3.217 s into the performance and hears it through room noise, quieter.
  const lead = Math.round(3.217 * RATE);
  const camera = new Float32Array(20 * RATE).map((_, i) => 0.4 * show[i + lead]! + (Math.random() - 0.5) * 0.05);
  // The recorder started at the performance's start and records it clean.
  const m = syncOffset(camera, show, RATE);
  assert.ok(Math.abs(m.offset - 3.217) < 0.002, `offset ${m.offset}`);
  assert.ok(m.score > 0.5 && m.margin > 1.2, `score ${m.score} margin ${m.margin}`);
});
