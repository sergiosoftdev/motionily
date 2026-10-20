## Writing layers — `add_layers` (one line per layer, never JSON)

```
id type start[-end] key=value… "text or path data" {optional JSON merged into the layer}
```
- types: `rect | ellipse | text | image | path | object | shader`. Scene pixels, origin top-left, y down, x/y = the layer's CENTER.
  `w` and `h` are required (not for path). `end` defaults to the end of the video. Same id again = that layer is replaced.
- frame size by format: 9:16 = 1080×1920 · 16:9 = 1920×1080 · 1:1 = 1080×1080 · 4:5 = 1080×1350.
- value of any animatable key: number · tween `from>to@t0-t1[:ease]` · keys `t:v[:ease],t:v,…` · `(expression)`.
  Times in tweens/keys are seconds from the layer's own start.
- eases: `l` linear · `i o io` ease in/out/in-out · `b` back (overshoot) · `h` hold · `eo ei eio` expo (eo = premium UI) ·
  `el` elastic · `bo` bounce. An ease sits on the key it leaves; default `io`. JSON keys also take `"bezier":[x1,y1,x2,y2]`.
- expressions: `(540 + 40*sin(t*2))` `(wiggle(2,8))` `(spring(t,2.2,7))` `(lerp(0,1,ease(t/0.6)))`.
  vars: `t` layer seconds, `T` scene seconds, `i`/`n` repeater copy index/count, `pi`.
  funcs: sin cos tan asin acos atan atan2 abs sign floor ceil round fract sqrt pow exp log min max clamp lerp mix
  smoothstep step mod noise(x) rand(x) wiggle(freq,amp[,seed]) ease ease_in ease_out back elastic bounce
  spring(t[,freq,damping]) pulse(x,period) saw tri · operators `+ - * / % ^ < >`.
  other layers: `(card.x)` `(card.y(T-0.15))` — props x y w h s r o of another layer, now or at a scene time (follow-through, echoes).

### Keys
| key | meaning |
| --- | --- |
| `x y w h` | center and size (px) |
| `s r o` | scale, rotation (degrees, clockwise), opacity 0..1 |
| `rad` | corner radius (rect) |
| `pivot=X,Y` | point (relative to the center) it rotates/scales around |
| `parent=ID` | inherits that layer's position/rotation/scale; x/y become relative to the parent's center |
| `g=NAME` | group (always set it: one group per visual unit, the user edits groups) |
| `vis=0` | not drawn itself (nulls, camera, matte sources) |
| `fill=` | palette slot `background|surface|primary|accent|text` or `#rrggbb[aa]`; color keys `fill=0:#ffffff,0.6:#ff3d5a:eo` |
| `grad=` | `lin:ANGLE:color@pos,…` · `rad:CX,CY:R:color@pos,…` · `con:CX,CY:ANGLE:color@pos,…` (conic; CX,CY 0..1 of the box; ≤ 4 stops; ANGLE may be `(t*90)`) |
| `stroke=W:COLOR[:DASH,GAP]` | outline (shapes) or line (paths) · `sgrad=` paints the stroke with a gradient |
| `soft=PX` | feathered edge: big soft ellipses = mesh-gradient backgrounds, glows |
| `shadow=X,Y,BLUR,COLOR[,OP]` | drop shadow (use a tinted color, low opacity, big blur) |
| `glow=RADIUS[,STRENGTH[,COLOR]]` | glow |
| `blur=PX` | gaussian blur |
| `mblur=SHUTTER°,SAMPLES` | motion blur on fast movers (`mblur=180,8`) |
| `color=HUE°,SAT,BRIGHT,CONTRAST` | color correction |
| `rgb=PX` | RGB split · `wave=AMP,WAVELENGTH,SPEED` warp · `grain=AMOUNT` |
| `turb=AMOUNT,CELL_PX,SPEED` | turbulent displacement (on huge soft blobs = liquid/cloud backgrounds) |
| `fx="WGSL" fx0=… fx7=` | custom shader effect (your own distortion/color/glitch; on `adj=1` a full-frame post effect or transition) — see Custom shaders |
| `blend=add|screen|multiply` | add = light (glows, trails, flares on dark) |
| `adj=1` | adjustment layer: its effects apply to everything below, inside its own shape (full-frame rect = whole picture) |
| `matte=ID[:inv|:luma|:lumainv]` | that layer's alpha/brightness masks this one (give the matte `vis=0`) |
| `inner=X,Y,BLUR,COLOR,OP` | inner shadow (light color + 0,0 = inner glow) — rect/ellipse |
| `sheen=AT,ANGLE,WIDTH,OP` | light sweep across the shape (animate AT 0>1) |
| `bevel=WIDTH,STRENGTH` | embossed plastic edge |
| `backdrop=BLUR` | frosted glass: blurs what is behind the shape (pair with a light translucent fill + thin stroke) |
| `rep=COUNT:DX,DY[:cols=N][:rot=DEG][:sc=K][:op=K][:delay=S]` | copies in a row/grid/radial burst; vary copies with `i` in expressions |
| `mp="M…" mpp=0>1@0-1.2:eio orient=1` | move along an SVG path (scene px; x/y add an offset; orient turns with it) |
| `time=(EXPR)` | time remap of the layer clock: `(mod(t,1.2))` loops, `(t*0.5)` slow motion, keys freeze/reverse |
| `z= rx= ry= persp= fixed=1 cam=` | world, camera and 3D planes — see below |

