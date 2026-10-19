# Motionily scene reference (for agents)

You create the video. The user only watches, picks a style / caption style and
leaves comments. Read their feedback with `get_feedback` after each round.

## Scene
```json
{ "width": 1080, "height": 1920, "fps": 30, "duration": 6,
  "style": "clean|neon|bold|pastel",
  "caption_style": "minimal|karaoke|pop_word|highlight|sticker",
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
- Prefer palette slots for `fill`: they follow the user's style choice. Raw color: `[r,g,b,a]` in 0..1.
- Any number (x, y, w, h, scale, rotation°, opacity, radius) may be keyframes instead:
  `[{"t":0,"v":0,"ease":"back"},{"t":0.4,"v":1}]` — `t` is seconds from layer `start`, sorted.
- Easing (from this key to the next): `linear|ease_in_out|ease_out|ease_in|back|hold`. Default `ease_in_out`.

## Text
```json
{ "id": "title", "type": "text", "text": "Reserva en 10 segundos", "size": 96,
  "role": "heading|body", "align": "center|left|right", "line_height": 1.15,
  "anchor": "title", "w": 860, "h": 200, "fill": "text",
  "anims": [{"use":"animation/fade_up","at":0.2}] }
```
- Font comes from the typography brick (`role` picks its heading or body weight). `w` is the wrap width.
- Change words with `{"op":"set_text","id":"title","text":"…"}`.
- `w`×`h` is the text box: the engine shrinks the type until it fits. When text sits on a card,
  give the text layer the card's position and size minus padding (~8%), so it can never spill out.

## Captions
The user uploads the voice-over and the editor transcribes it into `captions.words`
(`{text,start,end,emphasis}`), drawn on the `caption` anchor in the user's caption style
(minimal, karaoke, pop_word, highlight, sticker). You can:
- fix words or timing: `{"op":"set_captions","captions":{"words":[…]}}`
- mark key words (by index) so highlight/pop styles stress them: `{"op":"set_emphasis","words":[3,9],"emphasis":true}`
- time your scenes and text to the speech (see the captions line in the summary).

## 3D stage (real 3D)
A camera and glTF props drawn behind every 2D layer, toon-shaded with outlines. Use it for sets,
people and objects; put titles/captions on top as 2D layers.
```
{"op":"set_stage_preset","kind":"clinic_room|office|empty_studio|iso_city"}   // ready-made set (keeps characters)
{"op":"put_prop","prop":{"id":"fisio","model":"characters/character-female-b","x":0.9,"y":0,"z":-0.4,
  "rotation":-40,"scale":1,"action":"interact-left","enter":"pop|drop|rise|none","enter_delay":0.2,
  "start":0,"end":null,"tint":"primary"}}                                      // add or replace by id
{"op":"remove_prop","id":"fisio"}
{"op":"set_camera","camera":{"kind":"perspective|isometric","yaw":30,"pitch":25,"distance":6,
  "target_x":0,"target_y":0.4,"target_z":-0.5,"fov":32}}                      // every number can be keyframes
{"op":"set_stage","stage":{"camera":{…},"floor":"surface","props":[…]}}       // full custom set
```
- Units are meters, y up. Characters are ~0.72 m tall; tables ~0.38; a wall piece is 1 m wide × 1.29 m.
- `list_models` gives every model with its size, origin and (characters) animation clips:
  idle, walk, sprint, jump, sit, emote-yes, emote-no, pick-up, interact-left/right, wheelchair-*…
- Walk someone across: keyframe `x`/`z` and use `action: "walk"`; turn them with `rotation`.
- Camera moves sell 3D: slow orbits (keyframe `yaw`), push-ins (`distance`), isometric for diagrams.
- You are not limited to the presets: compose your own sets from any models.

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
- Characters: `{"rig":{"height":1.7,"skin":[0.95,0.78,0.65,1],"top":"primary","bottom":"text","coat":"surface",
  "hair":"short|long|bun|cap|none","hair_color":"text","build":1,"action":"idle|walk|wave|point|jump|sit|celebrate|stressed"}}`
  — stickman style (no hands/feet). Save a character once (kind "character") and reuse it; the prop's `action` overrides.
- Shapes sit centered on their position (a box of height h at y=h/2 rests on the floor).
- Clone and reshape: clone_prefab → get_prefab → edit → save_prefab (the original stays).

## Characters and scenarios
```json
{ "id": "doctora", "type": "character", "character": "stickman_plain|stickman_outfit|blob|chibi",
  "outfit": "casual|doctor|office|sport", "action": "idle|walk|wave|point|jump|sit|celebrate",
  "hair": "none|short|long|bun", "hair_color": "text" , "facing": 1,
  "anchor": "hero", "w": 320, "h": 640 }
