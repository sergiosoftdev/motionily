import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatLayer, formatParams, parseLine, parseLines, parseParams, parsePartial } from "../src/compact.js";

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

test("reads gradients, strokes, effects, repeaters and mattes back in short form", () => {
  const line =
    'card rect 0.3 x=960 y=560 w=820 h=420 grad=rad:0.3,0.2:1.2:#ffffff@0,surface@1 stroke=2:#ffd0dd:6,4 shadow=0,30,70,#ff6f91,0.35 glow=18,1.6 blur=4 rep=3:0,40:op=0.5 matte=mask:inv pivot=10,-5';
  const out = formatLayer(parseLine(line));
  assert.ok(!out.includes("{"), `no JSON tail: ${out}`);
  assert.deepEqual(parseLine(out), parseLine(line));
  // Two shadows have no line form: they stay in JSON, still round-tripping.
  const two = parseLine('a rect 0 w=1 h=1 {"effects":[{"fx":"shadow","y":4},{"fx":"shadow","y":40}]}');
  assert.deepEqual(parseLine(formatLayer(two)), two);
});

test("color keys, motion paths, text on paths, time remap and the new effects", () => {
  const line =
    'rocket path 0.3 fill=0:#ff4d6d:eo,1.5:primary mp="M150 900 C600 150 1200 1050 1750 250" mpp=0>1@0-1.4 orient=1 time=(mod(t, 2)) mblur=360,12 rgb=4 grain=0.08 wave=10,180,1 color=40,1.4,0,1 adj=1 matte=m:luma "M40 0 L-30 -24 L-30 24 Z"';
  const l = parseLine(line);
  assert.deepEqual(l.fill, [{ t: 0, c: "#ff4d6d", ease: "expo_out" }, { t: 1.5, c: "primary" }]);
  assert.deepEqual(l.motion_path, { d: "M150 900 C600 150 1200 1050 1750 250", progress: [{ t: 0, v: 0, ease: "ease_in_out" }, { t: 1.4, v: 1 }], orient: true });
  assert.equal(l.time, "mod(t, 2)");
  assert.deepEqual(l.matte, { layer: "m", mode: "luma" });
  assert.equal((l.effects as unknown[]).length, 5);
  const out = formatLayer(l);
  assert.ok(!out.includes("{"), `no JSON tail: ${out}`);
  assert.deepEqual(parseLine(out), l);
  const t = parseLine('t text 0 w=1600 h=200 size=84 tp="M-750 120 C-350 -260 350 360 750 -60" tpo=-1700>0@0-1.6:eo "Sigue el trazado"');
  assert.deepEqual(t.path, { d: "M-750 120 C-350 -260 350 360 750 -60", offset: [{ t: 0, v: -1700, ease: "expo_out" }, { t: 1.6, v: 0 }] });
  assert.deepEqual(parseLine(formatLayer(t)), t);
  assert.throws(() => parseLine("a rect 0 w=1 h=1 mpp=0>1@0-1"), /mp=/);
});

test("3D layers, conic outline gradients, turbulence, counters and typewriters", () => {
  const plane = parseLine("plane rect 0 vis=0 x=1360 y=600 w=1 h=1 rx=55>38@0-2.5:eo ry=-12 z=600>0@0-2.5:eo persp=1600");
  assert.deepEqual(plane.rotate_x, [{ t: 0, v: 55, ease: "expo_out" }, { t: 2.5, v: 38 }]);
  assert.equal(plane.perspective, 1600);
  const box = parseLine("box rect 0 w=760 h=120 rad=36 fill=#14112b stroke=3:#ffffff sgrad=con:0.5,0.5:(t*120):#ff9a3c@0,#a855ff@0.5,#ff9a3c@1 turb=40,300,0.5");
  assert.deepEqual(box.stroke, {
    width: 3,
    color: "#ffffff",
    gradient: { kind: "conic", center: [0.5, 0.5], angle: "t*120", stops: [[0, "#ff9a3c"], [0.5, "#a855ff"], [1, "#ff9a3c"]] },
  });
  const typed = parseLine('typed text 0 w=600 h=60 size=34 reveal=(max(0,(t-0.4)*16)) caret=1 "Provide complex widgets"');
  assert.equal(typed.reveal, "max(0,(t-0.4)*16)");
  const num = parseLine('n text 0 w=600 h=100 size=90 count=0>12480@0-2:eo dec=1 "{n} users"');
  assert.equal(num.decimals, 1);
  for (const l of [plane, box, typed, num]) {
    const out = formatLayer(l);
    assert.ok(!out.includes("{\""), `no JSON tail: ${out}`);
    assert.deepEqual(parseLine(out), l);
  }
});

