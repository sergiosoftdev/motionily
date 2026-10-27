// Run: pnpm --filter @motionily/web test (node's own runner, types stripped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { angleTime, createMulticamOps, freshGroup, multicamAt, switchAngleOps, type MulticamClip } from "../src/editor/edit/multicam.ts";

// Cam A rolled first; cam B 2.5 s later (its file second 0 is cam A's 2.5), cam C 1 s before A.
const clip: MulticamClip = {
  id: "ft1",
  start: 10,
  end: 20,
  in: 5,
  speed: 1,
  src: "/media/a.mp4",
  multicam: { group: "mc1", angle: 0, angles: [{ src: "/media/a.mp4", offset: 0, name: "Wide" }, { src: "/media/b.mp4", offset: -2.5 }, { src: "/media/c.mp4", offset: 1 }] },
};

test("angles show the same moment", () => {
  assert.equal(angleTime(clip, 1, 10), 2.5);
  assert.equal(angleTime(clip, 2, 14), 10);
  // From a piece already on angle B, back to A.
  const onB = { ...clip, in: 2.5, src: "/media/b.mp4", multicam: { ...clip.multicam, angle: 1 } };
  assert.equal(angleTime(onB, 0, 12), 7);
});

test("switching cuts at the playhead and points the rest at the other camera", () => {
  const ops = switchAngleOps(clip, 2, 13, 25, "ft1_2");
  assert.deepEqual(ops, [
    { op: "split_layer", id: "ft1", at: 13, new_id: "ft1_2" },
    { op: "patch", id: "ft1_2", fields: { src: "/media/c.mp4", in: 9, out: 16, multicam: { ...clip.multicam, angle: 2 } } },
  ]);
  // At the clip's start (within half a frame) the whole clip switches.
  const whole = switchAngleOps(clip, 1, 10.01, 25, "x");
  assert.deepEqual(whole, [{ op: "patch", id: "ft1", fields: { src: "/media/b.mp4", in: 2.5, out: 12.5, multicam: { ...clip.multicam, angle: 1 } } }]);
  assert.deepEqual(switchAngleOps(clip, 0, 12, 25, "x"), [], "already on that angle");
});

test("a camera that was not rolling cannot be switched to", () => {
  const early = { ...clip, in: 1 };
  assert.throws(() => switchAngleOps(early, 1, 10, 25, "x"), /Angle 2 has no picture from 10 to 20 s/);
  assert.throws(() => switchAngleOps(clip, 2, 12, 25, "x", () => 12), /no picture/, "its file ends too soon");
  assert.throws(() => switchAngleOps(clip, 5, 12, 25, "x"), /has 3 angles/);
});

test("making a clip multicam moves its sound under it; the clip under the playhead", () => {
  const ops = createMulticamOps({ id: "ft1", src: "/media/a.mp4", start: 10, end: 20, in: 5, out: null, speed: 1, volume: 0.8 }, [{ src: "/media/b.mp4", offset: -2.5004, name: "B" }], { group: "mc2", audioId: "snd1", size: [1080, 1920] });
  assert.deepEqual(ops[0], { op: "patch", id: "ft1", fields: { multicam: { group: "mc2", angle: 0, angles: [{ src: "/media/a.mp4", offset: 0 }, { src: "/media/b.mp4", offset: -2.5, name: "B" }] }, volume: 0 } });
  assert.deepEqual((ops[1] as { layer: Record<string, unknown> }).layer, { id: "snd1", type: "audio", start: 10, end: 20, x: 540, y: 960, w: 2, h: 2, src: "/media/a.mp4", in: 5, out: 15, speed: 1, volume: 0.8 });
  const layers = [{ id: "bg", type: "rect" }, { id: "ft1", type: "video", src: "/media/a.mp4", start: 10, end: 20, in: 5, multicam: clip.multicam }];
  assert.equal(multicamAt(layers, 15, 30)?.id, "ft1");
  assert.equal(multicamAt(layers, 20, 30), null);
  assert.equal(freshGroup(layers), "mc2");
});
