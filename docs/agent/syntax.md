## Writing layers — `add_layers` (one line per layer, never JSON)

```
id type start[-end] key=value… "text or path data" {optional JSON merged into the layer}
```
- types: `rect | ellipse | text | image | video | path | object | text3d | particles | use | shader` (`use` = a component
  instance, see Components; `shader` = custom WGSL, see Custom shaders; `video` = a clip, see Video clips). Scene pixels,
  origin top-left, y down, x/y = the layer's CENTER.
  `w` and `h` are required (not for path). `end` defaults to the end of the video. Same id again = that layer is replaced.
- frame size by format: 9:16 = 1080×1920 · 16:9 = 1920×1080 · 1:1 = 1080×1080 · 4:5 = 1080×1350.
- value of any animatable key: number · tween `from>to@t0-t1[:ease]` · keys `t:v[:ease],t:v,…` · `(expression)`.
  Times in tweens/keys are seconds from the layer's own start.
- eases: `l` linear · `i o io` ease in/out/in-out · `b` back (overshoot) · `h` hold · `eo ei eio` expo (eo = premium UI) ·
  `el` elastic · `bo` bounce · `sp` spring (real damped spring released at rest: ~23% overshoot, settles inside the segment; use for physical pops and drops). An ease sits on the key it leaves; default `io`. `h` holds the value until the next key (a jump). JSON keys
  `{"t":0,"v":0,"ease":"hold"}`; `"bezier":[x1,y1,x2,y2]` on a key = CSS cubic-bezier to the next key, overriding its ease.
- expressions: `(540 + 40*sin(t*2))` `(wiggle(2,8))` `(spring(t,2.2,7))` `(lerp(0,1,ease(t/0.6)))`.
  vars: `t` layer seconds, `T` scene seconds, `i`/`n` repeater copy index/count, `pi`, `$name` a component's number
  param (inside components; elsewhere it reads 0).
  funcs: sin cos tan asin acos atan atan2 abs sign floor ceil round fract sqrt pow exp log min max clamp lerp mix
  smoothstep step mod noise(x) rand(x) wiggle(freq,amp[,seed]) ease ease_in ease_out ease_in_out expo_in expo_out
  expo_in_out linear back elastic bounce (easing functions take 0..1 progress, e.g. `(expo_out(min(1,t/0.8)))`)
  spring(t[,freq,damping]) pulse(x,period) saw tri · operators `+ - * / % ^ < >`.
  other layers: `(card.x)` `(card.y(T-0.15))` — props x y w h s r o of another layer, now or at a scene time (follow-through, echoes).
  audio: `vol bass mid high beat beats spec(k)` — see "Audio-reactive expressions".

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
| `solo=1` | while any layer is solo, ONLY solo layers render (preview and export); their parents, matte sources, the camera and `adj=1` layers above them keep working. The user's switch: leave it unless asked (the summary says when solo is on) |
| `lock=1` `shy=1` | the user's editor switches (locked = not selectable; shy = hidden in the timeline). No render effect; leave them |
| `fill=` | palette slot `background|surface|primary|accent|text`, or `on_background|on_surface|on_primary|on_accent` (white, near-black or the palette text, whichever reads best on that slot: WCAG), or `#rrggbb[aa]`; color keys `fill=0:#ffffff,0.6:#ff3d5a:eo` |
| `place=SIDE:ID[,gap=PX][,align=start\|center\|end]` | sit against layer ID: SIDE is above, below, left, right or inside; gap in px; align sets the cross-axis edge (start/end). The tools resolve it into x and y (centers) and redo it after each write that moves ID. Not with `parent=` |
| `grad=` | `lin:ANGLE:color@pos,…` · `rad:CX,CY:R:color@pos,…` · `con:CX,CY:ANGLE:color@pos,…` (conic; CX,CY 0..1 of the box; ≤ 4 stops; ANGLE may be `(t*90)`) |
| `stroke=W:COLOR[:DASH,GAP]` | outline (shapes) or line (paths) · `sgrad=` paints the stroke with a gradient |
| `soft=PX` | feathered edge: big soft ellipses = mesh-gradient backgrounds, glows |
| `shadow=X,Y,BLUR,COLOR[,OP]` | drop shadow (use a tinted color, low opacity, big blur) |
| `glow=RADIUS[,STRENGTH[,COLOR[,THRESHOLD]]]` | glow. THRESHOLD (0-1 luma) makes a bloom: only pixels brighter than it glow, so light reads as light instead of a haze over the whole layer (`glow=60,1,,0.7` on a white dot) |
| `blur=PX` | gaussian blur. Effects (`shadow glow blur mblur color rgb wave grain turb fx`) run in the order written, like AE's effect stack |
| `mblur=SHUTTER°,SAMPLES` | motion blur on fast movers (`mblur=180,8`) |
| `color=HUE°,SAT,BRIGHT,CONTRAST` | color correction. The full grade is JSON: `{"fx":"color","exposure":0.3,"temperature":0.4,"tint":0,"contrast":1.1,"shadows":0.2,"highlights":-0.3,"saturation":1,"vibrance":0.3,"hue":0,"vignette":0.3}` — exposure in stops; temperature −1 cool..1 warm; tint −1 green..1 magenta; shadows/highlights/vibrance −1..1; vignette 0..1 (screen corners). Order: exposure, white balance, brightness, contrast, shadows, highlights, saturation, vibrance, hue, vignette. Every field optional and animatable; two color effects add up. On a clip it grades the clip; on `adj=1` the picture below |
| `rgb=PX` | RGB split · `wave=AMP,WAVELENGTH,SPEED` warp · `grain=AMOUNT` |
| `turb=AMOUNT,CELL_PX,SPEED` | turbulent displacement (on huge soft blobs = liquid/cloud backgrounds) |
| `fx="WGSL" fx0=… fx7=` | custom shader effect (your own distortion/color/glitch; on `adj=1` a full-frame post effect or transition) — see Custom shaders |
| `blend=MODE` | normal, add (light), screen, multiply, darken, lighten, difference, exclusion, overlay, soft_light, hard_light, color_dodge, color_burn, linear_burn, hue, saturation, color, luminosity. Modes after multiply read what is below (one extra copy of the scene per layer): use them for texture, tint and grade, not on every layer |
| `adj=1` | adjustment layer: its effects apply to everything below, inside its own shape (full-frame rect = whole picture) |
| `matte=ID[:inv|:luma|:lumainv]` | that layer's alpha/brightness masks this one (give the matte `vis=0`) |
| `inner=X,Y,BLUR,COLOR,OP` | inner shadow (light color + 0,0 = inner glow) — rect/ellipse |
| `sheen=AT,ANGLE,WIDTH,OP` | light sweep across the shape (animate AT 0>1) |
| `bevel=WIDTH,STRENGTH` | embossed plastic edge |
| `backdrop=BLUR` | frosted glass: blurs what is behind the shape (pair with a light translucent fill + thin stroke) |
| `adj=1 glass=THICKNESS,BEVEL,BLUR[,IOR,DISPERSION,SPECULAR,TINT]` | liquid glass over what is below, in the shape of the layer (rect or ellipse; see Liquid glass) |
| `rep=COUNT:DX,DY[:cols=N][:rot=DEG][:sc=K][:op=K][:delay=S]` | copies in a row/grid/radial burst; vary copies with `i` in expressions |
| `mp="M…" mpp=0>1@0-1.2:eio orient=1` | move along an SVG path (scene px; x/y add an offset; orient turns with it) |
| `time=(EXPR)` | time remap of the layer clock: `(mod(t,1.2))` loops, `(t*0.5)` slow motion, keys freeze/reverse |
| `z= rx= ry= persp= fixed=1 cam=` | world, camera and 3D planes — see below |