test("camera, depth, materials and glass", () => {
  const cam = parseLine("cam rect 0 vis=0 x=960 y=300>700@0-4:eio z=-400>500@0-4:eio w=1 h=1 cam=1600,0,14");
  assert.deepEqual(cam.camera, { focal: 1600, focus: 0, aperture: 14 });
  const glass = parseLine("glass rect 0 x=960 y=540 z=-200 w=760 h=440 rad=40 fill=#ffffff1f backdrop=28 inner=0,2,6,#ffffff,0.35 sheen=0>1@0-2,20,0.12,0.35 bevel=6,0.3 fixed=1");
  assert.deepEqual(glass.inner, { x: 0, y: 2, blur: 6, color: "#ffffff", opacity: 0.35 });
  for (const l of [cam, glass]) {
    const out = formatLayer(l);
    assert.ok(!out.includes('{"'), `no JSON tail: ${out}`);
    assert.deepEqual(parseLine(out), l);
  }
});

test("camera roll, animated lens and 3D object lights", () => {
  const cam = parseLine("cam rect 0 vis=0 w=1 h=1 x=960 y=540 r=0:0,0.4:-14:eo,0.8:0 cam=1800");
  assert.deepEqual(cam.rotation, [{ t: 0, v: 0 }, { t: 0.4, v: -14, ease: "expo_out" }, { t: 0.8, v: 0 }]);
  const plane = parseLine("plane rect 0 vis=0 x=960 y=540 w=1 h=1 ry=30 persp=600>2400@0-2:eo");
  assert.deepEqual(plane.perspective, [{ t: 0, v: 600, ease: "expo_out" }, { t: 2, v: 2400 }]);
  const chrome = parseLine(
    'ring object 0 x=960 y=540 w=500 h=500 light=-70,25,#fff1e0,1.4 {"node":{"shape":"torus","radius":0.5,"tube":0.16},"finish":"chrome","lights":{"ambient":{"intensity":0.6}}}',
  );
  assert.deepEqual(chrome.lights, { key: { azimuth: -70, elevation: 25, color: "#fff1e0", intensity: 1.4 }, ambient: { intensity: 0.6 } });
  const turning = parseLine('sun object 0 w=400 h=400 light=0>360@0-6:l,40 {"node":{"shape":"sphere","radius":0.5}}');
  assert.deepEqual((turning.lights as { key: { azimuth: unknown } }).key.azimuth, [{ t: 0, v: 0, ease: "linear" }, { t: 6, v: 360 }]);
  const warm = parseLine('w object 0 w=400 h=400 light=30,60,#ff8a3d {"node":{"shape":"box","size":[1,1,1]},"lights":{"key":{"azimuth":10}}}');
  assert.deepEqual(warm.lights, { key: { azimuth: 10 } }, "a JSON key light wins over light=");
  for (const l of [cam, plane, chrome, turning]) {
    const out = formatLayer(l);
    assert.deepEqual(parseLine(out), l, out);
    assert.equal(formatLayer(parseLine(out)), out);
  }
  const ring = formatLayer(chrome);
  assert.ok(ring.includes("light=-70,25,#fff1e0,1.4") && ring.includes('"lights":{"ambient":{"intensity":0.6}}'), ring);
  // Engine read-back fills the key's defaults: they are left out of the short form.
  const back = formatLayer({ id: "o", type: "object", w: 10, h: 10, lights: { key: { azimuth: 35, elevation: 50, color: "#ffffff", intensity: 1 } } });
  assert.ok(back.includes("light=35,50") && !back.includes("lights"), back);
  assert.ok(formatLayer({ id: "o", type: "object", w: 10, h: 10, lights: {} }).includes('{"lights":{}}'), "lights on with every default stays explicit");
  assert.throws(() => parseLine("o object 0 w=1 h=1 light=40"), /at least 2/);
});

