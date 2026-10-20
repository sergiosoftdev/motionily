# Motionily scene reference (for agents)

You design and animate the whole video yourself. There are NO presets: no built-in animations,
transitions, styles, finishes, templates or stock models. Write your own keyframes, like a motion
designer in After Effects. The user edits by clicking objects and commenting; read `get_feedback`.

## Scene
```json
{ "width": 1080, "height": 1920, "fps": 30, "duration": 6,
  "layers": [ ...Layer, back to front ] }
```
Coordinates are scene pixels, origin top-left, y down.

## Layer
```json
{ "id": "card", "type": "shape", "shape": "rect|ellipse",
  "start": 0.5, "end": 4,            // seconds; end defaults to scene end
  "fill": "primary",                 // palette slot: background|surface|primary|accent|text
  "x": 540, "y": 960,                // center
  "w": 600, "h": 300,
  "scale": 1, "rotation": 0, "opacity": 1, "radius": 24 }
```
- `fill`: a slot of the palette YOU set with set_palette (background|surface|primary|accent|text), or raw `[r,g,b,a]` 0..1.
- Any number (x, y, w, h, scale, rotation°, opacity, radius) may be keyframes instead:
  `[{"t":0,"v":0,"ease":"back"},{"t":0.4,"v":1}]` — `t` is seconds from layer `start`, sorted.
- Easing (from this key to the next): `linear|ease_in_out|ease_out|ease_in|back|hold`. Default `ease_in_out`.
- All motion is yours: entrances, emphasis, exits, parallax, cuts. Stagger elements 0.08-0.25 s, overshoot with
  `back`, hold with `hold`. Reusable motion: `{"op":"define_anim","key":"my/rise","template":{"keys":{"opacity":[[0,0],[0.4,1]],"dy":[[0,60,"back"],[0.5,0]]}}}`
  then `"anims":[{"use":"my/rise","at":0.2}]` (opacity/scale multiply, dx/dy/rotation add). Only keys you defined.

## Toolbox (After Effects-grade; prefer compact lines via add_layers)
Everything below is a JSON field of any layer; add_layers has short keys for it (see its description).

**Expressions** — any animatable number can be a string formula instead of a number/keyframes:
`"x": "540 + 40*sin(t*2)"`, `"rotation": "wiggle(1.5, 4)"`, `"scale": "spring(t, 2.2, 7)"`,
`"opacity": "0.2 + 0.1*sin(T*3 + i)"`, `"x": "card.x(T - 0.15)"` (another layer's x/y/w/h/scale/rotation/opacity,
now or at a given scene time: follow-through, trails, echoes). Variables: `t` layer seconds, `T` scene seconds, `i`/`n` repeater copy
index/count, `pi`. Functions: sin cos tan asin acos atan atan2 abs sign floor ceil round fract sqrt pow exp log
min max clamp lerp mix smoothstep step mod noise(x) rand(x) wiggle(freq,amp[,seed]) ease ease_in ease_out back
elastic bounce spring(t[,freq,damping]) pulse(x,period) saw tri; operators + - * / % ^ < >.

**Eases** per keyframe: linear, ease_in_out (default), ease_out, ease_in, back, hold, expo_out, expo_in,
expo_in_out, elastic, bounce — or `"bezier":[x1,y1,x2,y2]` (CSS cubic-bezier) on the keyframe.

**Paint**
- `"fill"`: palette slot or `"#rrggbb"` / `"#rrggbbaa"` (also `[r,g,b,a]`), or color keyframes
  `[{"t":0,"c":"#ffffff"},{"t":0.6,"c":"primary","ease":"expo_out"}]` (also for stroke colors and gradient stops).
- `"gradient": {"kind":"linear","angle":0,"stops":[[0,"#0f1733"],[0.45,"#ff3d5a"],[1,"#ffa23d"]]}` (up to 4 stops;
  angle in degrees, 0 = left→right) or `{"kind":"radial","center":[0.5,0.5],"radius":1,"stops":[…]}`. Works on
  shapes, text (across the block, per letter) and paths. `"kind":"conic"` sweeps around `center` from `angle` (animate
  it for rotating rim light). `"stroke": {…, "gradient": {…}}` paints the outline with a gradient (glowing borders).
- `"stroke": {"width":3,"color":"text","dash":[10,10]}` — outline for shapes, line for paths.
- `"soft": 240` — feathered edge in px: big soft ellipses layered = pastel mesh-gradient backgrounds and glows.

