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

## 3D stage
Procedural 3D drawn behind the 2D layers, toon-shaded with outlines. Units are meters, y up.
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
