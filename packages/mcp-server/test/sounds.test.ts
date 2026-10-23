import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSounds, parseCue, type LibrarySound } from "../src/sounds.js";

const sound = (s: Partial<LibrarySound> & { name: string }): LibrarySound => ({
  category: "Risers",
  description: s.name,
  duration: 3,
  peak: 2.5,
  shape: "build",
  hits: [],
  every: null,
  url: `/sounds/${s.name}/audio`,
  ...s,
});
const library = new Map(
  [
    sound({ name: "riser" }),
    sound({ name: "shutter", category: "Camera", duration: 19, peak: 8.5, shape: "swell", hits: [1.2, 3.8, 5.5] }),
    sound({ name: "clock", category: "Mechanical", duration: 78, peak: 10, shape: "steady", hits: [0.1, 1.35, 2.6, 3.85], every: 1.25 }),
  ].map((s) => [s.name, s]),
);

test("add_sfx lines: at, gain, hit= lands the peak, from=/len= play a moment", () => {
  assert.deepEqual(parseCue("a riser 4 0.3", library, 0.45), { cue: { id: "a", sound: "riser", src: "/sounds/riser/audio", at: 4, gain: 0.3 } });
  const hit = parseCue("b riser hit=6", library, 0.45);
  assert.ok("cue" in hit && hit.cue.at === 3.5 && hit.cue.gain === 0.45);
  // One click of a long recording: its peak inside from…from+len is the listed hit.
  const click = parseCue("c shutter hit=10 from=3.7 len=0.5 0.6", library, 0.45);
  assert.ok("cue" in click && click.cue.from === 3.7 && click.cue.len === 0.5 && click.cue.gain === 0.6 && Math.abs(click.cue.at - 9.9) < 1e-9);
  // A long sound without len= gets a warning, not a refusal.
  const loop = parseCue("d clock 2", library, 0.45);
  assert.ok("cue" in loop && loop.warning?.includes("len="));
});

test("add_sfx lines: refuses what cannot play", () => {
  assert.ok("error" in parseCue("a nope 1", library, 0.45));
  assert.ok("error" in parseCue("a riser hit=1", library, 0.45), "a peak 2.5 s in cannot land at 1 s");
  assert.ok("error" in parseCue("a riser 1 from=9", library, 0.45), "from past the end");
  assert.ok("error" in parseCue("a riser 1 len=0", library, 0.45));
  assert.ok("error" in parseCue("a riser soon", library, 0.45));
});

test("list_sounds groups by category and shows how each sound moves", () => {
  const out = formatSounds([...library.values()]);
  assert.match(out, /^## Risers\nriser \| 3s \| build, peak 2.5s \| riser$/m);
  assert.match(out, /clock \| 78s \| steady, peak 10s, hits every 1.25s from 0.1s/);
  assert.match(out, /shutter \| 19s \| swell, peak 8.5s, hits at 1.2, 3.8, 5.5/);
  assert.match(formatSounds([...library.values()], "camera"), /^## Camera\nshutter/);
  assert.match(formatSounds([...library.values()], "Drums"), /Categories: Risers, Camera, Mechanical/);
});