**Effects** (`"effects": [...]`, applied in order on the layer's own pixels):
`{"fx":"shadow","x":0,"y":30,"blur":70,"color":"#ff6f91","opacity":0.35}` · `{"fx":"glow","radius":18,"strength":1.6,"color":"#ff6f3c"}` ·
`{"fx":"blur","radius":12}` · `{"fx":"motion_blur","shutter":180,"samples":8}` · `{"fx":"color","hue":30,"saturation":1.2,
"brightness":0,"contrast":1.1}` · `{"fx":"chromatic","amount":6}` · `{"fx":"wave","amplitude":8,"wavelength":180,"speed":1}` ·
`{"fx":"grain","amount":0.08}` · `{"fx":"turbulence","amount":150,"size":400,"speed":0.5}` (turbulent displace: on huge
soft blobs it makes liquid/cloud backgrounds). `"adjustment": true` makes the layer an adjustment layer: its effects apply to
everything below it, inside its own shape. `"blend": "add" | "screen" | "multiply"` (add = light: glows, flares, trails on dark).
`"matte": {"layer":"mask_id","mode":"alpha"|"alpha_inverted"|"luma"|"luma_inverted"}` masks this layer with another
layer's alpha or brightness (reveals, text-through-shape, gradient wipes); set `"visible": false` on the matte layer.

**Materials** (shapes) — `"inner": {"x":0,"y":4,"blur":10,"color":"#000","opacity":0.3}` (inner shadow / inner glow),
`"sheen": {"at":[{"t":0,"v":0},{"t":1.5,"v":1}],"angle":20,"width":0.18,"opacity":0.45}` (light sweep),
`"bevel": {"width":6,"strength":0.35}` (embossed edge), `"backdrop": 24` (frosted glass: blurs what is behind).

**Icons** — `add_layers` path lines take `ic=NAME:SIZE` (1,900 Lucide icons, ISC; `find_icons` searches them).

**3D objects** — `{"type":"object","x":…,"y":…,"w":…,"h":…,"node":{…procedural tree…},"finish":"glossy|glass|chrome|matte|toon",
"spin":[rx,ry,rz],"fov":28}`: the tree is framed to fill the box and rendered with that finish; effects apply.

**Structure**
- `"parent": "layer_id"` — inherit position/rotation/scale; x/y become relative to the parent's center. Invisible
  parents (`"visible": false`) are nulls: a "camera" null at x=0,y=0 with `"pivot":[cx,cy]` keeps children in
  absolute coordinates and scales/pans them all (push-ins, parallax with several nulls at different speeds).
- `"motion_path": {"d":"M150 900 C600 150 1200 1050 1750 250","progress":[{"t":0,"v":0},{"t":1.2,"v":1}],"orient":true}`
  — moves the layer along a path (scene pixels; x/y add an offset), `orient` turns it with the path.
- `"rotate_x": 50, "rotate_y": -12, "z": 400, "perspective": 1800` — 3D layer: it and every layer parented to it are
  drawn flat, then projected in perspective (UI pages lying back, dashboards turning, fly-overs). Use an invisible
  null as the plane. Effects of the children are ignored inside it (fake shadows with `soft` rects).
- `"camera": {"focal": 1800, "focus": 0, "aperture": 12}` on an invisible layer makes it the scene camera: its
  x/y is where it looks, `z` dollies it forward, `scale` zooms. With a camera every layer lives at its `z` depth
  (parents' z adds up): far layers shrink and move less (parallax), are drawn behind, and blur away from `focus`
  when `aperture` > 0. `"fixed": true` pins a layer to the screen.
- `"time": "mod(t, 1.2)"` — time remap: the layer's own clock (loops, `"t*0.5"` slow motion, keys to freeze/reverse).
- `"pivot": [px, py]` — point (relative to the center) the layer rotates/scales around.
- `"repeat": {"count":60,"x":145,"y":160,"columns":12,"rotation":0,"scale":1,"opacity":1,"delay":0.02}` — copies
  in a row/grid/radial burst; each copy can differ through expressions using `i`.

**Paths** — `{"id":"link","type":"path","d":"M330 260 C480 260 520 420 560 470","stroke":{…},"trim_start":0,
"trim_end":[{"t":0,"v":0,"ease":"ease_out"},{"t":0.9,"v":1}],"trim_offset":0,"filled":false}`. Coordinates are
relative to the layer's x/y (default 0,0 = scene coordinates). SVG commands M L H V C S Q T A Z.
Shape morph: `"morph": [{"t":0,"d":"M…"},{"t":0.8,"d":"M…","ease":"expo_in_out"}]` blends between shapes (any
point counts; subpaths pair in order).

**Text extras** — `"letter_spacing": -4`, and per-unit animation:
`"animate": {"by":"char|word|line","stagger":0.035,"duration":0.5,"delay":0,"ease":"expo_out","reverse":false,
"from":{"x":0,"y":60,"scale":0.8,"rotation":0,"opacity":0}}` (each unit eases from `from` to rest). Text on a path: `"path": {"d":"M-700 0 C-300 -250 300 250 700 0","offset":0}`
(relative to x/y; animate `offset` in px to make it crawl along). The animator's `from` also takes `"blur": 16`.
Counter: `"count": [{"t":0,"v":0,"ease":"expo_out"},{"t":2,"v":12480}], "decimals": 0` with `{n}` in the text.
Typewriter: `"reveal": "max(0,(t-0.3)*16)"` (characters typed, spaces not counted) and `"caret": true`.

See `examples/startup-look.scene.json` in the repo for a full scene using all of this.

## Groups (always)
Give every layer a `group` naming the piece it belongs to (`"group":"dashboard"`, `"hook"`, `"cta"`…), one group
per visual unit. The user selects whole groups in the editor and asks for changes to just that group, so a
redesign touches only those layers. `{"op":"set_group","ids":["a","b"],"group":"dashboard"}` ·
`{"op":"remove_group","group":"dashboard"}` (then add the new layers with the same group) · `get_group`.

## Text
```json
{ "id": "title", "type": "text", "text": "Reserva en 10 segundos", "size": 96,
  "role": "heading|body", "align": "center|left|right", "line_height": 1.15,
  "x": 540, "y": 420, "w": 860, "h": 200, "fill": "text",
  "opacity": [{"t":0,"v":0},{"t":0.35,"v":1}] }
```
- Font: any Google Font you pick with set_font (`role` picks heading or body weight). `w` is the wrap width.
- Change words with `{"op":"set_text","id":"title","text":"…"}`.
- `w`×`h` is the text box: the engine shrinks the type until it fits. When text sits on a card,
  give the text layer the card's position and size minus padding (~8%), so it can never spill out.

## Images (brand logos, product screenshots)
```json
{ "id": "agenda", "type": "image", "src": "/media/….png", "fit": "cover|contain",
  "x": 540, "y": 960, "w": 900, "h": 560, "radius": 28 }
```
- `src` comes from get_brand (the user's kit). Look at it first with view_asset.
- `contain` for logos (never crop them), `cover` for photos. Round screenshots and put them on a
  surface card or a device frame you build with shapes; zoom/pan with keyframed scale/x/y to walk
  through features while text explains them (from the asset description).

## Captions
If the user uploads a voice-over, the editor transcribes it into `captions.words` (`{text,start,end,emphasis}`).
Time your beats to the speech. Fix words with `{"op":"set_captions","captions":{"words":[…]}}`. Design how
captions look yourself: build text layers from the words (timed to start/end) and hide the plain built-in
line with `{"op":"set_captions","captions":{"words":[]}}` if it gets in the way.

## 3D stage (only when the brief or user asks for 3D)
Motionily is motion graphics first: most videos are pure 2D layers. Procedural 3D drawn behind the 2D layers, toon-shaded with outlines. Units are meters, y up.
```
{"op":"put_prop","prop":{"id":"fisio","prefab":"fisio","x":0.9,"z":-0.4,"rotation":-40,"action":"wave",
  "scale":[{"t":0,"v":0},{"t":0.4,"v":1,"ease":"back"}],"start":0,"end":null}}   // add or replace by id
{"op":"put_prop","prop":{"id":"mesa","node":{…procedural tree…}}}      // one-off, unsaved
{"op":"remove_prop","id":"fisio"}
{"op":"set_shots","shots":[…]}                                          // camera direction (below)
{"op":"set_stage","stage":{"floor":"surface","props":[…],"shots":[…]}}  // whole set at once
```
- Everything is built by you from primitives and saved as prefabs; x/y/z/rotation/scale take keyframes.
- Interactions with `beats` on a prop (times from its start; walks auto-play "walk" and face where they go):
  `"beats":[{"at":0.5,"duration":2,"go_to":"fisio","action":"wave"},
            {"at":3,"duration":1.2,"sit_on":"camilla","seat_height":0.6},
            {"at":5,"face":"fisio","action":"point"},
            {"at":6,"duration":1.5,"walk_to":[2,1]}]`
  Prefer beats over keyframing x/z by hand.
- Camera: keyframe it yourself with `{"op":"set_camera","camera":{"yaw":[…],"pitch":[…],"distance":[…],"target_x":…,"fov":30}}`
  or, to save work, use **shots** (auto-framing on a target): `{"op":"set_shots","shots":[
  {"start":0,"end":2.5,"kind":"reveal","target":"all"},
  {"start":2.5,"end":5,"kind":"push_in","target":"fisio","yaw":-30,"framing":0.8,"blend":0.4},
  {"start":5,"end":7,"kind":"orbit","target":"camilla","sweep":60},
  {"start":7,"end":9,"kind":"follow","target":"paciente"}]}`
  kinds: static, orbit, push_in, pull_out, crane, follow, reveal · target: a prop id, "all" or [x,y,z] ·
  framing 1 = fit target (0.6 tight, 1.5 wide) · yaw/pitch degrees · blend = seconds of smooth move from the
  previous shot (0 = hard cut) · ease. Distance is automatic from the target size.

## 3D procedural building (preferred)
Build objects, characters and whole spaces from primitives, save them as prefabs once
(save_prefab) and reuse them in any project of the user (put_prop {"prefab":"name"}).
A node: `{ "shape": …, "position":[x,y,z], "rotation":[x,y,z]°, "scale":[x,y,z], "color": slot|[r,g,b,a],
"children":[…], "repeat":{"count":[nx,ny,nz],"spacing":[dx,dy,dz]} }`. Color is inherited by children.
Shapes:
- `{"shape":"box","size":[w,h,d],"radius":0.05}` (rounded corners), `{"shape":"cylinder","radius":r,"height":h}`,
  `cone`, `{"shape":"sphere","radius":r}`, `{"shape":"capsule","radius":r,"height":h}`, `{"shape":"torus","radius":r,"tube":t}`,
  `{"shape":"plane","size":[w,d]}` (floor-like), `{"shape":"extrude","points":[[x,y]…],"depth":d}` (logos, signs, 3D letters),
  `{"shape":"lathe","points":[[radius,y]…]}` (vases, lamps, bottles).
- Groups: a node without shape, only children. Prefab inside a tree: `{"prefab":"camilla","position":[…]}`.
- Characters are ALWAYS stickmen (Clinily spots style: black silhouette, round faceless head, tube limbs,
  no hands or feet — only the clothes change). Never build people from primitives; use a rig:
  `{"rig":{"style":"tee|shirt|sweater|hoodie|coat|labcoat|suit|scrubs|dress","top":"primary","bottom":[r,g,b,a],
  "long_sleeves":true,"shorts":false,"hair":"none|bun|pony|cap|beanie","hat":"accent","steth":true,"badge":true,
  "tie":"primary","scarf":"accent","height":1.64,"action":"idle|walk|wave|point|jump|sit|celebrate|stressed"}}`
  Doctor: labcoat white + steth. Physio: scrubs green + badge. Reception: shirt + vest-like top. Child: height 1.1.
  Save each character once (kind "character") and reuse it; the prop's `action` overrides the rig's.
- Shapes sit centered on their position (a box of height h at y=h/2 rests on the floor).
- Clone and reshape: clone_prefab → get_prefab → edit → save_prefab (the original stays).

## Ops (`apply_ops`, atomic batch)
```
{"op":"add_layer","layer":{...}}
{"op":"remove_layer","id":"card"}
{"op":"set_prop","id":"card","prop":"x|y|w|h|scale|rotation|opacity|radius","value":<number|keyframes>}
{"op":"set_fill","id":"card","fill":"accent"}
{"op":"set_timing","id":"card","start":1,"end":3}     // end may be null
{"op":"reorder","id":"card","index":0}               // 0 = back
{"op":"set_palette","palette":{"background":"#rrggbb","surface":"#…","primary":"#…","accent":"#…","text":"#…"}}
{"op":"define_anim","key":"my/pop","template":{"keys":{…}}}
{"op":"add_anim","id":"card","anim":{"use":"my/pop","at":0.4}}
{"op":"clear_anims","id":"card"}
{"op":"set_duration","duration":8}
// frame size: use the set_format tool (set_size is reserved for the editor)
```
Errors name the failing op index; nothing is applied when one fails.

## Tips
- Edit with small `apply_ops` batches; use `load_scene` only to start from scratch.
- `get_scene` returns a cheap summary; ask for `full=true` only when you need exact keyframes.
- Cuts between beats: end one group of layers and start the next (overlap 0.2-0.4 s with your own wipes:
  a full-frame shape whose x/scale you keyframe).
- Editing a clicked object: change only that layer/prop at that second; don't rebuild the scene.
- Not yet supported: video clips, export from the agent side.
- When a comment names a layer, `get_layer` it and change just that layer.
- Do not send `set_library`, `set_style`, `set_caption_style`, `set_render_style`, `set_scenario`: they are rejected.

## Self-review
`review_video` renders a contact sheet of the whole video and runs checks (layers off frame, overlapping
text, dead air, blank frames). Run it after every edit round and fix what it reports before finishing.
If the user has no editor open, the MCP opens an invisible one automatically.
