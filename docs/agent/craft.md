MOTION DESIGN CRAFT (non-negotiable) — the engine is an After Effects; craft is knowing what NOT to use.
- Depth where it helps the story: a background (a photo, a texture, a map, a color field), the content, and at most
  one foreground layer. Real material beats decoration; a flat color is fine when the content is strong.
- Type: hierarchy from size, weight and position; tight letter spacing (ls<0) on big type; every word whole inside
  the frame. Most lines appear on a cut or move as one block with the layout; per-word/per-character animators are
  for the one or two moments the voice stresses word by word (see AI TELLS), with a move chosen for this film.
- Real surfaces: what the story is made of — photos and prints, footage, documents, the product's screens, maps,
  logos as vectors; never an empty gradient where the story has something real to show.
- Graphic language: one motif that means something in this story (a route on a map, a bottle filling, a timeline),
  repeated with variations; connectors and diagrams only when they explain something.
- Motion: everything eases (expo_out for UI and type, spring/back only for physical objects landing; brutalist and
  handmade genres may step with holds or 12 fps on purpose); secondary motion (what enters makes something react);
  parallax by parenting layers to invisible "camera" nulls; transitions chosen by the genre: match cuts and wipes for
  flowing genres, hard cuts on the beat for social, newsreel, brutalist and trailer genres. Stillness is a tool:
  hold strong images.
- Rhythm: something meaningful changes on the voice's beats (≈0.5-2 s), with deliberate holds; uneven, not a metronome.
- Composition: strong grid, generous margins (≥ 8% of the frame), max 2 type sizes per beat + 1 small label.
- Finish like After Effects: motion blur (mblur) on anything that travels fast, shapes that morph into the next shape,
  follow-through via layer references, a grade that glues the look (grain only where the genre owns it), matte reveals.
- Save tokens with expressions, repeaters, loops (time=(mod(t,P))) and layer references instead of many
  hand-made keyframes/layers.

SHORT-FORM ATTENTION CURVE — always for 9:16, 4:5 and 1:1 (Reels, TikTok, Shorts); 16:9 keeps a classic arc.
Attention is a sawtooth, not an arc: start high, dip a little, re-hook, repeat, end on the highest peak.
- Start at 70%: frame 0 already moving, in medias res on the most surprising result, conflict or image. No setup,
  no logo intro; context arrives later in small doses, only when the viewer needs it.
- Re-hook every 4-7 s: open a question → pay part of it with a concrete fact or visual → open the next question
  before closing the last. Never leave the viewer with nothing open.
- Peaks escalate (stakes, numbers, reveals), each bigger than the one before; the biggest reveal in the last 20%.
- Pattern interrupt at ~30% (where viewers drop most): a twist ("but…") with a hard change of color, layout or
  camera and a sound hit.
- Valleys breathe: they still carry a fact; a held image with the voice is a valley, not a dead spot.
- End on the peak: last reveal + CTA in the final 2-3 s, no outro, no fade to black. The last line or image hands
  back to the first so the replay loops seamlessly.
- Devices: open loop, stakes up, twist, countdown, visual reveal, proof (real number or screen), direct question
  to the viewer, callback to the hook.
- The voice tells ONE continuous story (connected sentences, cause and consequence, real names and stakes), never
  choppy teaser lines: the re-hooks are turns of that story, and it makes sense heard without the picture.
- In motion terms: a peak = beat change + camera move or whip + scale punch or color flip + impact sound; a valley =
  calmer drift and smaller type, never still. review_video measures this curve and flags flat stretches.

AI TELLS — measured in 23 videos agents made here (3,644 layers). Each is a real device; repeated by default, stacked
together and applied to every line, they make a video smell generated. Never reach for them out of habit:
- Rubber stamps: a tilted bordered box with a short CAPS word ("ERSATZ", "HISTORIA", "TOP SECRET"). 8 of 23 videos.
  Never. If the story needs an official mark, show a real one (a photo of the document, the real logo).
- Word-by-word (or char-by-char) blur-in on every line (blur 8-16, scale 1.12, stagger 0.1): almost every text layer.
  It is the most generic text move there is. Most lines just appear on a cut, or move as one block with the layout;
  animate text per word only where the voice stresses each word, once or twice a film.
- The recipe "bold words appear one by one, stack, then an animated underline draws under the key word". Never.
- Marker marks on everything: underlines, circles, strike-throughs and arrows drawn on with trim under key words.
  At most one, when pointing at something real in a photo or map matters; never as decoration of type.
- Small CAPS "kicker" labels with wide tracking above every headline (8 of 23). Use only for a real date/place.
- Decorative geometry: thin rings (18 of 23 videos), dot grids (11), glowing orbs, soft blobs and bloom behind things.
  Every element must be information or real material; empty decoration is the clearest tell.
- Overshoot on everything (back/elastic: 715 keys): pops belong to physical objects that land, not to text and UI.
- Tilted cards, prints and labels at ±2-6° everywhere (175 layers): one deliberate tilt per film at most.
- Glow + soft shadow + grain on every layer: light where there is light, shadow where something sits on something.
- Confetti, sparks, dust bursts and white flashes at reveals; pills, chips and fake cursors outside a real product UI.
- Paper strips with type stuck on, sticky notes, tape and torn edges as decoration: only if the story is about paper.
- Words cropped by the frame edge: they read as broken, not bold. Every word stays whole inside the frame (5% margin).
- 3D text used as flat type: text3d renders its extrusion and softer edges; flat words are text layers (the real font,
  sharp). text3d is for a word that actually turns or sits in 3D space.
- Fake materials: flat light rects pretending to be paper or cards, gray or black bars pretending to be lines of text,
  redaction bars, invented forms and tickets. Use real textures and real documents (search_assets), or show nothing.
- Constant motion: everything drifting, wiggling and pushing all the time. Humans hold: a still frame of a strong
  photo for 2 s with only the voice is a decision, and it makes the moves around it count.
What a human editor does instead: ONE signature device per film, chosen for this story; hierarchy from layout,
scale and cuts rather than effects; real material carrying the picture; cuts on the voice's rhythm; uneven timing
(some beats fast, some held); restraint everywhere else. review_video reports the tells it can measure.
