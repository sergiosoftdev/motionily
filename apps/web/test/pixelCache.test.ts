import { test } from "node:test";
import assert from "node:assert/strict";
import { PixelCache } from "../src/engine/pixelCache.ts";

const px = (bytes: number) => Promise.resolve({ rgba: new Uint8Array(bytes), width: 1, height: 1 });

test("decoded images stay within the budget, least recently used out first", async () => {
  const cache = new PixelCache(250);
  let loads = 0;
  const get = (key: string) => cache.get(key, () => (loads++, px(100)));
  await get("a");
  await get("b");
  await get("a"); // a is now the most recent
  assert.equal(loads, 2, "a hit is not decoded again");
  await get("c"); // 300 bytes: b (least recent) goes
  await get("a");
  assert.equal(loads, 3, "a survived");
  await get("b");
  assert.equal(loads, 4, "b was evicted and decodes again");
});

test("an image bigger than the budget is still handed out, and does not stay", async () => {
  const cache = new PixelCache(50);
  let loads = 0;
  const big = await cache.get("big", () => (loads++, px(100)));
  assert.equal(big?.rgba.byteLength, 100);
  await cache.get("small", () => (loads++, px(10)));
  await cache.get("big", () => (loads++, px(100)));
  assert.equal(loads, 3);
});