```
- The character stands on the bottom of its box; `h` is its height. Actions loop by themselves.
- Use the character bricks the user chose (see get_project). Colors follow the palette;
  `hair_color` takes a palette slot or `[r,g,b,a]` (e.g. white hair: `[1,1,1,1]`).
- Change look/action without resending the layer: `{"op":"set_character","id":"doctora","action":"walk","hair_color":[1,1,1,1]}`.
- The scenario brick sets the backdrop (`scenario`: empty_studio, clinic_room, office, iso_city — the city builds itself).
  Place characters on the floor (lower half of the frame) when there is a room.

## Finish
The user's render style brick sets `render_style` (flat, soft_depth, toon_outline, cel_anime,
paper_cut, iso_flat): shadows, outlines, halftone, paper grain… applied to the whole frame.
Design flat shapes and let the finish do the rest; don't fake shadows with extra layers.

## Bricks in the scene (prefer these over hand keyframes)
The editor fills `library` with the project's bricks; you reference them by key.
- **Animations**: `"anims": [{"use":"animation/pop_in","at":0.3,"speed":1,"intensity":1}]` on any layer.
  `at` is seconds from the layer start. Before `at` the layer rests on the animation's first
  values (e.g. invisible for fade_up), after it on its last ones. Stack several refs freely.
- **Anchors**: `center`, `top`, `bottom` always exist; the composition adds its own (`"anchor":"hero"` (or title/caption/accent…, see `library.anchors` in the summary);
  then `x`/`y` are small offsets from that point. Use anchors so the composition brick decides layout.
- **Scene cuts**: `{"op":"add_transition","transition":{"at":3,"use":"transition/shape_wipe","duration":0.6}}`.
  Show different layers before and after `at` with `start`/`end`.
- Missing an animation? `create_brick` with `payload.keys` (`[[t, v, ease?], …]` per prop:
  opacity/scale multiply, dx/dy/rotation add) and use it immediately.

## Ops (`apply_ops`, atomic batch)
```
{"op":"add_layer","layer":{...}}
{"op":"remove_layer","id":"card"}
{"op":"set_prop","id":"card","prop":"x|y|w|h|scale|rotation|opacity|radius","value":<number|keyframes>}
{"op":"set_fill","id":"card","fill":"accent"}
{"op":"set_timing","id":"card","start":1,"end":3}     // end may be null
{"op":"reorder","id":"card","index":0}               // 0 = back
{"op":"set_style","style":"neon"}
{"op":"set_palette","palette":{"background":"#rrggbb","surface":"#…","primary":"#…","accent":"#…","text":"#…"}}   // null = style colors
{"op":"set_caption_style","caption_style":"pop_word"}
{"op":"add_anim","id":"card","anim":{"use":"animation/fade_up","at":0.4}}
{"op":"clear_anims","id":"card"}
{"op":"set_anchor","id":"card","anchor":"hero"}      // null = absolute x/y
{"op":"add_transition","transition":{"at":3,"use":"transition/flash_cut"}}
{"op":"clear_transitions"}
{"op":"set_duration","duration":8}
// frame size: use the set_format tool (set_size is reserved for the editor)
```
Errors name the failing op index; nothing is applied when one fails.

## Tips
- Edit with small `apply_ops` batches; use `load_scene` only to start from scratch.
- `get_scene` returns a cheap summary; ask for `full=true` only when you need exact keyframes.
- Do not override a style or caption style the user chose.
- Not yet supported: video clips, export from the agent side.
- When a comment names a layer, `get_layer` it and change just that layer.
- Do not send `set_library`: the editor owns it.