test("explains mistakes", () => {
  assert.throws(() => parseLine("a blob 0-1 w=1 h=1"), /unknown type/);
  assert.throws(() => parseLine("a rect 0-1 w=1"), /w and h/);
  assert.throws(() => parseLine("a rect 0-1 w=1 h=1 q=3"), /unknown key/);
  assert.throws(() => parseLine("p path 0 stroke=2:text"), /path data/);
  assert.throws(() => parseLine("a rect 0 w=1 h=1 x=(1+2"), /unbalanced/);
  assert.throws(() => parseLine("a rect 0 w=1 h=1 grad=lin:0:#fff"), /color@pos/);
});

test("icons expand to centered paths and read back by name", () => {
  const l = parseLine("bell path 1 x=300 y=200 ic=bell:48");
  assert.equal(l.icon, "bell:48");
  assert.match(String(l.d), /^M/);
  assert.deepEqual(l.stroke, { width: 4, color: "text" });
  const out = formatLayer(l);
  assert.ok(out.includes("ic=bell:48") && !out.includes('"M'), out);
  assert.deepEqual(parseLine(out), l);
  assert.throws(() => parseLine("x path 0 ic=not-an-icon"), /unknown icon/);
});

test("text3d lines are object layers with one text node, and read back as text3d", () => {
  const l = parseLine('logo text3d .2 x=960 y=540 w=900 h=300 depth=0.3 family="Space Grotesk" weight=700 ls=-0.02 finish=chrome spin=0,(20*sin(t)),0 fill=#c9e3f2 g=end "Lumen"');
  assert.equal(l.type, "object");
  assert.deepEqual(l.node, { shape: "text", text: "Lumen", depth: 0.3, family: "Space Grotesk", weight: 700, letter_spacing: -0.02 });
  assert.equal(l.finish, "chrome");
  assert.deepEqual(l.spin, [0, "20*sin(t)", 0]);
  assert.equal(l.letter_spacing, undefined, "text keys move onto the node");
  const back = formatLayer({ ...l, fov: 28 });
  assert.match(back, /^logo text3d 0\.2 g=end /);
  assert.deepEqual(parseLine(back), l);
  // What the engine writes back (every default filled in) still reads as a short text3d line.
  const engine = { ...l, fov: 28, spin: [0, 0, 0], node: { ...(l.node as object), size: 1, align: "center", line_height: 1.2, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } };
  assert.equal(formatLayer(engine), 'logo text3d 0.2 g=end x=960 y=540 w=900 h=300 fill=#c9e3f2 finish=chrome depth=0.3 family="Space Grotesk" weight=700 ls=-0.02 "Lumen"');
});