### Text
`id text START x= y= w= h= size= role=heading|body align=left|center|right lh= ls= "Just *ask.*"`
- ONE layer per phrase. Mark key words with `*word*` (colored with `accent=COLOR`, default the palette accent). Never split a
  phrase into word layers (they collide).
- `w`×`h` is the text box: the type shrinks until it fits. On a card, give the text the card's box minus ~8% padding.
- per-unit animation (JSON tail): `{"animate":{"by":"char|word|line","stagger":0.03,"duration":0.5,"delay":0,"ease":"expo_out","reverse":false,"from":{"x":0,"y":40,"scale":0.8,"rotation":0,"opacity":0,"blur":16}}}`
- text on a path: `tp="M-700 0 C-300 -250 300 250 700 0"` (relative to x,y) `tpo=OFFSET_PX` (animate to crawl along).
- counter: `count=0>12480@0-2:eo dec=0` with `{n}` in the text ("{n} users"); thousands separators are added.
- typewriter: `reveal=(max(0,(t-0.3)*16))` = characters typed (spaces not counted) · `caret=1` blinking caret.
- font: set_font picks any Google Font for the whole video; `role` picks the heading or body weight.

### Paths, icons, images, 3D objects
- path: `"SVG path data"` relative to x,y (M L H V C S Q T A Z; default x=y=0 = scene coordinates). `ts= te= to=` trim
  start/end/offset 0..1 (`te=0>1@0-.8:o` draws it on). `filled=1` fills closed subpaths with fill/grad.
  Morph (JSON): `{"morph":[{"t":0,"d":"M…"},{"t":0.8,"d":"M…","ease":"expo_in_out"}]}` (subpaths pair in order).
- icons: `id path START x= y= ic=NAME:SIZE stroke=2.5:text` — 1,900 Lucide line icons centered on x,y; `find_icons` finds names.
  Never hand-draw icons.
- image: `id image START x= y= w= h= src=/media/… fit=cover|contain rad=28` — src from get_brand; `contain` for logos
  (never crop them), `cover` for photos. Put screenshots on a card or a device frame built from shapes and walk through
  features by keying the image's scale/x/y while text explains them.
- 3D object inside the 2D frame: `id object START x= y= w= h= {"node":{…},"finish":"glossy|glass|chrome|matte|toon","spin":["t*40",0,0],"fov":28}`
  — a procedural 3D tree (see 3D) framed to fill the box; spin degrees x,y,z (numbers, keyframes or expression strings);
  effects, opacity and blend apply like any layer. Glossy app tiles, glass orbs, chrome rings/ribbons, 3D emoji.

<!-- custom-shaders:start -->
### Custom shaders (WGSL) — when nothing built in gives the look
You write ONE WGSL function; the engine runs it on the GPU for every pixel of every frame. Use it for procedural
backgrounds (aurora, mesh gradients, noise fields, light leaks), patterns, and your own distortions, glitches, grades and
transitions. Prefer a built-in key when one does the job (shorter, and it reads back as a key).

- **shader layer**: `id shader START[-END] x= y= w= h= [rad=] [o=] [fill=] [p0=… p7=] "WGSL"` — a rect box that your code
  fills. Every layer key works on it (s r o pivot parent anims z fixed rx/ry cam depth, effects, blend, matte, rep); `rad=`
  rounds its corners; `fill=` (or color keys) reaches the code as `tint`. grad/stroke/soft/inner/sheen/bevel do nothing.
