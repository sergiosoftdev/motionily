import { test } from "node:test";
import assert from "node:assert/strict";
import { measuredPauses } from "../src/voice.js";

const words = [
  { text: "fifteen.", start: 11.76, end: 12.56 },
  { text: "So", start: 14.59, end: 14.64 },
  { text: "who", start: 14.88, end: 15.04 },
];

test("pauses come from the measured sound, placed through the voice's cuts", () => {
  // The file is silent from 12.4 to 14.43 ("So" is heard 0.16 s before its timing says).
  const scene = { audio: { start: 0, trim_in: 0, trim_out: null } };
  const [p] = measuredPauses(scene, [[12.4, 14.43]], words, 0.6);
  assert.deepEqual([p!.from, p!.to, p!.before, p!.after], [12.4, 14.43, "fifteen.", "So"]);
  // After a cut inside that silence, the two halves meet on the video: still one pause, now 0.6 s.
  const cut = { audio: { start: 0, trim_in: 0, trim_out: null, cuts: [[12.6, 14.03]] } };
  const halves = measuredPauses(cut, [[12.4, 14.43]], words, 0.3);
  assert.equal(halves.length, 1);
  assert.ok(Math.abs(halves[0]!.to - halves[0]!.from - 0.6) < 1e-9);
  // Silence before the first word or after the last is not a pause.
  assert.equal(measuredPauses(scene, [[0, 0.9], [15.1, 16]], words, 0.6).length, 0);
});