test("object layers take finish, spin (keys with ;) and fov", () => {
  const o = parseLine('tile object 0 x=500 y=500 w=200 h=200 finish=glass spin=0:0:eo,0.5:45,1:90;0;(t*40) fov=40 {"node":{"shape":"sphere","radius":0.5}}');
  assert.deepEqual(o.spin, [[{ t: 0, v: 0, ease: "expo_out" }, { t: 0.5, v: 45 }, { t: 1, v: 90 }], 0, "t*40"]);
  assert.equal(o.fov, 40);
  const back = formatLayer(o);
  assert.match(back, / finish=glass spin=0:0:eo,0\.5:45,1:90;0;\(t\*40\) fov=40 /);
  assert.deepEqual(parseLine(back), o);
  assert.match(formatLayer(parseLine("t object 0 w=1 h=1 spin=0>90@0-1:eo,0,0")), / spin=0>90@0-1:eo,0,0/);
  assert.throws(() => parseLine("x object 0 w=1 h=1 finish=gold"), /finish is/);
  assert.throws(() => parseLine("x text3d 0 w=1 h=1"), /needs its "text"/);
});
// ---- particles: begin ----
test("particles: emitters, physics, looks and over-life values parse and read back", () => {
  const sparks = parseLine("sparks particles 1-4 g=fx x=960 y=900 rate=0:0,.2:300,.6:0 life=.4..1 speed=600..1100 dir=-80 spread=70 grav=0,1400 drag=1.2 look=streak trail=.05 size=3 alpha=0:1,1:0 colors=#ffffff,#ffd27a,accent blend=add glow=18,1.5");
  assert.equal(sparks.type, "particles");
  assert.deepEqual(sparks.rate, [{ t: 0, v: 0 }, { t: 0.2, v: 300 }, { t: 0.6, v: 0 }]);
  assert.deepEqual(sparks.life, [0.4, 1]);
  assert.deepEqual(sparks.speed, [600, 1100]);
  assert.equal(sparks.direction, -80);
  assert.deepEqual(sparks.gravity, [0, 1400]);
  assert.equal(sparks.look, "streak");
  assert.equal(sparks.size, 3);
  assert.deepEqual(sparks.alpha, [[0, 1], [1, 0]]);
  assert.deepEqual(sparks.colors, ["#ffffff", "#ffd27a", "accent"]);
  assert.equal(sparks.blend, "add");
  const confetti = parseLine("confetti particles 2.4 emit=rect x=540 y=-40 w=1080 h=10 burst=0:180,.4:60 life=3..4.5 speed=200..900 dir=90 spread=40 grav=0,700 drag=.8 look=rect aspect=.5 size=0:6,.2:14,1:12 size_var=.3 angle=0..360 spin=-240..240 flip=.6..1.6 seed=4 max=400");
  assert.equal(confetti.emit, "rect");
  assert.deepEqual(confetti.bursts, [{ at: 0, count: 180 }, { at: 0.4, count: 60 }]);
  assert.deepEqual(confetti.size, [[0, 6], [0.2, 14], [1, 12]]);
  assert.deepEqual(confetti.flip, [0.6, 1.6]);
  assert.equal(confetti.max, 400);
  const flow = parseLine('flow particles 0 emit="M100 500 C400 200 700 800 1000 500" follow=1 out=1 rate=4 life=2.5 speed=0 wander=6,80,.5 color_life=0:#ffffff,1:accent');
  assert.equal(flow.emit, "path");
  assert.equal(flow.emit_d, "M100 500 C400 200 700 800 1000 500");
  assert.equal(flow.follow, true);
  assert.equal(flow.outward, true);
  assert.deepEqual(flow.wander, { amount: 6, size: 80, speed: 0.5 });
  assert.deepEqual(flow.color_life, [[0, "#ffffff"], [1, "accent"]]);
  const hearts = parseLine("hearts particles 0 x=540 y=1500 rate=6 ic=heart size=28 filled=1 align=1 space=local");
  assert.equal(hearts.icon, "heart");
  assert.match(String(hearts.d), /^M/);
  assert.equal(hearts.filled, true);
  assert.equal(hearts.space, "local");
  const drawn = parseLine('stars particles 0 rate=6 "M0 -10 L3 -3 L10 0 L3 3 L0 10 L-3 3 L-10 0 L-3 -3 Z" filled=1');
  assert.equal(drawn.d, "M0 -10 L3 -3 L10 0 L3 3 L0 10 L-3 3 L-10 0 L-3 -3 Z");
  const logos = parseLine("logos particles 0 rate=3 src=/media/logo.png size=64 prewarm=2");
  assert.equal(logos.src, "/media/logo.png");
  assert.equal(logos.prewarm, 2);
  for (const l of [sparks, confetti, flow, hearts, drawn, logos]) {
    const out = formatLayer(l);
    assert.ok(!out.includes('{"'), `no JSON tail: ${out}`);
    assert.deepEqual(parseLine(out), l, out);
  }
});