- **shader effect**: `fx="WGSL" [fx0=… fx7=]` on ANY layer (text, image, group parent…): your code rewrites the layer's
  own pixels, read with `src(uv)`. On an adjustment layer (`adj=1`, usually a full-frame `fixed=1` rect) `src` is
  everything drawn below it, inside its box: a full-frame post effect or transition. One `fx=` per line; more in JSON.
- JSON: layer `{"type":"shader","code":"…","params":[0.5,"T*0.2",[{"t":0,"v":0},{"t":1,"v":1}]]}` · effect
  `{"fx":"shader","code":"…","params":[…]}`. Params are animatable values (number, keys, tween or expression with t, T, i, n).
- In a compact line the code is ONE JSON string in quotes: newlines as `\n`, quotes as `\"`, backslash `\\`. A `//`
  comment runs to the next `\n`, so end every comment with `\n` (or use `/* … */`).

**Your code** must define `fn shade(uv: vec2f, px: vec2f) -> vec4f` (helpers and `const`s around it are fine):
- shader layer: `uv` (0,0) = top-left corner of the box, (1,1) = bottom-right (y down); `px = uv * size`; `size` =
  the layer's `w,h` in its own px, unchanged by `s=`, parents and the camera (the pattern scales with the box, like an
  image). The box keeps its rotation and anti-aliased edge.
- shader effect: `uv` spans the WHOLE frame ((0,0) top-left); `px = uv * size`; `size` = frame size (1920×1080…), so `px`
  is scene px. `src(uv)` = the layer's pixels there; a layer with effects is drawn flat first, so on a tilted (`rx/ry`)
  layer `uv` is the flat layer's frame before projection.
- return straight (NOT premultiplied) sRGB: rgb 0..1 and alpha 0..1, clamped. Layer: final alpha = a × layer opacity
  (alpha 0 shows what is below; blend modes apply after). Effect: the result REPLACES that pixel; `return src(uv);`
  leaves it unchanged; return alpha too (`vec4f(rgb, c.a)`), or the pixel turns transparent.
- every frame is computed from scratch (any frame renders alone, in any order): animate with `t`, `T` and params.

**Prelude** (always available; never redeclare these names, `mly_*` is reserved):
| name | value |
| --- | --- |
| `t` `T` | f32: layer seconds (after `time=` remap) · scene seconds |
| `size` | vec2f: px that uv 0..1 spans (layer box w,h · effect: frame w,h) |
| `p0` … `p7` | f32: `p0=`…`p7=` (layer) or `fx0=`…`fx7=` (effect), sampled at `t`; unset = 0 |
| `background` `surface` `primary` `accent` `text` | vec4f: the palette, straight sRGB, alpha 1 |
| `tint` | vec4f: the layer's `fill` (default: the palette primary); effects get white |
| `zoom` | f32: screen px per layer px (layer: `s` × parents × camera depth; effect: camera depth, 1 when flat) — multiply px offsets in effects by it |
| `PI` `TAU` | 3.14159265 · 6.28318531 |
| `src(uv)` `src_pm(uv)` | effects only: the layer's pixel (straight / premultiplied), bilinear; uv outside 0..1 repeats the edge pixel |
| `hash11(x) hash21(v2) hash31(v3)` | f32 0..1 pseudo-random (deterministic); `hash22(v2)` vec2f 0..1 |
| `noise(v2) noise3(v3)` | smooth value noise 0..1, cell size 1 (animate: `noise3(vec3f(q, T))`) |
| `snoise(v2)` | 2D simplex noise -1..1 |
| `fbm(v2) fbm3(v3)` | 5 octaves of value noise, 0..1 (mean ≈ 0.5) |
| `rot2(a)` | mat2x2f: `rot2(a) * v` turns v by a radians clockwise on screen |
| `wrap(x, y)` | floor modulo for f32, 0..y (WGSL has no `mod`; `%` truncates) |
| `sd_circle(p, r)` `sd_box(p, half)` `sd_round_box(p, half, r)` `sd_segment(p, a, b)` | signed distance (px if p is px; < 0 inside) |
| `smin(a, b, k)` `smax(a, b, k)` | smooth union / intersection of distances, blend width k |
| `fill(d)` | anti-aliased coverage 0..1 of a distance (1 inside) · `stroke(d, w)` = a line of width w along d = 0 |
| `cos_palette(x, a, b, c, d)` | `a + b*cos(TAU*(c*x + d))` (vec3f) |
| `luma(rgb)` `hsv2rgb(hsv)` `rgb2hsv(rgb)` | Rec.709 luma; hue/sat/value all 0..1 |
| `over(top, below)` | straight-alpha "over" of two vec4f colors |

