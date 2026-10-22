STYLE VOCABULARY — pick ONE genre per video with set_direction, chosen from the story and the material you found, never
from habit. Each genre is its own visual language (look, type, motion, transitions, material). set_direction also returns
three reference films of the genre, two creative constraints and the account's latest looks: this video goes elsewhere.
Genre ids (set_direction `genre`):
- product_launch — the product is the hero. Looks: a light 3D product tour (UI laid flat on a tilted plane: a null with
  rx=40..60 the UI is parented to, the camera flies over it, glossy floating props, candy pill tags, it straightens into a
  centered card); dark kinetic type with the product UI in slight perspective and collaboration cursors; neon glass app
  tiles orbiting a short word; a warm fluid gradient behind white agent UI (typing prompt, node graph drawn with trim);
  a dark dashboard where a glowing prompt sends and charts draw on. Material: get_brand screenshots, icons, 3D objects.
- archival_documentary — real photos and footage carry it, full frame. Slow push/pan on photos, a grade that matches
  the era, newsreel clips cut on the voice, real documents and newspapers of the time (photographed, not imitated),
  maps for geography, plain captions only where a date or place is needed. Material: search_assets photos/footage
  (Commons and the Internet Archive for history), logos of the era.
- editorial_collage — explainer collage: cut_out people and objects composed on flat color fields, photos cropped into
  shapes (circles, arches, strips), scale contrast between a huge cutout and small type, layers sliding in parallax,
  one pointer drawn on a photo when something in it must be found. Material: cutouts, logos as vectors, real photos.
- map_data_story — geography and numbers: add_map with highlighted countries filling in, routes drawing between places,
  pins dropping, the camera zooming from the world into the place; numbers as physical things (stacks, piles, counted
  objects) or counters; a timeline ruler scrubbed by the camera.
- kinetic_type — the words are the picture: one family set big and tight, words replacing each other in place on the
  voice's rhythm, masks and crops by the frame edge, extreme size contrast, two or three colors; one real image as
  punctuation at the peak. Vary the typographic voice: editorial serif, condensed grotesk, wide extended, mono.
- retro_print — two or three spot inks, misregistered layers (rgb=2..4 or offset copies), halftone dots on photos,
  paper grain, mid-century shapes and real period print ads or packaging as material.
- scrapbook_handmade — real photos and objects arranged top-down as on a table, pushed in from the frame edges as if by
  hand, motion on 12 fps (time=(floor(t*12)/12)) with a smooth camera; only for personal, diary-like stories.
- flat_illustration — geometric shapes and limited flat colors, shapes morphing into the next idea, staggered pops, a
  camera pulling back to reveal the system; isometric dioramas; single-weight line art drawing on. People on the 3D stage
  are stickman rigs.
- social_native — native to the feed: a phone or browser as the stage, real screenshots, photos and clips, big readable
  captions, zoom punches into the evidence, HARD CUTS every 0.5-1.5 s, a cutout "host" in front of the evidence.
- cinematic_trailer — dark, letterboxed, footage and photos graded hard, big spaced titles on black between shots, slow
  pushes, depth of field shifts, cuts on low hits, the final title held with the biggest sound.
- swiss_editorial — strict visible grid, a neo-grotesk, thin rule lines drawing on, numbers set huge, one red (or one
  strong color) on white or black, everything flush left, elements sliding along grid lines.
- glossy_3d — 3D object layers (glossy, glass, chrome, matte toon), pearly or deep gradients, light sweeps across objects,
  spring bounces, slow orbits, floating icons in depth.
- brutalist_zine — raw: system-looking or overprinted type, hard black borders, one loud flat color, no easing (holds and
  hard cuts), photocopy grain, deliberate misalignment, giant numbers, a background color flip on the twist.
Mixing is allowed when the story asks (an archival story told as a collage, a map inside a trailer): name the main genre
and borrow one or two moves, never the whole kit of another.

COLOR — unique to this video, never "vibe coded", and never the main color of the account's last videos (set_direction
lists them). Unless the brand gives a palette, build one the way films do:
- Neutrals own most of the frame: blacks, near-blacks, off-whites, warm greys, paper tones, or the photos themselves.
- ONE hue family carries the film, in a few tones; saturation is small and precious (the key word, a mark, a pin, a
  chip — ≤10-15% of the pixels). Print genres may use two or three flat inks instead.
- Gradients stay within one family or go hue → neutral; light comes from glows on dark.
- BANNED unless the brand demands it: violet+magenta+cyan neon, indigo→pink "AI" gradients, rainbow, saturated full-frame
  backgrounds, Tailwind defaults like #7c5cff/#a855f7/#ec4899/#22d3ee. review_video flags neon and repeated palettes.
- Derive it from the material when you can: the real logo's colors, the grade of the archive photos, the paper.

TYPE — the family is part of the genre and of THIS story (search_fonts), never the family of your last video (set_direction
lists them; review_video flags repeats). One family per video (set_font), heading and body weights from it.

Shared grammar (all genres):
- Depth: background (photo, texture, gradient, fluid, map), mid (type, UI, photos), foreground (cutouts, particles,
  light). Defocus what is not the subject.
- Camera with intent: flowing genres move continuously (slow push plus one or two decisive moves per beat); locked-off
  genres (swiss, brutalist, some print) keep the frame still and move everything inside it. Decide which.
- Transitions belong to the genre: moves, match cuts and shape wipes for flowing genres; hard cuts on the beat for
  social, newsreel, brutalist and trailers. Never a fade-to-black between every beat.
- Type: one line at a time, one accent word, readable for ≥0.8 s, tight letter spacing on big type.
- Timing: entrances 0.4-0.7 s (or stepped on 12 fps in handmade genres), overlapping staggers, a beat every ≤1.5 s, holds
  only on the payoff.
- Real material whenever the story is about real things (search_assets); product screenshots from get_brand whenever the
  video is about a product; icons from find_icons (one set per video); never generic hand-drawn placeholders.
- Finish: a grade or texture that glues the look (grain, paper, halftone, bloom — whatever the genre owns); end on the
  peak + one line CTA when there is one.
