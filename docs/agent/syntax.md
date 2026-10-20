## Writing layers — `add_layers` (one line per layer, never JSON)

```
id type start[-end] key=value… "text or path data" {optional JSON merged into the layer}
```
- types: `rect | ellipse | text | image | path | object | use` (`use` = a component instance, see Components).
  Scene pixels, origin top-left, y down, x/y = the layer's CENTER.
  `w` and `h` are required (not for path). `end` defaults to the end of the video. Same id again = that layer is replaced.
- frame size by format: 9:16 = 1080×1920 · 16:9 = 1920×1080 · 1:1 = 1080×1080 · 4:5 = 1080×1350.
- value of any animatable key: number · tween `from>to@t0-t1[:ease]` · keys `t:v[:ease],t:v,…` · `(expression)`.
  Times in tweens/keys are seconds from the layer's own start.
- eases: `l` linear · `i o io` ease in/out/in-out · `b` back (overshoot) · `h` hold · `eo ei eio` expo (eo = premium UI) ·
  `el` elastic · `bo` bounce. An ease sits on the key it leaves; default `io`. JSON keys also take `"bezier":[x1,y1,x2,y2]`.
- expressions: `(540 + 40*sin(t*2))` `(wiggle(2,8))` `(spring(t,2.2,7))` `(lerp(0,1,ease(t/0.6)))`.
  vars: `t` layer seconds, `T` scene seconds, `i`/`n` repeater copy index/count, `pi`, `$name` a component's number
  param (inside components; elsewhere it reads 0).
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
  The wrap width is never below 20% of the frame width (216 px at 1080 wide, 384 px at 1920): a narrower `w` is widened
  around x, so a left-aligned label in a narrow box starts further left — give left/right-aligned text `w` ≥ that.
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
tag1 use 1.2 comp=pill x=300 y=200 $label=Nuevo $w=150
tag2 use 1.3 comp=pill x=480 y=200 $label="Más vendido" $w=230 $bg=primary
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