**WGSL, not GLSL**: `f32 i32 vec2f vec3f vec4f mat2x2f`; `let` is constant, `var` is mutable; `1` is i32 and `1.0` f32 and
they never mix (`f32(i)`); `select(if_false, if_true, cond)` instead of `?:`; `atan2(y, x)`; `fract mix clamp smoothstep
step length dot normalize abs sin cos pow exp fwidth` as usual; swizzles `c.rgb`, `p.yx`. No textures besides `src`.

**Limits (enforced, the op is rejected)**: code ≤ 8192 bytes · ≤ 8 params · loops only as
`for (var i = 0; i < N; i++)` with N a number or `const` (also `<= > >=`, `i--`, `i += K`, `i *= K`), ≤ 64 iterations
each and ≤ 256 nested (product) · no `while`/`loop`, `@group`/`@binding`/`@vertex`/`@fragment`, `var<uniform|storage|workgroup>`,
directives. Cost: a full-frame shader with a few `fbm` calls is fine; avoid more than ~4 full-frame shaders at once.

**Errors** come back as the op error, and nothing in that call is applied:
`shader layer 'aurora': WGSL line 3:14: no definition in scope for identifier: 'nois' (unknown identifier)` — line 1 is
the first line of your code string (count `\n`s). Fix that line and resend the line.

**Measuring**: `get_layout`, selection and review checks see the shader layer's box (like a rect: it may bleed off frame
as a background, and text crossing its edge is flagged), not what your alpha paints; effect displacement is not
measured. `review_video` lists any custom shader that cannot draw.

**Order on a layer**: `fx=` and `blur=` run first, in the order written; then `shadow=` (under), `color= rgb= wave=
grain= turb=` (at composite), `glow=` (over). Adjustment layers act on what is listed BEFORE them (with a camera: drawn
before them — keep them `fixed=1` and last).