### Text
`id text START x= y= w= h= size= role=heading|body align=left|center|right lh= ls= "Just *ask.*"`
- ONE layer per phrase. Mark key words with `*word*` (colored with `accent=COLOR`, default the palette accent). Never split a
  phrase into word layers (they collide).
- `w`×`h` is the text box: the type shrinks until it fits. On a card, give the text the card's box minus ~8% padding.
- Text stays sharp at any size: above 256 px it is drawn from a distance field, so hero words at 400-900 px are as clean as small text.
- Timing by reference: `start`/`end` take `@phrase:N` (the N-th phrase of the voice, from 1; phrases split at silences of 0.25 s or more between the caption words) or `@word:TEXT` (first time that word is said), each with an optional `+SECONDS`: `hook @phrase:2-@phrase:3 …`, `tag @word:ready+0.2-6 …`. Needs a voice with captions; without one the error says so.
- Text is kerned from the font's own spacing (GPOS) and ligatures are off, so every character stays one glyph and per-character animation lands on the right letters. Keep body text at least 2.4% of the short side (26 px on 1080): review flags smaller text as unreadable on a phone.
  The wrap width is never below 20% of the frame width (216 px at 1080 wide, 384 px at 1920): a narrower `w` is widened
  around x, so a left-aligned label in a narrow box starts further left — give left/right-aligned text `w` ≥ that.
- per-unit animation (JSON tail): `{"animate":{"by":"char|word|line","stagger":0.03,"duration":0.5,"delay":0,"ease":"expo_out","reverse":false,"from":{"x":0,"y":40,"scale":0.8,"rotation":0,"opacity":0,"blur":16}}}`
- text on a path: `tp="M-700 0 C-300 -250 300 250 700 0"` (relative to x,y) `tpo=OFFSET_PX` (animate to crawl along).
- counter: `count=0>12480@0-2:eo dec=0` with `{n}` in the text ("{n} users"); thousands separators are added.
- typewriter: `reveal=(max(0,(t-0.3)*16))` = characters typed (spaces not counted) · `caret=1` blinking caret.
- font: set_font picks any Google Font for the whole video; `role` picks the heading or body weight.

