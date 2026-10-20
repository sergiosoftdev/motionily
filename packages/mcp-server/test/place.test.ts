import { test } from "node:test";
import assert from "node:assert/strict";
import { placeCenter, placementPatches } from "../src/place.js";

const card: [number, number, number, number] = [200, 400, 880, 700];

test("below and above sit gap px away, centered on the anchor", () => {
  assert.deepEqual(placeCenter({ side: "below", gap: 40 }, card, [400, 100]), [540, 790]);
  assert.deepEqual(placeCenter({ side: "above", gap: 20 }, card, [400, 100]), [540, 330]);
});

test("align moves the cross axis to the start or end edge", () => {
  assert.deepEqual(placeCenter({ side: "below", gap: 0, align: "start" }, card, [200, 80]), [300, 740]);
  assert.deepEqual(placeCenter({ side: "below", gap: 0, align: "end" }, card, [200, 80]), [780, 740]);
  assert.deepEqual(placeCenter({ side: "right", gap: 10, align: "start" }, card, [100, 50]), [940, 425]);
});

test("inside centers on the anchor", () => {
  assert.deepEqual(placeCenter({ side: "inside" }, card, [100, 100]), [540, 550]);
});

test("placement patches only the layers that moved, and keeps them on the frame", () => {
  const layers = [
    { id: "card", type: "shape", x: 540, y: 550, w: 680, h: 300, start: 0 },
    { id: "sub", type: "text", x: 0, y: 0, w: 400, h: 80, start: 1, place: { of: "card", side: "below", gap: 40 } },
    { id: "fixed", type: "shape", x: 100, y: 100, w: 10, h: 10, start: 0 },
  ];
  const boxAt = (id: string) => (id === "card" ? [200, 400, 880, 700] as [number, number, number, number] : id === "sub" ? [0, 0, 400, 80] as [number, number, number, number] : null);
  const patches = placementPatches(layers, boxAt, [1080, 1920]);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0]!.op, { op: "patch", id: "sub", fields: { x: 540, y: 780 } });
  // Already in place: nothing to do.
  const settled = [{ ...layers[1]!, x: 540, y: 780 }];
  assert.equal(placementPatches(settled, boxAt, [1080, 1920]).length, 0);
  // Past the bottom edge: clamped inside the frame.
  const low = [{ id: "sub", type: "text", x: 0, y: 0, w: 400, h: 80, start: 1, place: { of: "card", side: "below", gap: 2000 } }];
  assert.equal(placementPatches(low, boxAt, [1080, 1920])[0]!.y, 1920 - 40);
});
