import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.equal(d.fill, "#ff000080");
});

test("expressions, gradients, strokes, effects, repeaters, mattes and paths", () => {
  const bg = parseLine("bg ellipse 0 x=(420 + 60*sin(t*0.6)) y=260 w=1100 h=900 fill=#f7b9e0 soft=260 o=.85");
  assert.equal(bg.x, "420 + 60*sin(t*0.6)");
  assert.equal(bg.soft, 260);
  const card = parseLine("card rect .3 x=960 y=560 w=820 h=420 rad=32 fill=surface s=.9>1@0-.8:eo shadow=0,30,70,#ff6f91,.35 stroke=2:#ffd0dd");
  assert.deepEqual(card.scale, [{ t: 0, v: 0.9, ease: "expo_out" }, { t: 0.8, v: 1 }]);
  assert.deepEqual(card.effects, [{ fx: "shadow", x: 0, y: 30, blur: 70, color: "#ff6f91", opacity: 0.35 }]);
  assert.deepEqual(card.stroke, { width: 2, color: "#ffd0dd" });
  const title = parseLine('t text .6 x=960 y=900 w=1500 h=180 size=140 ls=-4 grad=lin:0:text@0,#ff3d5a@.45,#ffa23d@1 matte=mask "is the problem" {"animate":{"by":"char","from":{"y":70,"opacity":0}}}');
  assert.deepEqual(title.gradient, { kind: "linear", angle: 0, stops: [[0, "text"], [0.45, "#ff3d5a"], [1, "#ffa23d"]] });
  assert.equal(title.letter_spacing, -4);
  assert.deepEqual(title.matte, { layer: "mask" });
  assert.deepEqual((title.animate as { by: string }).by, "char");
  const link = parseLine('link path 1.2 stroke=3:text:10,10 te=0>1@0-.9:o glow=18,1.6,#ff6f3c blend=add "M330 260 C480 260 520 420 560 470"');
  assert.equal(link.d, "M330 260 C480 260 520 420 560 470");
  assert.deepEqual(link.stroke, { width: 3, color: "text", dash: [10, 10] });
  assert.equal(link.blend, "add");
  const dots = parseLine("dots ellipse 0 x=160 y=140 w=6 h=6 o=(0.12+0.1*sin(T*2+i)) rep=60:145,160:cols=12:delay=.02");
  assert.deepEqual(dots.repeat, { count: 60, x: 145, y: 160, columns: 12, delay: 0.02 });
  const mask = parseLine("mask rect 3.6 vis=0 x=960 y=900 w=1500 h=200 parent=cam pivot=10,-5");
  assert.equal(mask.visible, false);
  assert.deepEqual(mask.pivot, [10, -5]);
  assert.equal(mask.parent, "cam");
});

test("formatting is stable and round-trips the example scene", () => {
  const scene = JSON.parse(readFileSync(new URL("../../../examples/startup-look.scene.json", import.meta.url), "utf8")) as { layers: Record<string, unknown>[] };
  for (const layer of scene.layers) {
    const line = formatLayer(layer);
    const again = parseLine(line);
    assert.equal(formatLayer(again), line, `stable: ${line}`);
    // Defaults (x 0, scale 1…) are left out on purpose; everything else must survive.
    for (const [k, v] of Object.entries(layer)) if (v !== 0 && v !== 1) assert.ok(k in again, `${layer.id} keeps '${k}': ${line}`);
  }
  for (const l of parseLines("bar rect 0.2-3 g=hook x=540 y=980 w=0>800@0.1-0.6:o h=6 fill=#ff5a36\nt text 0 x=1 y=2 w=3 h=4 size=90 align=left \"Hola\"")) {
    assert.deepEqual(parseLine(formatLayer(l)), l);
  }
});

test("explains mistakes", () => {
  assert.throws(() => parseLine("a blob 0-1 w=1 h=1"), /unknown type/);
  assert.throws(() => parseLine("a rect 0-1 w=1"), /w and h/);
  assert.throws(() => parseLine("a rect 0-1 w=1 h=1 q=3"), /unknown key/);
  assert.throws(() => parseLine("p path 0 stroke=2:text"), /path data/);
  assert.throws(() => parseLine("a rect 0 w=1 h=1 x=(1+2"), /unbalanced/);
  assert.throws(() => parseLine("a rect 0 w=1 h=1 grad=lin:0:#fff"), /color@pos/);
});
