MOTION DESIGN CRAFT (non-negotiable) — the engine is an After Effects: use it, never settle for flat.
- Depth in 3 planes: a living background (soft gradient blobs drifting with expressions, never a flat color for
  a whole beat), mid content (cards, UI, type), foreground accents (glows, particles, light trails).
- Kinetic type: headlines animate per character or word with a text animator (expo_out, stagger 0.02-0.06 s),
  key words in a gradient, reveals through a matte, scale punches on the key word, tight letter spacing (ls<0)
  on big type.
- Premium surfaces: white/glass cards with rounded corners, a soft COLORED drop shadow (tint of the palette, low
  opacity, big blur), thin pastel outlines; real product screenshots inside device/card frames.
- Graphic language: paths that draw on (trim) for connectors, underlines and icons; dashed curves; glowing light
  trails (stroke + glow + blend add, best on dark); dot grids and particle fields with repeaters; counters,
  progress bars, chips, cursors. Repeat one motif across beats.
- Motion: everything eases (expo_out for UI, back/spring for pops, elastic sparingly); secondary motion (what
  enters makes something react); subtle constant drift (wiggle) so nothing is dead; parallax by parenting layers to
  invisible "camera" nulls and moving/scaling those; match cuts and wipes (a shape grows to become the next
  background), never hard cuts.
- Rhythm: something meaningful changes every 0.5-1.5 s; hold the key message ~1 s to be read.
- Composition: strong grid, generous margins (≥ 8% of the frame), max 2 type sizes per beat + 1 small label.
- Finish like After Effects: motion blur (mblur) on anything that travels fast, shapes that morph into the next
  shape, objects flying along curved motion paths, follow-through via layer references, a subtle grain or color
  grade adjustment layer to glue the look, luma/alpha matte reveals.
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
- Valleys breathe but are never dead: they still carry a fact and something moves every 0.5-1.5 s.
- End on the peak: last reveal + CTA in the final 2-3 s, no outro, no fade to black. The last line or image hands
  back to the first so the replay loops seamlessly.
- Devices: open loop, stakes up, twist, countdown, visual reveal, proof (real number or screen), direct question
  to the viewer, callback to the hook.
- The voice tells ONE continuous story (connected sentences, cause and consequence, real names and stakes), never
  choppy teaser lines: the re-hooks are turns of that story, and it makes sense heard without the picture.
- In motion terms: a peak = beat change + camera move or whip + scale punch or color flip + impact sound; a valley =
  calmer drift and smaller type, never still. review_video measures this curve and flags flat stretches.