### Paths, icons, images, 3D objects
- path: `"SVG path data"` relative to x,y (M L H V C S Q T A Z; default x=y=0 = scene coordinates). `ts= te= to=` trim
  start/end/offset 0..1 (`te=0>1@0-.8:o` draws it on). `filled=1` fills closed subpaths with fill/grad; overlaps cut
  holes (even-odd) unless `rule=nonzero` (SVG's default, set by add_vector on imported pieces).
  Morph (JSON): `{"morph":[{"t":0,"d":"M…"},{"t":0.8,"d":"M…","ease":"expo_in_out"}]}` (subpaths pair in order).
- icons: `id path START x= y= ic=NAME:SIZE` centered on x,y — NAME is a Lucide line icon (`bell`, stroked: `stroke=2.5:text`)
  or an Iconify id (`ph:bell-ringing`, `tabler:bell`, `solar:bell-bold-duotone`…): filled sets get `filled=1 fill=text`
  (override with `fill=`), line sets a stroke scaled to SIZE. One-color icons only; multicolor ones (emoji, logos) go
  through `add_vector icon=…`. `find_icons` finds names. Never hand-draw icons.
- image: `id image START x= y= w= h= src=/media/… fit=cover|contain rad=28` — src from get_brand, import_assets, cut_out or generate_image; `contain` for logos and cutouts
  (never crop them), `cover` for photos. Put screenshots on a card or a device frame built from shapes and walk through
  features by keying the image's scale/x/y while text explains them.
- 3D object inside the 2D frame: `id object START x= y= w= h= finish=glossy|glass|chrome|matte|toon spin=RX,RY,RZ fov=28 {"node":{…}}`
  — a procedural 3D tree (see 3D) framed to fill the box at rest (its bounding sphere: turning never changes its size);
  spin = degrees x,y,z, each a number, `(expression)` or keys (separate the three with `;` when one is keys: `spin=0:0,1:90;0;(t*40)`);
  fov = lens degrees (small = flat, large = dramatic). Defaults: glossy, spin 0, fov 28. Effects, opacity and blend apply
  like any layer. Glossy app tiles, glass orbs, chrome rings/ribbons, 3D emoji.
<!-- text3d:begin -->
- 3D text: `id text3d START x= y= w= h= [depth=0.25] [family="Space Grotesk"] [weight=700] [align=left|center|right] [ls=EM] [lh=1.2] [finish=…] [spin=…] [fov=…] fill=COLOR "Lumen"`
  — the words extruded from the font's real glyph outlines (holes included), a 3D object whose node is
  `{"shape":"text","text":"Lumen","depth":0.25,…}` (the same node works in prefabs and on the stage, see 3D).
  - defaults: the video's font (set_font) at its heading weight, depth 0.25 em, align center, glossy, fov 28.
  - framing, exact: at rest (unspun) the front face of the words' ink box fills the layer box's width or its height,
    whichever comes first, with 2% margin. So `w`×`h` sets the size; give the box roughly the word's aspect (≈ 0.6 em
    per letter wide, ≈ 0.7 em tall for caps) to fill both. It is not re-framed while it spins: a wide word turned around z
    overflows a tight box (leave room, or spin around y).
  - `fill` colors the letters (the text node has no color). `ls` is in em here (2D text uses px). `\n` in the text breaks
    lines, `lh` em per line, `align` aligns the lines.
  - a `family` other than the video's loads on demand (drawn with a fallback font for a moment).
  - kerning: only the font's legacy `kern` table; pairs kerned via GPOS (most Google Fonts) are not applied.
<!-- text3d:end -->

