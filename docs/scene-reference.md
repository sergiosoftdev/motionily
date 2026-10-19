# Motionily scene reference (for agents)

You create the video. The user only watches, picks a style / caption style and
leaves comments. Read their feedback with `get_feedback` after each round.

## Scene
```json
{ "width": 1080, "height": 1920, "fps": 30, "duration": 6,
  "style": "clean|neon|bold|pastel",
  "caption_style": "minimal|karaoke|pop_word|highlight",
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

## Bricks in the scene (prefer these over hand keyframes)
The editor fills `library` with the project's bricks; you reference them by key.
- **Animations**: `"anims": [{"use":"animation/pop_in","at":0.3,"speed":1,"intensity":1}]` on any layer.
  `at` is seconds from the layer start. Before `at` the layer rests on the animation's first
  values (e.g. invisible for fade_up), after it on its last ones. Stack several refs freely.
- **Anchors**: `"anchor":"hero"` (or title/caption/accent…, see `library.anchors` in the summary);
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
{"op":"set_size","width":1080,"height":1920}
```
Errors name the failing op index; nothing is applied when one fails.

## Tips
- Edit with small `apply_ops` batches; use `load_scene` only to start from scratch.
- `get_scene` returns a cheap summary; ask for `full=true` only when you need exact keyframes.
- Do not override a style or caption style the user chose.
- Not yet supported: text layers, captions rendering, video/audio clips, export.
- Do not send `set_library`: the editor owns it.