test("particles: engine read-back leaves defaults out", () => {
  const engine = {
    id: "dust",
    type: "particles",
    start: 0,
    x: 540,
    y: 960,
    w: 1080,
    h: 1920,
    soft: 3,
    fill: "#fff7e0",
    emit: "rect",
    rate: 12,
    prewarm: 8,
    life: [6, 9],
    speed: [4, 16],
    spread: 360,
    wander: { amount: 40, size: 260, speed: 0.3 },
    alpha: [[0, 0], [0.05, 1], [0.7, 1], [1, 0]],
    size: 6,
  };
  const out = formatLayer(engine);
  assert.equal(out, "dust particles 0 x=540 y=960 w=1080 h=1920 soft=3 fill=#fff7e0 emit=rect rate=12 life=6..9 speed=4..16 spread=360 prewarm=8 wander=40,260,0.3 size=6");
  const back = parseLine(out);
  assert.equal(back.alpha, undefined, "the default alpha stays implicit");
  assert.deepEqual({ ...back, alpha: engine.alpha }, engine);
});

test("particles: explains mistakes", () => {
  assert.throws(() => parseLine("p particles 0 x=1"), /rate= and\/or burst/);
  assert.throws(() => parseLine("p particles 0 emit=rect w=10 rate=5"), /needs h=/);
  assert.throws(() => parseLine("p particles 0 emit=line rate=5"), /needs w=/);
  assert.throws(() => parseLine("p particles 0 emit=path rate=5"), /emit=path/);
  assert.throws(() => parseLine("p particles 0 emit=blob rate=5"), /emit is point\|line\|rect\|circle\|path/);
  assert.throws(() => parseLine("p particles 0 rate=5 look=blob"), /look is/);
  assert.throws(() => parseLine("p particles 0 rate=5 look=image"), /needs src=/);
  assert.throws(() => parseLine("p particles 0 rate=5 life=1..2..3"), /MIN..MAX/);
  assert.throws(() => parseLine("p particles 0 rate=5 size=0:1:2"), /AGE:VALUE/);
  assert.throws(() => parseLine("p particles 0 burst=1"), /AT:COUNT/);
  assert.throws(() => parseLine("p particles 0 rate=5 follow=1"), /follow=1/);
  assert.throws(() => parseLine("p particles 0 rate=5 grav=900"), /X,Y/);
});
// ---- particles: end ----

// ── components ──
test("component definitions: $params as whole values, in expressions and inside text", () => {
  const lines = [
    "card rect 0 w=$w h=240 rad=32 fill=surface shadow=0,24,60,$accent,.16 vis=$show",
    "chip rect .1 x=(-$w/2+70) y=-55 w=72 h=72 rad=22 fill=$accent",
    'glyph path .15 x=(-$w/2+70) y=-55 stroke=2.5:#ffffff "$icon"',
    'label text .2 x=40 y=-55 w=($w-140) h=40 size=$size align=left fill=text "${title} ($$)"',
    'num text .3 y=40 w=($w-60) h=96 size=80 count=($value*ease_out(min(1,t/1.2))) dec=$dec caret=$typing "{n}$unit"',
  ];
  const layers = parseLines(lines.join("\n"));
  assert.equal(layers[0]!.w, "$w");
  assert.equal(layers[0]!.visible, "$show");
  assert.deepEqual(layers[0]!.effects, [{ fx: "shadow", x: 0, y: 24, blur: 60, color: "$accent", opacity: 0.16 }]);
  assert.equal(layers[1]!.x, "-$w/2+70");
  assert.equal(layers[2]!.d, "$icon");
  assert.equal(layers[3]!.size, "$size");
  assert.equal(layers[3]!.text, "${title} ($$)");
  assert.equal(layers[4]!.decimals, "$dec");
  assert.equal(layers[4]!.caret, "$typing");
  for (const l of layers) {
    const out = formatLayer(l);
    assert.ok(!out.includes('{"'), `no JSON tail: ${out}`);
    assert.deepEqual(parseLine(out), l, out);
  }
  assert.throws(() => parseLine("g path 0 ic=$icon:40"), /path param/);
});

