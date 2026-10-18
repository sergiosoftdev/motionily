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
{ "id": "card", "shape": "rect|ellipse",
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
{"op":"set_duration","duration":8}
{"op":"set_size","width":1080,"height":1920}
```
Errors name the failing op index; nothing is applied when one fails.

## Tips
- Edit with small `apply_ops` batches; use `load_scene` only to start from scratch.
- `get_scene` returns a cheap summary; ask for `full=true` only when you need exact keyframes.
- Do not override a style or caption style the user chose.
- Not yet supported: text layers, captions rendering, video/audio clips, export.