<!-- particles:begin -->
### Particles — `id particles START[-END] key=value…` (exact rules)
A particle emitter. Particles are a pure function of time (any frame, any order, same picture). Units: px, s, degrees
(0 = right, 90 = down, −90 = up). x/y = emitter center; `s`, `r`, `o`, `fill`, `blend`, effects, `z`, `parent` work as on
any layer (`s` scales the WHOLE effect: emitter, speeds, gravity, sizes). w/h only for line/rect/circle emitters.
| key | meaning (default) |
| --- | --- |
| `emit=point\|line\|rect\|circle` · `emit="M…"` | birth place (point): line = horizontal `w` long; rect = inside `w`×`h`; circle = inside the ellipse `w`×`h`; `"M…"` = uniformly along that path (relative to x,y) |
| `edge=1` · `out=1` · `follow=1` | rect/circle: born on the outline · aim away from the center (line/path: along the normal, 90° counter-clockwise from the path direction; replaces dir) · path: each particle rides the path start→end over its life |
| `rate=N` | particles/s, animatable (`rate=0:0,.2:300,.6:0`). Particle k is born when ∫rate reaches k (a constant rate = evenly spaced births from the layer start). Needs `rate` and/or `burst` |
| `burst=AT:COUNT,…` | COUNT particles born together AT s after the layer start |
| `prewarm=S` | the stream has been running S s at the layer start (snow already falling; use prewarm ≥ life) |
| `life=S` or `MIN..MAX` | lifetime (2; ≥ 0.05). Ranges: each particle draws uniformly |
| `speed=` `dir=` `spread=` | initial speed px/s (200, range ok) · direction (−90) · full cone width (30; 360 = all around) |
| `grav=GX,GY` · `drag=K` · `wind=WX,WY` | px/s² · speed × e^(−K·age), terminal speed = g/K · constant drift px/s. Exact: p = p0 + (g/K)·τ + (v0 − g/K)(1 − e^(−Kτ))/K + wind·τ (K=0: p0 + v0τ + ½gτ²) |
| `wander=AMT[,CELL,SPEED]` | turbulence: offset = AMT × (n(now) − n(birth)), n ∈ [−1,1] smooth noise shared by all particles (CELL px per swirl, 200; SPEED 1 = new pattern each second) → drift of ~±AMT px |
| `look=circle\|rect\|streak` · `ic=NAME` · `"M…"` · `src=/media/…` | circle (default) · rect (`aspect=H/W`, `rad=`) · streak = capsule from where it was `trail=` s ago (0.04) to now, tail fading (sparks, rain, speed lines) · Lucide icon / path fitted to `size` (outlined at size/12, `filled=1` fills) · picture (contained) |
| `size=PX` or `AGE:PX,…` · `size_var=F` | size over normalized age 0..1, linear between keys (12) · each particle × uniform [1−F, 1+F] |
| `alpha=V` or `AGE:V,…` | opacity over life × layer `o` (default `0:0,.05:1,.7:1,1:0`) |
| `colors=C1,C2,…` · `color_life=AGE:C,…` | each particle picks one at random (default: `fill`) · color over life (replaces the pick) |
| `angle=` `spin=` `flip=` `align=1` | initial rotation ° · °/s · paper flip turns/s (width × \|cos\|, back 20% darker: confetti) · turn to the travel direction |
| `space=local` | particles move with the layer (default world: born where the emitter was, a moving emitter leaves a trail; gravity/wind are screen directions) |
| `seed=N` · `max=N` | random variation (0; same settings + seed = same particles) · cap of live particles (1000, hard max 2000): beyond it the OLDEST vanish early — keep rate × life < max |
Measuring: `get_layout` gives a particle layer's box = extent of its live particles (emitter box when none) plus
`particles N live, M on screen` and `CAPPED` when live = max; off-frame particles are not flagged (review checks counts).
With a camera, world layers draw far→near: a particle layer with z>0 is drawn behind non-fixed layers with smaller z
(a `fixed=1` background listed first is always behind it).
Cost: ≤ 2000 per layer stays smooth; circles/rects/streaks are one GPU draw; filled path particles cost more (≤ 300).
Particles vanish when the layer ends: set END ≥ last birth + life, stop the stream with rate keys.
```
sparks particles 1.2-3.5 x=960 y=900 rate=0:0,.1:240,.8:0 life=.5..1.1 speed=500..900 spread=50 grav=0,900 drag=1 look=streak trail=.06 size=3 colors=#ffffff,#ffd27a,#ff8a3d blend=add glow=14,1.6
confetti particles 4.4-8 x=960 y=640 burst=0:220 life=2.5..3.5 speed=700..1300 spread=80 grav=0,1100 drag=1.6 look=rect aspect=.55 size=16 size_var=.3 angle=0..360 spin=-300..300 flip=.8..2 colors=primary,accent,#3ddc97,#ffffff alpha=0:1,.85:1,1:0
dust particles 0 emit=rect x=960 y=540 w=2200 h=1300 rate=12 prewarm=9 life=6..9 speed=4..16 spread=360 wander=40,260,.3 size=7 size_var=.5 soft=3 fill=#fff7e0 alpha=0:0,.2:.5,.8:.5,1:0
flow particles 0 emit="M200 600 C600 200 1300 1000 1720 500" follow=1 rate=4 life=2.4 speed=0 size=12 fill=accent glow=10,1.2
snow particles 0 emit=rect x=960 y=-40 w=2400 h=10 rate=40 prewarm=16 life=16 speed=0 grav=0,90 drag=1 wind=25,0 wander=30,200,.4 size=6 size_var=.5 fill=#ffffff alpha=0:.8,.9:.8,1:0
```
(snow: falls at g/K = 90 px/s, so life 16 s crosses 1080 px + margins; 40/s × 16 s = 640 < max.)
<!-- particles:end -->

