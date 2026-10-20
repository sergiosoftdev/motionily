PRO 2D MOTION GRAPHICS — the bar is a studio launch film, not a slideshow. Pick ONE look family per video
(say which in the direction) and execute its signature moves:
A. LIGHT 3D PRODUCT TOUR — white/pale-blue world, the product's UI (cards, hero, pricing tiles, chips) laid out
   flat on a 3D plane: a null with rx=40..60 and ry=-15..15 that every UI layer is parented to; the camera "flies"
   over it (animate the null's y, z and rx with eo), strong motion blur (mblur=180,8 on the null's children is
   implied by the move: put mblur on fast flyers), floating glossy objects (soft-shadowed rounded shapes,
   icons) drifting above the plane, colorful pill tags (orange/green/yellow/blue, rad=h/2) popping in with
   back/spring, depth of field (blur=8..20 on the nearest/farthest elements). Ends flat: the plane rotates
   to rx=0 and settles into a clean centered card + title.
B. DARK KINETIC TYPE — near-black background with slow glossy light ribbons (wide soft gradient paths, glow,
   blend=add, drifting with expressions) or a dark gradient; short lines centered, ONE phrase at a time,
   words entering one by one: {"animate":{"by":"word","stagger":0.12,"duration":0.6,"ease":"ease_out",
   "from":{"opacity":0,"blur":16,"scale":1.12}}}; the key word in the accent color or a gradient; big single
   words ("Meet", "Introducing") char by char with blur; phrases exit by blurring out/fading as the next arrives
   (≈1-1.5 s each). Product UI shown in slight perspective (rx=8..20) with collaboration cursors (path arrow +
   name pill), a typed prompt with caret. Logo reveal: mark scales down from huge with blur, letters fly in.
C. NEON GLASS ICONS — pure black, app-icon tiles (rad≈26% of size) with a dark fill, a conic gradient outline
   (sgrad=con:… orange→magenta→violet→blue, angle animated) plus glow, a bright colorful icon inside (paths with
   gradients); tiles orbit/scatter around a centered short word ("Any case"), push in and out with spring,
   one tile flies to the center and morphs/pulses with a big soft purple bloom behind it (blurred ellipse,
   blend=add). Loops with time=(mod(t,P)).
D. WARM FLUID + AGENT UI — full-bleed liquid cloud gradient (2-4 huge soft ellipses in warm oranges/reds/violet
   with turb=120..200,350..450,0.4..0.7, slowly drifting) behind white UI cards: a prompt box typing with caret
   (reveal + caret), a node graph whose nodes pop in connected by curved paths drawn with trim, images/cards
   popping into a collage grid, a big gradient headline with a typing caret ("2 settings|").
E. DARK DASHBOARD + GLOWING PROMPT — near-black (#05050c→#12121a) with one faint colored glow (plum or steel), a pill prompt bar with an animated
   conic glowing outline (stroke-only layer: sgrad + glow, angle=(t*90)), text typing with caret, a cursor
   that moves to the send button and clicks (scale 1>0.85>1), then a dashboard flies in tilted (rx/ry) and
   straightens; inside: counters (count=… with {n}), bar/line charts drawing on (paths with te), donut rings
   (stroke trim), maps or grids filling in with staggered repeaters.
COLOR — unique, never "vibe coded". Unless the brand gives a palette, build one the way these films do (measured):
- Neutrals own the frame (60-90%): pure black #000000/#05070c, near-black #12121a, white #fdfdfd, warm grey
  #ececec/#f4f2ef, charcoal #343640, slate #3f4658. Backgrounds are neutral or ONE hue very dark/very pale.
- ONE hue family carries the film, in a few tones: sky #91cff2/#57a0db/#c9e3f2 (Maily) · vermilion/ember
  #d54b2c/#e87c3d/#ecc6ae (Flows) · cobalt steel #354978/#0e2745/#809bbc (Synaps) · powder blue + plum
  #92b6cc/#2c1b2e on #12121a (Fuse) · deep indigo glow #3c3f90/#2b0062 on black (youmotion).
- Saturation is small and precious: the key word, an icon, a chip, a light edge — ≤10-15% of the pixels.
  Small pops of 2-3 candy colors (pills/tags) are fine on a neutral page.
- Gradients stay within one family (adjacent hues) or go hue → neutral; light comes from glows on dark.
- BANNED unless the brand demands it: violet+magenta+cyan neon, indigo→pink "AI" gradients, rainbow, saturated
  full-frame backgrounds, pure #7c5cff/#a855f7/#ec4899/#22d3ee-style Tailwind defaults.
- Pick something specific to the brief (an ember-orange fintech, a cobalt architecture tool, a sage-green
  health app) and name it in the direction with its hex codes; review_video flags saturated or neon palettes.
Shared grammar (all families):
- Camera never static: slow push (cam null s=1>1.06) plus one or two decisive moves per beat; transitions are
  moves (fly-through, whip pan with mblur, zoom through an element, blur-out/blur-in), never hard cuts.
- Layer depth: background (gradient/fluid/ribbons), mid (UI, type), foreground (floating objects, particles,
  bloom). Defocus what is not the subject (blur 6-20).
- UI is real-looking and dense: rows of skeleton text (thin rounded bars at 15-30% opacity), avatars (circles
  with gradients), chips, toggles, icons drawn with paths, numbers that count. Simulate the product, don't
  describe it.
- Type: one line at a time, 1 accent word, tight letter spacing on big type, readable for ≥0.8 s.
- Timing: 0.4-0.7 s eo entrances, overlapping staggers, a beat every ≤1.5 s, holds only on the payoff/logo.
- Real assets: product screenshots from get_brand in image layers whenever the video is about a product; Lucide
  icons (find_icons) for every icon; 3D object layers for hero objects; never generic hand-drawn placeholders.
- Finish: subtle grain (adjustment layer grain=0.03-0.06) and bloom on light sources; end on logo + one line CTA.