test("instances: use lines with comp= and $param=value read back the same", () => {
  const l = parseLine(
    's1 use 0.3 comp=stat x=360 y=540 s=.9>1@0-.6:eo g=stats $title="Monthly revenue" $value=12480 $accent=#ff5a36 $icon=ic:trending-up:40 $show=false $grow=0>1@0-1.2:eo $wob=(sin(t*3)*4)',
  );
  assert.equal(l.type, "use");
  assert.equal(l.comp, "stat");
  assert.equal(l.w, undefined, "instances need no w/h");
  const params = l.params as Record<string, unknown>;
  assert.equal(params.title, "Monthly revenue");
  assert.equal(params.value, 12480);
  assert.equal(params.accent, "#ff5a36");
  assert.equal(params.show, false);
  assert.deepEqual(params.grow, [{ t: 0, v: 0, ease: "expo_out" }, { t: 1.2, v: 1 }]);
  assert.equal(params.wob, "sin(t*3)*4");
  const icon = params.icon as { ic: string; d: string };
  assert.equal(icon.ic, "trending-up:40");
  assert.match(icon.d, /^M/);
  const out = formatLayer(l);
  assert.ok(out.startsWith("s1 use 0.3 comp=stat g=stats") && out.includes("$icon=ic:trending-up:40") && !out.includes('{"'), out);
  assert.deepEqual(parseLine(out), l);
  // The engine serializes an instance with w/h 0 and the default fill: read back without that noise.
  assert.equal(formatLayer({ ...l, w: 0, h: 0, fill: "primary" }), out);
  // Bare words stay strings (colors, sources, words); numbers stay numbers.
  const b = parseLine("b use 0-4 comp=pill $label=Nuevo $bg=primary $src=/media/a.png $n=-2 $q=3D");
  assert.deepEqual(b.params, { label: "Nuevo", bg: "primary", src: "/media/a.png", n: -2, q: "3D" });
  assert.deepEqual(parseLine(formatLayer(b)), b);
  assert.throws(() => parseLine("b use 0"), /comp=NAME/);
  assert.throws(() => parseLine('b use 0 comp=pill "hola"'), /param/);
  assert.throws(() => parseLine("b rect 0 w=1 h=1 $x=1"), /only use lines/);
});