<!-- custom-shaders:start -->
### Liquid glass — `glass=` on an adjustment layer
A glass shape refracts and blurs what is behind it like a thick convex slab. The engine does it: the rim bends the backdrop by Snell's law (index `ior`, default 1.5) along a quarter-circle bevel, the body shows a blurred copy of the backdrop, and a Fresnel rim and a specular highlight catch the light from the top left.
- `glass=THICKNESS,BEVEL,BLUR` (px): how far light travels through the glass, how wide the rounded rim is, how blurred the body is. Optional: `IOR` (1.5 = glass), `DISPERSION` (spread between red, green and blue indices; 0 = none, 0.01 = a faint fringe), `SPECULAR` (highlight strength, default 1), `TINT` (a color laid over the body at 14%).
- The layer is an adjustment layer (`adj=1` is implied) and its own box is the glass: a rect or ellipse, with `rad=` for its corners (a circle when `rad` is half the short side, a pill between). Put the glass after what it covers and the text it should carry after the glass.
- Typical values for a card of 400–800 px: `glass=60,120,8`. The bevel is kept inside the corner radius and half the short side; the bend is kept to the bevel's width. Thicker glass = a stronger bend at the rim.
- Limits: one shape per layer (no merging of blobs yet); the body blur is a half-resolution copy, so very large blurs are coarser; inside a tilted plane (`rx/ry`) glass is not supported; sharp corners (`rad=0`) show a crease where the bend meets the corner.

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
before them — keep them `fixed=1` and last). In JSON an effect with `"enabled": false` stays in the stack but is not
drawn (AE's fx switch): `{"fx":"blur","radius":8,"enabled":false}`; patch it back to `true` to turn it on.

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

<!-- video clips + audio-reactive: begin -->
### Video clips
`id video START x= y= w= h= src=/media/….mp4 fit=cover|contain in=S out=S speed=K loop=1 volume=V rad=PX`
- `src`: a clip from `get_brand` (kind `video`, its length and size are listed; `view_asset` shows a 4×3 contact sheet with
  the second of each frame). mp4 (H.264), webm (VP8/VP9/AV1) and mov decode in the editor; anything else fails to load.
- File second shown at layer time t (seconds since the layer start, after `time=` remap): `in + t × speed` (t < 0 → `in`).
  `out` (default: end of file; cut to the file length) ends the clip: past it the **last frame holds**, or with `loop=1` it
  wraps to `in`. The frame drawn is the last one whose timestamp ≤ that second (+1 ms) — exact in export, render_frames and
  review, whatever order frames are rendered in.
- Defaults: `fit=cover` (crop to fill the box; `contain` letterboxes), `in=0`, `speed=1` (0 < speed ≤ 16), `loop` off,
  `volume=0` = **muted** (0..1 plays the clip's own sound, following in/out/speed/loop; the `time=` remap is followed in
  export only in straight stretches). Freeze, reverse or ramp with `time=` keys: `time=0:0,1:1:h,2.5:1` freezes 1 s.
- Bounds/`get_layout` = the layer box (like an image); layout rows add `video@S/LENs` (file second on screen / file length)
  or `VIDEO failed to load: …`. `review_video` flags clips that fail to load, start past the file end, or run out and
  freeze while the layer is still on (fix: end the layer at `start + (out − in)/speed`, `loop=1`, or a lower speed).
- Everything else works as on any layer: `rad`, effects, mattes (`matte=` a device screen), blend, camera, 3D planes.

### Clip volume keyframes
A video layer's `volume` also takes keyframes (seconds from the layer start, values 0..1, in time order), followed in the
preview and the export mix: `{"op":"patch","id":"ft2","fields":{"volume":[{"t":0,"v":1,"ease":"linear"},{"t":3,"v":0.2,"ease":"linear"},{"t":4,"v":1}]}}`
dips the clip's sound from 3 s to 4 s. The line syntax's `volume=V` is a flat level only (write keys with a patch).
Music: `set_music` takes `envelope: [{"t":0,"v":0},{"t":2,"v":1}]` — levels 0..1 multiplying `gain`, `t` from the music's
`start`, straight between keys (fade the song in, dip it under a moment, fade it out).

### Transitions between clips
A cut between two main-track clips (A then B) becomes a transition by overlapping them: B starts `D` s before A ends
(move B and everything after it back by D), B is drawn above A, and B carries the keys (`D` 0.1–2 s):
- dissolve: B `opacity: [{"t":0,"v":0,"ease":"linear"},{"t":D,"v":1}]`.
- dip to black / white: B `opacity: [{"t":0,"v":0,"ease":"linear"},{"t":D/2,"v":1}]` plus the effect
  `{"fx":"color","brightness":[{"t":0,"v":-1,"ease":"linear"},{"t":D/2,"v":-1,"ease":"linear"},{"t":D,"v":0}]}` (`1` for white).
The Edit view reads exactly these keys as the transition (and writes them when the user adds one at a cut); both clips'
sound plays during the overlap.

### Audio-reactive expressions
The project voice-over/music is analysed in the editor (mono, 24 kHz, 100 frames/s; recomputed whenever the audio loads,
never saved). On the **scene timeline** (through the audio's start/trim), inside any `(expression)`:
| name | value |
| --- | --- |
| `vol` | loudness 0..1: 1 = the track's loud level (98th percentile), 0 = 40 dB below or silence; rises in ~15 ms, falls over ~150 ms |
| `bass` `mid` `high` | the same for < 250 Hz, 250–2000 Hz, > 2000 Hz, each against **its own** loud level |
| `spec(k)` | spectrum band at k = 0..1 (16 log bands, 40 Hz → 8 kHz, interpolated), each against its own loud level |
| `beat` | 1 exactly at a detected beat, then exp(−seconds/0.15) (0.37 after 0.15 s); 0 before the first beat |
| `beats` | number of beats so far (0, 1, 2…): `mod(beats,2)` alternates |
- Function forms read another scene second: `vol(T-0.1)`, `beat(T+0.05)` (anticipate), `spec(i/(n-1), T)`.
- Beats = onsets (kicks/snares on music, stressed syllables on a voice), ≥ 0.15 s apart — not a tempo grid. The scene
  summary (`get_scene`) lists them in scene seconds with a BPM estimate: put keyframes and cuts on those times.
- No audio (or outside the audio's window): every one reads 0 (`beat` keeps decaying after the audio ends).

Recipes:
```
screen rect 0 g=device x=540 y=900 w=820 h=1600 rad=96 fill=#0d0f14 stroke=6:#2a2f3a s=1>1.05@0-6:io shadow=0,40,90,#000000,.4
clip video 0 g=device parent=screen x=0 y=0 w=760 h=1540 rad=64 src=/media/…mp4 fit=cover in=1.5 out=7.5
cap text 0 g=cap x=540 y=1640 w=900 h=150 size=88 role=heading s=(1+0.12*vol) o=(0.55+0.45*vol) "Every *word* lands"
bar rect 0 g=eq x=155 y=(1780-(15+150*spec(i/(n-1)))) w=50 h=(30+300*spec(i/(n-1))) rad=12 fill=accent rep=12:70,0
flash rect 0 g=fx x=540 y=960 w=1080 h=1920 fixed=1 fill=#ffffff o=(0.3*beat) blend=add
kick ellipse 0 g=fx x=540 y=960 w=500 h=500 fill=accent soft=120 s=(1+0.25*pow(beat,2)) fill=(mod(beats,2)<1 ? …)
```
(`bar`: bottom-anchored bars = `y = BOTTOM − h/2`; `kick`: alternate colors with two layers and `o=(mod(beats,2))`.)
<!-- video clips + audio-reactive: end -->

## World, camera and depth — exact rules
Trust these formulas; `get_layout` prints the resulting screen boxes if you want numbers. Never render test shapes to find out.

**Camera.** One layer with `cam=FOCAL[,FOCUS_Z,APERTURE]` (give it `vis=0 w=1 h=1`) is the camera, for the whole film:
- its `x,y` = the world point shown at the frame center (pan = animate x/y) · its `z` = dolly D (+ = flies forward) ·
  its `s` multiplies the focal (zoom): F = FOCAL × s.
<!-- camera-roll:start -->
- its `r` (world rotation: r + parents' r + animation bricks) is the ROLL R°: the camera turns R° clockwise, so the
  picture turns R° counter-clockwise around the frame center. Exact: **screen = center + rot(point − camera x,y, −R) × k**
  with rot(v, a) = (vx·cos a − vy·sin a, vx·sin a + vy·cos a) in y-down pixels; every drawn item also gets −R added to
  its rotation. Planes (rx/ry), depth of field, drop-shadow offsets, `get_layout`, picking and text ink all use the same
  roll. Whip transition: `r=0:0,0.35:-18:ei,0.7:0:eo` with an x pan and `mblur` on the movers.
- `fixed=1` layers and captions are never rolled (nor panned/dollied/zoomed).
<!-- camera-roll:end -->
- FOCAL 1800 is a natural lens on 1080p (wider: 1200; telephoto: 3000).

**Depth.** Every layer has depth Z = its `z` + its parents' `z` (+ = farther). With a camera, a non-fixed layer is drawn:
- at scale **k = F / (F + Z − D)**, at **screen = frame center + (point − camera x,y) × k**;
- not at all once F + Z − D ≤ 1 (the camera flew past it).
- Consequences: a layer at Z = D is at its real size exactly where its x,y say (relative to the camera's x,y). To frame a
  beat region at (X, Y, Z), key the camera to x=X y=Y z=Z. A layer twice as far (F + Z − D doubled) is half size and
  moves half as much when the camera pans (parallax). Example, F=1800 and the camera dollies z 0>2400: a card at z=2400
  goes from k=0.43 to k=1; a layer at z=0 is behind the camera once D ≥ 1800 (put intro layers that must vanish there).
- Draw order with a camera: world layers far to near (bigger Z first; equal Z keep list order). Pinned `fixed=1` layers
  leave that sort: listed BEFORE every world layer they are the backdrop (drawn behind the whole world, whatever its z);
  listed anywhere else they draw OVER the world (HUD, grain/grade adjustment layers). So: background first, grain last.
  Without a camera: list order (first = back).
- `fixed=1` ignores the camera (pan, dolly, zoom, roll) — full-frame backgrounds, grain/grade adjustment layers, HUD.
  A fixed layer with z≠0 is scaled around the frame center with F=1800, as without a camera; a fixed plane uses `persp`.
- Without a camera layer nothing moves in depth, except layers with z≠0, scaled around the frame center with F=1800.
- Depth of field: APERTURE A>0 blurs each layer by A·|Z − FOCUS_Z|/1000 × k screen px (planes: without the × k).

**Tilted planes.** `rx=DEG` (top leans back; 50-65 = a floor/table seen from above) and/or `ry=DEG` (right side goes away)
turn a layer into a plane, usually an invisible null (`vis=0 w=1 h=1`):
- the plane and every layer parented to it (any depth) are drawn flat in the plane's space (children x/y relative to the
  plane's center, their own z ignored), then projected together. Children keep their own effects, blends and mattes.
- its center lands on screen where a flat layer with the same x,y,Z would, then the page tilts around it. Keep the
  center inside the region the camera frames (a plane centered at y=1900 in a 1080-high frame is mostly off screen).
- with a camera the plane uses the camera's lens and roll (`persp` is ignored); without one (or `fixed=1`), `persp=PX`
  (default 1800, animatable: `persp=600>2400@0-2:eo` is a lens zoom on the page) is its lens.
- planes do not nest: rx/ry on a layer inside another plane is ignored.
- the plane's flat space is a window twice the frame in each direction (capped at 4096 px), centered on the plane: its
  children paint at any camera position as long as they lie within one frame of the plane's center. Shapes, text, paths,
  images, shadows, glows, mattes, blend modes and custom WGSL layers all work inside a plane. Frosted glass (backdrop) is
  projected over the screen, as before.

**Camera nulls without a camera layer.** `cam rect 0 vis=0 x=0 y=0 w=1 h=1 pivot=CX,CY s=1>1.06@0-6:io` with
`parent=cam` on the other layers keeps their absolute x/y and gives a slow push-in around the frame center (animate the
null's x/y/r for pans and tilts). Prefer a real camera layer for depth and parallax.

<!-- object-lights:start -->
**3D object lights.** `object` layers take `light=AZIMUTH,ELEVATION[,COLOR[,INTENSITY]]` (= `lights.key`) and the rest of
`lights` in the JSON tail (same fields as the stage, manual "Lights"). Directions are seen from the viewer: azimuth 0 =
from the front, −90 = from the left, 90 = from the right; elevation 90 = from above. With `lights` the object also gets a
contact shadow (a soft #0f121f ellipse under its lowest point, as wide as its base × (1 + 0.3·(1 − Ly)), 0.18 × width
tall, pushed −Lx·0.2·width away from the key, opacity `contact` (default 0.35) × layer opacity; not part of the layer box).
Without `lights`: the original soft light, no shadow. Point light x/y/z are relative to the object's center (node units).
<!-- object-lights:end -->

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
tile object .5 x=1500 y=420 w=260 h=260 s=0>1@0-.6:b spin=(10*sin(t)),(t*40),0 {"node":{"shape":"box","size":[1,1,0.3],"radius":0.22,"color":"#57a0db"}}
logo text3d 1 x=960 y=540 w=1100 h=360 depth=0.3 finish=chrome fill=#d7dde8 s=.8>1@0-1.2:eo spin=(-70*(1-ease_out(min(1,t/1.2)))),(25*(1-ease_out(min(1,t/1.2)))),0 "Lumen"
glassy text3d .5 x=960 y=400 w=1400 h=300 depth=0.2 finish=glass fill=#57a0db glow=40,1.2,#9fd2ff spin=0,(8*sin(t*0.8)),0 "Clear day"
pop text3d 2 x=960 y=700 w=700 h=240 finish=toon fill=accent s=0:0,.35:1.15:b,.6:1 spin=0,0,(6*sin(t*3)) "Done!"
whip rect 0 vis=0 w=1 h=1 cam=1800 x=0:960,2.8:960,3.3:2900:eio y=540 r=0:0,2.8:0,3.05:-16:ei,3.3:0:eo
ring object 0 x=1400 y=540 w=520 h=520 light=-80,20,#fff1e0,1.5 {"node":{"shape":"torus","radius":0.5,"tube":0.16,"color":"#d9dee8"},"finish":"chrome","spin":[70,"t*35",0],"lights":{"ambient":{"intensity":0.7},"contact":0.4}}
```

<!-- components:begin -->
## Components — reusable motifs with params (precomps)
Build a motif ONCE (stat card, pill, chart, lower third, list row…) and place it many times with one line each. Fewer
tokens, identical styling, and redefining it updates every copy. Use one as soon as a motif appears twice.

**Define** with the `define_component` tool: `name`, `params`, optional `duration` (s), and `lines` in the add_layers
syntax. Their x/y are relative to the instance's center (0,0 = where the instance's x,y put it).
- params: `name:type[=default]`, space separated. Names: letters, digits, `_` (not starting with a digit).
  | type | instance value | default when omitted |
  | --- | --- | --- |
  | `number` | number, tween, keys or `(expression)` — may animate | 0 |
  | `color` | palette slot or `#rrggbb[aa]` (one color, no keys) | primary |
  | `text` | `"quoted"` or one bare word (numbers become text) | "" |
  | `src` | image source `/media/…` | "" |
  | `bool` | `1 0 true false` | false |
  | `path` | `ic:NAME[:SIZE]` (Lucide icon centered on 0,0, SIZE px, default 48) or `"M… path data"` | empty |
- `duration`: an instance added without `-end` gets end = start + duration. Without duration it lasts to the video end.

**Reference a param with `$name`** — the one mechanism, three places:
1. Whole value of ANY field: `w=$w fill=$accent stroke=3:$accent shadow=0,20,50,$accent,.2 grad=lin:90:$a@0,$b@1
   src=$logo vis=$show size=$size dec=$dec align=$align` and a path's data `"$icon"`. The field gets the param's value.
2. Inside an expression (number params only): `x=(-$w/2+40)` `h=($v*400*ease_out(t/.8))` `count=($value*ease_out(t/1.4))`.
3. Inside text: `"$title"`, `"{n}$unit"`, `"${name}s"` (braces when letters follow), `$$` = a literal `$`. Numbers print
   as integers or with ≤ 3 decimals (12480, 99.9). A `$` not followed by a name (`$5`) stays as written.
- Anything else is refused when you define: an undeclared `$name`, a non-number param inside an expression or inside a
  longer non-text value (`src=/media/$x.png`). The error names the layer and lists the params.

**Place** with add_layers: `id use START[-END] comp=NAME x= y= s= r= o= z= rx= ry= parent= g= rep= time= $param=value…`
- The instance is a parent null for all the component's layers: its x/y/s/r/pivot place them, its `o` multiplies their
  opacity, its effects/blend/matte (`shadow= blur= matte=`) treat the whole component as one picture, its z/fixed/rx/ry
  give it depth and tilt (with the camera, like any layer). It has no w/h (its box = its layers).
- Clock: the component runs on the instance's local time (seconds since its start, after `time=`): layer starts, ends and
  keys inside are component seconds; a layer without end lasts as long as the instance. Inside, `t` is each layer's own
  time and `T` is the component clock (not the scene's).
- Number params sample on that same clock: `$grow=0>1@0-1.2:eo` (seconds from the instance's start) or
  `$wob=(sin(t*3)*4)` — here `t` = instance seconds, `T` = scene seconds, `i`/`n` = the instance's repeater copy.
  A moving number can fill expressions and Animated fields (x y w h s r o rad soft count…), not text (use
  `count=($v)` with `{n}`) nor plain fields (size lh ls dec persp): those need a fixed number and the line is refused.
- `rep=` on an instance repeats the whole component; vary copies with `i` in number params: `$v=(0.3+0.15*i)`.
- Same id again replaces the instance (change params by resending its line).

**Inside a component**: `parent=` and `matte=` name layers of the same component; `id.x` / `id.y(T-0.2)` read layers of
the same component (scene layers are not visible from inside); effects, blend, adj, backdrop, mblur, rep work as usual;
`z`, `rx/ry`, `cam`, `fixed` and `anchor` are ignored (put them on the instance). A `use` line inside a component nests
another component (≤ 4 levels; a component can never contain itself) and may pass `$v=$a` or `$v=($a*2)` from the outer
params. Layer ids can't contain `/`.

**Measure and edit**: get_layout lists the instance (box = union of its visible layers) then each layer inside as
`instance/layer` (nested: `chart/b1/col`), with the instance's group, z and plane; `get_layout ids=["s1"]` shows `s1` and
everything inside. review_video checks the layers inside one by one (text overlaps, card edges, off frame). In the
editor a click on any part selects the instance; resizing it scales it. Read back: `get_component NAME` (params + lines,
ready to edit and resend), `get_component` (all), `get_layer ID` (the use line), get_scene lists components and uses.
Ops: `{"op":"define_component","name":"stat","component":{"params":[{"name":"title","type":"text","default":"Revenue"}],
"duration":6,"layers":[…layer JSON…]}}` · `{"op":"remove_component","name":"stat"}` (refused while a layer or another
component uses it; remove those first, same batch is fine). Redefining is refused if it breaks an existing instance
(e.g. a param it passes no longer exists) and names it.

### Precompose — layers you already placed become a component
`{"op":"precompose","ids":["card","title"],"component":"intro","id":"intro1"}`: those layers move into the new component
`intro` and ONE instance `intro1` takes the topmost one's place in the stack, from their earliest start to their latest
end (open-ended if one is), with their shared parent, group and `fixed`. It renders identically: times re-base to the
earliest start, anchors bake into x/y, formulas reading `T` are rewritten for the component clock. Refused, with the
reason, for the camera, layers with z/rx/ry, videos, mixed `fixed`, roots under different outside parents, and parent/
matte/formula links between a moved layer and one that stays (move both). Layers stacked between the selected ones end
up below the instance.

### Component recipes (16:9)
Stat card — defined once, three instances with staggered starts:
```
define_component name=stat duration=6 params='title:text="Revenue" value:number=0 unit:text dec:number=0 icon:path=ic:trending-up:40 accent:color=accent'
card rect 0 w=480 h=260 rad=36 fill=surface s=.9>1@0-.7:eo o=0>1@0-.35 shadow=0,30,70,#0f172a,.18
chip rect .12 x=-164 y=-58 w=80 h=80 rad=24 fill=$accent s=0>1@0-.5:b
glyph path .2 x=-164 y=-58 stroke=3:#ffffff te=0>1@0-.6:o "$icon"
label text .2 x=88 y=-58 w=384 h=44 size=30 align=left fill=text o=0>.75@0-.4 "$title"
num text .3 x=-8 y=50 w=384 h=100 size=84 role=heading align=left fill=text count=($value*ease_out(t/1.4)) dec=$dec "{n}$unit"

add_layers:
s1 use .3 comp=stat x=420 y=540 g=stats $title="Revenue" $value=12480 $unit=" €" $icon=ic:trending-up:40
s2 use .45 comp=stat x=960 y=540 g=stats $title="Active users" $value=3200 $icon=ic:users:40 $accent=primary
s3 use .6 comp=stat x=1500 y=540 g=stats $title=Uptime $value=99.9 $dec=1 $unit=% $icon=ic:activity:40 $accent=#22c55e
```
Pill / tag (width as a param; the text box follows it):
```
define_component name=pill params='label:text=New w:number=180 bg:color=accent ink:color=#ffffff'
bg rect 0 w=$w h=56 rad=28 fill=$bg s=.6>1@0-.45:b o=0>1@0-.2
txt text .08 w=($w-36) h=40 size=26 fill=$ink o=0>1@0-.3 "$label"

add_layers:
tag1 use 1.2 comp=pill x=300 y=200 $label=New $w=150
tag2 use 1.3 comp=pill x=480 y=200 $label="Best seller" $w=230 $bg=primary
```
Bar chart driven by params (a bar component nested four times; baseline at the instance's y):
```
define_component name=bar params='v:number=.5 label:text=Q1 tint:color=primary'
col rect 0 y=(-$v*200*ease_out(t/.8)) w=72 h=($v*400*ease_out(t/.8)) rad=14 fill=$tint
val text 0 y=(-$v*400*ease_out(t/.8)-30) w=140 h=40 size=28 role=heading fill=text o=0>1@.4-.7 count=($v*100*ease_out(t/.8)) "{n}%"
lbl text .1 y=36 w=120 h=36 size=24 fill=text o=0>.7@0-.3 "$label"

define_component name=chart params='a:number=.4 b:number=.6 c:number=.8 d:number=.5 tint:color=primary'
axis rect 0 y=2 w=560 h=4 rad=2 fill=text o=.25
b1 use 0 comp=bar x=-195 $v=$a $label=Q1 $tint=$tint
b2 use .08 comp=bar x=-65 $v=$b $label=Q2 $tint=$tint
b3 use .16 comp=bar x=65 $v=$c $label=Q3 $tint=$tint
b4 use .24 comp=bar x=195 $v=$d $label=Q4 $tint=accent

add_layers:
sales use 1 comp=chart x=960 y=760 g=chart $a=.35 $b=.55 $c=.9 $d=.7
```
(Write the tool calls as JSON arguments: `params` is the quoted string, `lines` the layer lines.)
<!-- components:end -->