Recipes (copy, then change colors and numbers; frame 1920×1080):
```
aurora shader 0 x=960 y=540 w=1920 h=1080 fixed=1 p0=0.25 "fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let q = px / size.y;\n  let n = fbm3(vec3f(q * 1.6, T * p0));\n  let m = fbm3(vec3f(q * 2.3 + n, T * p0 * 0.7 + 5.0));\n  var c = mix(background.rgb, primary.rgb, smoothstep(0.35, 0.75, n));\n  c = mix(c, accent.rgb, smoothstep(0.5, 0.85, m) * 0.6);\n  return vec4f(c, 1.0);\n}"
grain rect 0 x=960 y=540 w=1920 h=1080 fixed=1 adj=1 fx0=0.07 fx="fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let c = src(uv);\n  let g = hash21(floor(px) + floor(T * 24.0) * 17.0) - 0.5;\n  let v = 1.0 - 0.35 * dot(uv - 0.5, uv - 0.5);\n  return vec4f((c.rgb + g * p0 * (1.2 - luma(c.rgb))) * v, c.a);\n}"
leak shader 0 x=960 y=540 w=1920 h=1080 fixed=1 blend=screen o=.85 "fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let c = vec2f(0.1 + 0.8 * fract(T * 0.06), 0.25);\n  let d = length((uv - c) * vec2f(size.x / size.y, 1.0));\n  let flicker = 0.8 + 0.2 * noise(vec2f(T * 3.0, 0.0));\n  let warm = mix(vec3f(1.0, 0.45, 0.15), vec3f(1.0, 0.85, 0.55), smoothstep(0.0, 0.7, d));\n  return vec4f(warm, exp(-d * d * 3.0) * flicker);\n}"
liquid text 1 x=960 y=540 w=1400 h=220 size=160 role=heading fx0=26>0@0-1.4:eo fx="fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let q = px / 150.0;\n  let n = vec2f(snoise(q + T * 0.5), snoise(q + 17.0 - T * 0.5));\n  return src(uv + n * p0 * zoom / size);\n}" "Liquid"
wipe rect 3.5-4.5 x=960 y=540 w=1920 h=1080 fixed=1 adj=1 fx0=0>1@0-1:io fx="fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let a = vec2f(size.x / size.y, 1.0);\n  let r = length((uv - 0.5) * a) / length(0.5 * a);\n  let grow = clamp(p0 * 2.0, 0.0, 1.0);\n  let hole = clamp(p0 * 2.0 - 1.0, 0.0, 1.0);\n  let ink = fill(r - grow) * (1.0 - fill(r - hole));\n  return mix(src(uv), primary, ink);\n}"
glitch rect 5.8-6.3 x=960 y=540 w=1920 h=1080 fixed=1 adj=1 fx0=(1 - t/0.5) fx="fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let k = clamp(p0, 0.0, 1.0);\n  let band = floor(uv.y * 24.0) + floor(T * 30.0) * 7.0;\n  let jump = step(0.7, hash11(band)) * (hash11(band + 3.1) - 0.5) * 0.12 * k;\n  let q = vec2f(uv.x + jump, uv.y);\n  let s = 0.006 * k;\n  let c = src(q);\n  return vec4f(src(q + vec2f(s, 0.0)).r, c.g, src(q - vec2f(s, 0.0)).b, c.a);\n}"
badge shader .5 x=1500 y=300 w=320 h=320 s=0>1@0-.6:b fill=accent "fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let p = px - size * 0.5;\n  let d = smin(sd_circle(p, 110.0), sd_circle(p - vec2f(70.0 * sin(t * 2.0), 0.0), 60.0), 40.0);\n  let ring = stroke(sd_circle(p, 140.0 + 6.0 * sin(t * 3.0)), 4.0);\n  return vec4f(tint.rgb, max(fill(d), ring * 0.6));\n}"
```
- aurora: drifting two-layer fbm mesh in the palette (`p0` = flow speed). grain: animated film grain stronger in the
  shadows plus a soft vignette over everything below. leak: warm light sweeping across, screen-blended. liquid: text
  wobbling like liquid that settles (`fx0` = px of displacement). wipe: radial transition — a primary disk grows over the
  outgoing shot until the cut at 4.0 s (cut your layers' start/end there), then opens from the center onto the new one.
  glitch: 0.5 s of band jumps and RGB split fading out. badge: metaball blob + pulsing ring drawn with SDFs in `fill`.
<!-- custom-shaders:end -->

## World, camera and depth — exact rules
Trust these formulas; `get_layout` prints the resulting screen boxes if you want numbers. Never render test shapes to find out.

**Camera.** One layer with `cam=FOCAL[,FOCUS_Z,APERTURE]` (give it `vis=0 w=1 h=1`) is the camera, for the whole film:
- its `x,y` = the world point shown at the frame center (pan = animate x/y) · its `z` = dolly D (+ = flies forward) ·
  its `s` multiplies the focal (zoom): F = FOCAL × s. Its rotation is ignored (no roll).
- FOCAL 1800 is a natural lens on 1080p (wider: 1200; telephoto: 3000).

**Depth.** Every layer has depth Z = its `z` + its parents' `z` (+ = farther). With a camera, a non-fixed layer is drawn:
- at scale **k = F / (F + Z − D)**, at **screen = frame center + (point − camera x,y) × k**;
- not at all once F + Z − D ≤ 1 (the camera flew past it).
- Consequences: a layer at Z = D is at its real size exactly where its x,y say (relative to the camera's x,y). To frame a
  beat region at (X, Y, Z), key the camera to x=X y=Y z=Z. A layer twice as far (F + Z − D doubled) is half size and
  moves half as much when the camera pans (parallax). Example, F=1800 and the camera dollies z 0>2400: a card at z=2400
  goes from k=0.43 to k=1; a layer at z=0 is behind the camera once D ≥ 1800 (put intro layers that must vanish there).
- Draw order with a camera: far to near (bigger Z first); equal Z keep list order. Without a camera: list order (first = back).
- `fixed=1` ignores camera and depth (full-frame backgrounds, grain/grade adjustment layers, HUD).
- Without a camera layer nothing moves in depth, except layers with z≠0, scaled around the frame center with F=1800.
- Depth of field: APERTURE A>0 blurs each layer by A·|Z − FOCUS_Z|/1000 × k screen px (planes: without the × k).

**Tilted planes.** `rx=DEG` (top leans back; 50-65 = a floor/table seen from above) and/or `ry=DEG` (right side goes away)
turn a layer into a plane, usually an invisible null (`vis=0 w=1 h=1`):
- the plane and every layer parented to it (any depth) are drawn flat in the plane's space (children x/y relative to the
  plane's center, their own z ignored), then projected together. Children keep their own effects, blends and mattes.
- its center lands on screen where a flat layer with the same x,y,Z would, then the page tilts around it. Keep the
  center inside the region the camera frames (a plane centered at y=1900 in a 1080-high frame is mostly off screen).
- with a camera the plane uses the camera's lens (`persp` is ignored); without one, `persp=PX` (default 1800) is its lens.
- planes do not nest: rx/ry on a layer inside another plane is ignored.

**Camera nulls without a camera layer.** `cam rect 0 vis=0 x=0 y=0 w=1 h=1 pivot=CX,CY s=1>1.06@0-6:io` with
`parent=cam` on the other layers keeps their absolute x/y and gives a slow push-in around the frame center (animate the
null's x/y/r for pans and tilts). Prefer a real camera layer for depth and parallax.

## Recipes (copy and adapt)
```
cam rect 0 vis=0 w=1 h=1 cam=1800 x=0:960,2.2:2900:eio,4.4:2900 y=540 z=0:0,2.2:600:eio s=1>1.04@0-6:io
bg rect 0 x=960 y=540 w=1920 h=1080 fixed=1 grad=lin:90:#f6f4f1@0,#e9eef5@1
bg_a ellipse 0 x=(420+60*sin(t*0.6)) y=(260+40*cos(t*0.5)) w=1100 h=900 fill=#f7b9e0 soft=260 o=.85 z=900
card rect .3 x=960 y=560 w=820 h=420 rad=32 fill=surface s=.92>1@0-.7:eo o=0>1@0-.3 stroke=2:#ffd0dd shadow=0,30,70,#ff6f91,.35
key text 3.6 x=960 y=900 w=1500 h=180 size=140 role=heading ls=-4 grad=lin:0:text@0,text@.4,#ff3d5a@.46,#ffa23d@1 "is the problem" {"animate":{"by":"char","stagger":0.035,"from":{"y":70,"opacity":0,"scale":0.8}}}
link path 1.2 stroke=3:text:10,10 te=0>1@0-.9:o "M330 260 C480 260 520 420 560 470"
trail path 1.8 stroke=4:#ff8a5b ts=(max(0,(t-0.4)*1.4)) te=(min(1,t*1.6)) glow=18,1.6,#ff6f3c blend=add "M560 470 C600 520 640 560 700 560"
dots ellipse 0 x=160 y=140 w=6 h=6 fill=text o=(0.12+0.1*sin(T*2+i*0.7)) rep=60:145,160:cols=12
arrow path .4 fill=primary filled=1 mp="M150 900 C600 150 1200 1050 1750 250" mpp=0>1@0-1.2:eio orient=1 mblur=180,8 "M30 0 L-20 -16 L-12 0 L-20 16 Z"
pulse ellipse 0 x=1500 y=300 w=40 h=40 fill=accent time=(mod(t,1.4)) s=1>2.4@0-1.2:eo o=.6>0@0-1.2:o
echo rect 1 x=(card.x(T-0.12)) y=(card.y(T-0.12)) w=820 h=420 rad=32 fill=#ffffff40
plane rect 0 vis=0 x=2900 y=560 w=1 h=1 z=600 rx=58>40@0-2.4:eo ry=-12
ui rect 0 parent=plane x=0 y=0 w=900 h=560 rad=28 fill=surface shadow=0,40,80,#2b3a5a,.25
border rect 1 x=960 y=540 w=760 h=120 rad=60 fill=#00000000 stroke=3:#ffffff sgrad=con:0.5,0.5:(t*90):#e87c3d@0,#ecc6ae@0.3,#343640@0.6,#e87c3d@1 glow=24,1.2
typed text 1.2 x=960 y=540 w=640 h=60 size=34 align=left fill=#ffffff reveal=(max(0,(t-0.3)*16)) caret=1 "Provide complex widgets"
fluid ellipse 0 x=520 y=320 w=1200 h=900 fill=#ff6a2b soft=320 turb=150,400,0.5
grade rect 0 x=960 y=540 w=1920 h=1080 fixed=1 adj=1 grain=.04 color=0,1.05,0,1.04
glitch rect 5.8-6.2 x=960 y=540 w=1920 h=1080 fixed=1 adj=1 rgb=8 wave=6,120,3 grain=.06
tile object .5 x=1500 y=420 w=260 h=260 s=0>1@0-.6:b {"node":{"shape":"box","size":[1,1,0.3],"radius":0.22,"color":"#57a0db"},"finish":"glossy","spin":["10*sin(t)","t*40",0]}
```