test("define_component params parse and format back", () => {
  const text = 'title:text="Monthly revenue" value:number=12480 unit:text icon:path=ic:trending-up:40 accent:color=accent show:bool=1 grow:number=0>1@0-1:eo';
  const params = parseParams(text);
  assert.deepEqual(params.slice(0, 3), [
    { name: "title", type: "text", default: "Monthly revenue" },
    { name: "value", type: "number", default: 12480 },
    { name: "unit", type: "text" },
  ]);
  assert.equal(params[5]!.default, true);
  assert.deepEqual(parseParams(formatParams(params)), params);
  assert.throws(() => parseParams("title:string"), /unknown param type/);
  assert.throws(() => parseParams("title"), /name:type/);
});
// ---- custom shaders ----
test("shader layers and shader effects parse and read back", () => {
  const code = "fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  // \"quoted\" comment\n  return vec4f(uv, p2, 1.0);\n}";
  const l = parseLine(`sky shader 0-4 x=960 y=540 w=1920 h=1080 fixed=1 p0=(T*0.2) p2=0>1@0-2:eo ${JSON.stringify(code)}`);
  assert.equal(l.type, "shader");
  assert.equal(l.code, code);
  assert.deepEqual(l.params, ["T*0.2", 0, [{ t: 0, v: 0, ease: "expo_out" }, { t: 2, v: 1 }]]);
  const line = formatLayer(l);
  assert.ok(line.startsWith("sky shader 0-4 ") && line.includes("p0=(T*0.2) p1=0 p2=0>1@0-2:eo") && line.endsWith("}\""), line);
  assert.deepEqual(parseLine(line), l);

  const fx = "fn shade(uv: vec2f, px: vec2f) -> vec4f { return src(uv + vec2f(p1, 0.0) / size); }";
  const t = parseLine(`title text 1 x=960 y=540 w=1400 h=200 size=150 blur=4 fx1=(t*8) fx=${JSON.stringify(fx)} grain=.05 "Liquid"`);
  assert.equal(t.text, "Liquid");
  assert.deepEqual(t.effects, [{ fx: "blur", radius: 4 }, { fx: "shader", code: fx, params: [0, "t*8"] }, { fx: "grain", amount: 0.05 }]);
  const back = formatLayer(t);
  assert.ok(back.includes(`fx=${JSON.stringify(fx)} fx0=0 fx1=(t*8)`), back);
  assert.deepEqual(parseLine(back), t);

  // Two shader effects (or bezier params) have no line form: they stay exact in the JSON tail.
  const two = { ...t, effects: [{ fx: "shader", code: fx }, { fx: "shader", code: fx, params: [1] }] };
  assert.deepEqual(parseLine(formatLayer(two)), two);
  const bez = { ...l, params: [[{ t: 0, v: 0, bezier: [0.2, 0, 0, 1] }, { t: 1, v: 1 }]] };
  assert.deepEqual(parseLine(formatLayer(bez)), bez);

  assert.throws(() => parseLine("s shader 0 w=10 h=10 p0=1"), /WGSL in quotes/);
  assert.throws(() => parseLine("c rect 0 w=10 h=10 fx0=1"), /fx="fn shade/);
  assert.throws(() => parseLine('c rect 0 w=10 h=10 p0=1 fx="fn shade(uv: vec2f, px: vec2f) -> vec4f { return src(uv); }"'), /fx0=/);
  assert.throws(() => parseLine("c rect 0 w=10 h=10 fx=src"), /quoted WGSL/);
});

test("every custom shader recipe in the manual parses and reads back unchanged", () => {
  const doc = readFileSync(new URL("../../../docs/agent/syntax.md", import.meta.url), "utf8");
  const block = doc.split("<!-- custom-shaders:start -->")[1]!.split("<!-- custom-shaders:end -->")[0]!;
  const lines = block.split("```")[1]!.split("\n").filter((x) => x.trim());
  assert.equal(lines.length, 7);
  for (const layer of parseLines(lines.join("\n"))) {
    const shaders = [layer.code, ...((layer.effects as { code?: string }[] | undefined) ?? []).map((e) => e.code)].filter(Boolean);
    assert.equal(shaders.length, 1, String(layer.id));
    assert.deepEqual(parseLine(formatLayer(layer)), layer);
  }
});
// ---- end custom shaders ----
// --- video clips and audio-reactive expressions ---
test("video layers parse their clip keys and read back", () => {
  const l = parseLine(
    "clip video .5-6 g=demo x=540 y=900 w=860 h=1520 rad=36 src=/media/0f8c2a1e-1111-4222-8333-944455556666.mp4 fit=cover in=2 out=7.5 speed=0.5 loop=1 volume=0.4 s=1>1.06@0-5.5:io",
  );
  assert.equal(l.type, "video");
  assert.equal(l.src, "/media/0f8c2a1e-1111-4222-8333-944455556666.mp4");
  assert.deepEqual([l.in, l.out, l.speed, l.loop, l.volume, l.fit], [2, 7.5, 0.5, true, 0.4, "cover"]);
  const out = formatLayer(l);
  assert.ok(/ in=2 out=7.5 speed=0.5 volume=0.4 loop=1/.test(out) && !out.includes("{"), out);
  assert.deepEqual(parseLine(out), l);
  // Defaults the engine leaves out read back short.
  const plain = formatLayer({ id: "v", type: "video", src: "/media/x.mp4", fit: "contain", start: 0, w: 100, h: 100, in: 0, speed: 1 });
  assert.equal(plain, "v video 0 w=100 h=100 src=/media/x.mp4 fit=contain");
  assert.throws(() => parseLine("img image 0 w=1 h=1 src=/media/x.png in=2"), /only for video/);
});

test("audio-reactive expressions pass through as strings", () => {
  const eq = parseLine("bar rect 0 x=(140+i*80) y=1500 w=56 h=(40+520*spec(i/n)) fill=accent rep=12:80,0");
  assert.equal(eq.h, "40+520*spec(i/n)");
  const cap = parseLine('cap text 0 x=540 y=1500 w=900 h=160 size=90 s=(1+0.08*vol) o=(0.6+0.4*beat) "Hola"');
  assert.equal(cap.scale, "1+0.08*vol");
  assert.ok(formatLayer(cap).includes("s=(1+0.08*vol) o=(0.6+0.4*beat)"));
});
// --- end video clips ---

// ── partial edits (edit_layers) ──
test("partial lines change only the keys written, merge strokes and replace one effect kind", () => {
  const card = parseLine("card rect 1-5 g=cards x=500 y=400 w=300 h=200 rad=12 fill=surface stroke=2:#ffffff sgrad=lin:0:#000000@0,#ffffff@1 shadow=0,20,40,#000000,.3 glow=10,1,#ff0000");
  const f = parsePartial("fill=accent rad=40 stroke=4:#111111 shadow=0,30,60,#1b2a4a,.2 t=2-6", card);
  assert.equal(f.fill, "accent");
  assert.equal(f.radius, 40);
  assert.deepEqual([f["stroke.width"], f["stroke.color"]], [4, "#111111"], "the stroke gradient is kept");
  assert.deepEqual((f.effects as { fx: string }[]).map((e) => e.fx), ["glow", "shadow"], "glow kept, shadow replaced");
  assert.deepEqual([f.start, f.end], [2, 6]);
  assert.equal(f.w, undefined, "w and h untouched");
  const title = parseLine('title text 0 x=1 y=1 w=10 h=10 size=40 "Hello"');
  assert.deepEqual(parsePartial('"Clear day" size=80', title), { text: "Clear day", size: 80 });
  assert.throws(() => parsePartial("", title), /nothing to change/);
});

test("glow threshold and spring ease parse and read back", () => {
  const l = parseLine("dot rect 0-2 x=540 y=540 w=40 h=40 y=0>540@0-.8:sp glow=60,1,,0.7");
  assert.deepEqual(l.y, [{ t: 0, v: 0, ease: "spring" }, { t: 0.8, v: 540 }]);
  assert.deepEqual(l.effects, [{ fx: "glow", radius: 60, strength: 1, threshold: 0.7 }]);
  const back = formatLayer(l);
  assert.match(back, /glow=60,1,,0\.7/);
  assert.match(back, /:sp/);
});

test("place= and @reference times parse; bad ones name the fix", () => {
  const l = parseLine("sub text @phrase:2+0.2-@word:ready w=300 h=80 place=below:card,gap=40,align=start fill=on_primary \"Hi\"");
  assert.equal(l.start, "@phrase:2+0.2");
  assert.equal(l.end, "@word:ready");
  assert.deepEqual(l.place, { of: "card", side: "below", gap: 40, align: "start" });
  assert.equal(l.fill, "on_primary");
  assert.throws(() => parseLine("a rect 0-2 w=10 h=10 place=under:card"), /above\|below\|left\|right\|inside/);
  assert.throws(() => parseLine("a rect @phrase:x w=10 h=10"), /bad time reference/);
});

test("glass= parses into a liquid glass effect on an adjustment layer and reads back", () => {
  const l = parseLine("lens rect 0-6 x=540 y=960 w=760 h=440 rad=120 glass=60,120,8,1.5,0.01,1,#cfe9ff");
  assert.equal(l.adjustment, true);
  assert.deepEqual(l.effects, [{ fx: "glass", thickness: 60, bevel: 120, blur: 8, ior: 1.5, dispersion: 0.01, specular: 1, tint: "#cfe9ff" }]);
  const back = formatLayer(l);
  assert.match(back, /glass=60,120,8,1\.5,0\.01,1,#cfe9ff/);
  assert.throws(() => parseLine("lens rect 0-6 w=10 h=10 glass=60"), /glass=THICKNESS,BEVEL,BLUR/);
});
