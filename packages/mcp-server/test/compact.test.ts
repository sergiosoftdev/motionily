import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLayer, parseLine, parseLines } from "../src/compact.js";

test("parses tweens, keys, colors and text", () => {
  const l = parseLine('hook_w1 text 0-3 g=hook x=540 y=420>380@0-.4:b w=900 h=180 o=0>1@0-.3 size=140 fill=text "Tu \\"agenda\\""');
  assert.equal(l.type, "text");
  assert.equal(l.text, 'Tu "agenda"');
  assert.deepEqual(l.y, [{ t: 0, v: 420, ease: "back" }, { t: 0.4, v: 380 }]);
  assert.equal(l.group, "hook");
  const d = parseLine("dot ellipse 1-3 x=300 y=600 w=40 h=40 s=0:0,.3:1.2:b,.5:1 fill=#ff000080");
  assert.equal(d.shape, "ellipse");
  assert.deepEqual(d.scale, [{ t: 0, v: 0 }, { t: 0.3, v: 1.2, ease: "back" }, { t: 0.5, v: 1 }]);
  assert.deepEqual(d.fill, [1, 0, 0, 0.502]);
});

test("round-trips through the formatter", () => {
  const lines = "bar rect 0.2-3 g=hook x=540 y=980 w=0>800@0.1-0.6:o h=6 fill=#ff5a36\nt text 0 x=1 y=2 w=3 h=4 size=90 align=left \"Hola\"";
  for (const l of parseLines(lines)) assert.deepEqual(parseLine(formatLayer(l)), l);
});

test("explains mistakes", () => {
  assert.throws(() => parseLine("a blob 0-1 w=1 h=1"), /unknown type/);
  assert.throws(() => parseLine("a rect 0-1 w=1"), /w and h/);
  assert.throws(() => parseLine("a rect 0-1 w=1 h=1 q=3"), /unknown key/);
});
