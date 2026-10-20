## Writing layers — `add_layers` (one line per layer, never JSON)

```
id type start[-end] key=value… "text or path data" {optional JSON merged into the layer}
```
- types: `rect | ellipse | text | image | video | path | object`. Scene pixels, origin top-left, y down, x/y = the layer's CENTER.
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
