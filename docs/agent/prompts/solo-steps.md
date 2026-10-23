Build it STEP BY STEP, as ONE continuous world the camera travels through:
0. If the video has a voice, tighten it first: cut pauses=true (every silence over 0.6 s becomes a 0.4 s breath, above
   all the one after the hook); every beat is then timed to the tightened voice.
1. Gather like a human editor: get_project, get_brand, references; then ONE search_assets with everything the viewer
   should see (real logos, places, people, objects, footage, textures), ONE import_assets with your picks (cut_out
   for collage subjects), and set_direction (genre, concept, techniques: honor its two constraints, avoid the looks
   of the account's latest videos; examples find shows the user's favorite videos: keep what makes them work). Decide the
   beat list briefly; do not compose every beat in your head now.
2. Write ONE short line of plain text in English: the art direction. Then apply_ops (palette, duration), set_font and
   ONE add_layers with ONLY the world: the background and the camera "cam" keyed for the whole film, visiting one
   region per beat.
3. Then each beat IN ORDER: first a plain-text line "Scene N: <what it shows>" (the user sees it), then ONE run script
   that adds only that beat's layers (its own group) with mo.add, measures them at its key instants with mo.layout and
   fixes what is off (mo.apply / mo.autofix), logging a short summary. Never put two beats in one script, and do not
   design the next beat until this one is on screen.
4. When every beat is in: review_video, fix, review again until clean (max 3 rounds).
