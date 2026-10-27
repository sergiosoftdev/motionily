// Run: pnpm --filter @motionily/web test (node's own runner, types stripped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDropFrame, parseTimecode, timecode } from "../src/time/timecode.ts";

const NTSC = 30000 / 1001;

test("non-drop timecode at whole rates", () => {
  assert.equal(timecode(0, 30), "00:00:00:00");
  assert.equal(timecode(5 + 12 / 30, 30), "00:00:05:12");
  assert.equal(timecode(3725 + 10 / 25, 25), "01:02:05:10");
  assert.equal(isDropFrame(30), false);
});

test("drop-frame at 29.97 skips ;00 and ;01 each minute but every tenth", () => {
  assert.equal(isDropFrame(NTSC), true);
  const at = (frame: number) => timecode(frame / NTSC, NTSC);
  assert.equal(at(1799), "00:00:59;29");
  assert.equal(at(1800), "00:01:00;02", "the first frame of minute 1 is ;02");
  assert.equal(at(17982), "00:10:00;00", "minute 10 keeps ;00");
  assert.equal(at(107892), "01:00:00;00", "an hour of frames reads an hour");
});

test("what people type: timecode, right-filled digits, seconds, relative frames", () => {
  assert.equal(parseTimecode("00:00:05:12", 30), 5 + 12 / 30);
  assert.equal(parseTimecode("5:12", 30), 5 + 12 / 30, "the last field is frames");
  assert.equal(parseTimecode("512", 30), 5 + 12 / 30, "digits fill from the right, like an NLE");
  assert.equal(parseTimecode("1000000", 30), 3600, "01:00:00:00");
  assert.equal(parseTimecode("5.4", 30), 5.4, "a decimal point means seconds");
  assert.equal(parseTimecode("+10", 30, 2), 2 + 10 / 30, "frames forward from the playhead");
  assert.equal(parseTimecode("-90", 30, 1), 0, "never before the start");
  assert.equal(parseTimecode("00:00:01:45", 30), null, "frames past the rate");
  assert.equal(parseTimecode("soon", 30), null);
});

test("drop-frame timecode reads back to the same frame", () => {
  for (const frame of [0, 1799, 1800, 1801, 17981, 17982, 54321, 107892]) {
    const t = frame / NTSC;
    assert.equal(Math.round(parseTimecode(timecode(t, NTSC), NTSC)! * NTSC), frame, `frame ${frame} (${timecode(t, NTSC)})`);
  }
});
