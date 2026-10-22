/**
 * Seeds against sameness. A language model asked for "a great video" converges on the same one;
 * these push each video somewhere else: a genre vocabulary chosen for the brief, three reference
 * films of that genre drawn at random, and two creative constraints the video must honor. None of
 * this is a preset: they are briefs for the agent, who still designs every frame.
 */

/** Mirrors Genre in @motionily/protocol and the genre list in docs/agent/motion-2d.md. */
export enum Genre {
  ProductLaunch = "product_launch",
  ArchivalDocumentary = "archival_documentary",
  EditorialCollage = "editorial_collage",
  MapDataStory = "map_data_story",
  KineticType = "kinetic_type",
  RetroPrint = "retro_print",
  ScrapbookHandmade = "scrapbook_handmade",
  FlatIllustration = "flat_illustration",
  SocialNative = "social_native",
  CinematicTrailer = "cinematic_trailer",
  SwissEditorial = "swiss_editorial",
  Glossy3d = "glossy_3d",
  BrutalistZine = "brutalist_zine",
}

export type ReferenceFilm = { genre: Genre; title: string; look: string; moves: string };

export const REFERENCE_FILMS: ReferenceFilm[] = [
  // product launch
  { genre: Genre.ProductLaunch, title: "Light product tour", look: "Pale world, the product UI laid flat on a tilted plane, glossy floating props, candy pill tags.", moves: "Camera flies over the plane with motion blur, tags pop on springs, the plane straightens into a centered card + title." },
  { genre: Genre.ProductLaunch, title: "Dark dashboard with a glowing prompt", look: "Near-black, one faint colored glow, a pill prompt with a conic glowing outline.", moves: "Text types, a cursor clicks send, a dashboard flies in tilted and straightens, counters and charts draw on." },
  { genre: Genre.ProductLaunch, title: "Warm fluid + agent UI", look: "Full-bleed liquid gradient in one warm family behind crisp white cards.", moves: "A prompt types, nodes connect with curved trimmed paths, cards snap into a collage grid." },
  // archival documentary
  { genre: Genre.ArchivalDocumentary, title: "Ken Burns letters", look: "Black-and-white photos graded with grain, a serif date kicker, typewritten captions on paper strips.", moves: "Slow push or pan on every photo, cross-dissolves on the voice's breaths, a photo drops in as a print on a desk." },
  { genre: Genre.ArchivalDocumentary, title: "Newsreel", look: "High-contrast photos, film gate jitter, big condensed headlines like a 1940s newsreel card.", moves: "Hard cuts on the beat, scale punches on headlines, a spinning newspaper reveal, film burn between acts." },
  { genre: Genre.ArchivalDocumentary, title: "Document close-ups", look: "Real documents of the time filling the frame: letters, ledgers, ration cards, newspaper pages, graded to match.", moves: "Slow slides across the paper to the line that matters, a crop tightening on a signature or a number, cut to the photo it talks about." },
  // editorial collage
  { genre: Genre.EditorialCollage, title: "Explainer collage", look: "Cut-out people and objects on flat color fields, a huge cutout next to small precise type, photos cropped into strips.", moves: "Cutouts slide in as whole blocks along one axis, the background color changes on each new idea, a crop widens to reveal context." },
  { genre: Genre.EditorialCollage, title: "Magazine spread", look: "Big editorial serif, photos cropped into shapes (circles, arches), generous white space, one accent ink.", moves: "Masks reveal photos through shapes, layers slide in parallax, a page turns into the next beat." },
  { genre: Genre.EditorialCollage, title: "Stop-motion paper", look: "Construction paper shapes, visible paper texture, shadows between layers.", moves: "Elements move on 12 fps with tiny jitter, things are 'placed' by hand (drop + settle), paper slides off to reveal the next scene." },
  // map & data
  { genre: Genre.MapDataStory, title: "Route on a map", look: "Muted map, one highlighted country or region in the accent, small labels in a mono face.", moves: "Camera zooms from the world into the place, a route draws on, pins drop with springs, borders fill in sequence." },
  { genre: Genre.MapDataStory, title: "Numbers as objects", look: "Stacks, piles and bars made of the actual thing (bottles, coins, crates) photographed or drawn.", moves: "Stacks grow to compare, a counter climbs, one item is lifted out to make the point." },
  { genre: Genre.MapDataStory, title: "Timeline scrub", look: "A horizontal ruler of years across the frame, photos hanging from dates.", moves: "The camera scrubs along the timeline, years flick like a counter, each stop opens a photo and a fact." },
  // kinetic type
  { genre: Genre.KineticType, title: "Editorial serif in motion", look: "One big serif, tight tracking, words filling the frame edge to edge on a calm color.", moves: "Words replace each other in place on the voice's rhythm, a key word swaps color, lines slide out through a mask." },
  { genre: Genre.KineticType, title: "Typographic poster", look: "Huge cropped letters, extreme size contrast with small captions, two flat colors.", moves: "Whole words slide through the frame and settle fully inside it, the frame is recomposed as a poster on each beat, one hard cut per act." },
  { genre: Genre.KineticType, title: "Word wall", look: "A grid of repeated words in thin weights with one row in bold.", moves: "Rows scroll at different speeds, the bold row stops on the key word, the grid collapses into the next line." },
  // retro print
  { genre: Genre.RetroPrint, title: "Risograph", look: "Two or three spot inks, misregistered layers (a few px of rgb offset), halftone dots, grainy paper.", moves: "Shapes land in place on hold eases, ink layers slide into register, the paper grain is the only constant motion." },
  { genre: Genre.RetroPrint, title: "Vintage ad", look: "Real period print ads and packaging as material, cream paper, a slab headline, two inks.", moves: "The camera reads the old ad like a page, crops isolate the product, the modern equivalent cuts in beside it." },
  { genre: Genre.RetroPrint, title: "Two-ink poster", look: "A poster built from two flat inks and one halftone photo, big condensed type, no other decoration.", moves: "Ink layers slide into register on the beat, the photo's halftone resolves as the camera pulls back." },
  // scrapbook
  { genre: Genre.ScrapbookHandmade, title: "Personal archive", look: "Family-album photos and objects shot top-down, natural light, handwriting only where it really exists on the material.", moves: "Objects are pushed into frame from the edges on 12 fps, the camera settles on one photo and holds." },
  { genre: Genre.ScrapbookHandmade, title: "Desk flat-lay", look: "Top-down table with the story's real objects (cutouts) and documents, plain type.", moves: "Objects enter from the frame edges as if pushed by hand, the camera slides across the table between beats." },
  { genre: Genre.ScrapbookHandmade, title: "Photocopy zine", look: "High-contrast photocopied photos, one flat ink, type set straight and big.", moves: "Images replace each other on hard cuts, the copy grain shifts frame to frame, holds on the strongest image." },
  // flat illustration
  { genre: Genre.FlatIllustration, title: "Geometric explainer", look: "Flat shapes, a calm limited palette, long soft shadows, simple characters built from shapes.", moves: "Shapes morph into the next idea, staggered pops, a camera that pulls back to reveal the bigger system." },
  { genre: Genre.FlatIllustration, title: "Isometric world", look: "A small isometric diorama of the topic with tiny moving parts.", moves: "Pieces build up block by block, the camera orbits by sliding layers, details animate in loops." },
  { genre: Genre.FlatIllustration, title: "Line art", look: "Single-weight lines on a plain background, one accent fill.", moves: "Everything draws on (trim), fills flood in after the line, lines morph into the next drawing." },
  // social native
  { genre: Genre.SocialNative, title: "Screen-recorded story", look: "A phone screen or browser as the stage, real screenshots and photos, big readable captions.", moves: "Zoom punches on the detail that proves the point, fast hard cuts, scrolling through the real source." },
  { genre: Genre.SocialNative, title: "Green-screen commentator", look: "A cutout presenter (or a cutout object as 'the host') in front of full-frame photos and headlines.", moves: "The background swaps to the evidence on every claim, the real headline or screenshot fills the frame behind the host." },
  { genre: Genre.SocialNative, title: "Meme speed", look: "Bold sans captions, reaction cutouts, high saturation accents on neutral photos.", moves: "Cuts every 0.5-1 s, whip zooms, shakes on hits, freeze-frame with a label." },
  // cinematic
  { genre: Genre.CinematicTrailer, title: "Trailer titles", look: "Dark, letterboxed footage graded hard, big spaced serif titles alone on black.", moves: "Slow push on footage, cut to a title on a low hit, back to footage, the final title held in silence before the boom." },
  { genre: Genre.CinematicTrailer, title: "Atmospheric archive", look: "Moody graded photos, fog or smoke textures, a single warm light.", moves: "Very slow drifts, depth of field shifts between layers, titles appear through fog." },
  { genre: Genre.CinematicTrailer, title: "Neo-noir", look: "Hard shadows, venetian-blind light stripes, high contrast B/W with one red accent.", moves: "Light stripes sweep across type, cuts on silences, a match cut through a silhouette." },
  // swiss
  { genre: Genre.SwissEditorial, title: "International style", look: "Strict grid, a neo-grotesk, rule lines, numbers set large, red as the only color.", moves: "Elements slide along grid lines, rules draw on, numbers count, everything aligns flush left." },
  { genre: Genre.SwissEditorial, title: "Annual report", look: "Clean white pages, data tables and bar charts, small captions.", moves: "Charts build bar by bar, the camera scrolls the page, highlights slide under key figures." },
  { genre: Genre.SwissEditorial, title: "Transit signage", look: "Wayfinding pictograms, color-coded lines, round line badges.", moves: "Lines extend across the frame like a metro map, stations pop in, the frame re-centers on each stop." },
  // glossy 3d
  { genre: Genre.Glossy3d, title: "Chrome Y2K", look: "Chrome and glass 3D objects, pearly gradients, soft glows on a pale or deep background.", moves: "Objects rotate slowly and catch light sweeps, bounce in on springs, camera orbits." },
  { genre: Genre.Glossy3d, title: "Claymation-ish 3D", look: "Soft rounded 3D objects with matte finish, pastel palette, big soft shadows.", moves: "Squash-and-stretch pops, objects tumble in, a camera that slowly dollies." },
  { genre: Genre.Glossy3d, title: "Floating icons", look: "Glossy app-tile icons and 3D emoji floating in depth.", moves: "Parallax drift, one icon flies to the center and grows into the next scene." },
  // brutalist
  { genre: Genre.BrutalistZine, title: "Raw web", look: "System-looking type, hard black borders, one loud background color, raw screenshots.", moves: "Hard cuts, elements snap without easing (hold eases), windows open and stack." },
  { genre: Genre.BrutalistZine, title: "Poster noise", look: "Overprinted type, oversized numbers, photocopy grain, deliberate misalignment.", moves: "Layers jump on the beat, type scales in steps, a hard color flip on the twist." },
  { genre: Genre.BrutalistZine, title: "Manifesto", look: "Black on one flat color, giant words, nothing decorative.", moves: "One word per beat slams in, the background color flips on the twist, silence before the final line." },
];

/** Creative constraints: each video draws two it must honor (and says how). */
export const CONSTRAINTS: string[] = [
  "Every transition is a match cut: one element of a beat becomes the next beat's background or subject.",
  "One physical texture (paper, card, film scan, fabric) glues the whole film from the first frame to the last.",
  "At least one cutout breaks the frame of its own card or photo (it overlaps the border).",
  "The camera stays locked: everything moves inside a fixed frame, like a stage.",
  "Illustrated elements animate on 12 fps (time=(floor(t*12)/12)) for a handmade feel; the camera stays smooth.",
  "A two-color film: the background and one ink; photos graded to match.",
  "No gradients at all: flat fills, hard offset shadows.",
  "Real numbers appear as physical objects (stacks, piles, things counted), never as a UI chart.",
  "Every beat enters from a different direction (top, side, from the center, from behind something).",
  "Exactly one hard cut, on a sound hit at the pattern interrupt; everything else flows.",
  "A split screen or grid compares two things side by side at least once.",
  "Negative space: the subject never takes more than a third of the frame.",
  "A real photo or footage opens the film full frame, before any type.",
  "The palette turns per act: cold for the problem, warm for the payoff.",
  "One line of type runs along a path (tp=) or vertically.",
  "A ruler or timeline runs along one edge for the whole film, marking where we are.",
  "A logo's or object's own shape becomes the transition (it grows to fill the frame).",
  "One real object or cutout appears in every beat as a recurring character.",
  "A strict visible grid: thin rule lines, everything snaps to columns.",
  "A magnifier or zoom on a detail of a photo reveals a fact.",
  "At least one beat is a map or diagram with a route or connection drawn on.",
  "Nothing is centered: compositions sit on the left or right third.",
  "A screen inside the screen (phone, monitor, TV, newspaper) carries part of the story.",
  "The background is a photo or texture for the whole film, never a flat color or a gradient.",
  "Every beat ends with an object leaving the frame that starts the next beat.",
  "Subjects appear as silhouettes against a bright flat color at least once.",
  "Paper-cut depth: 3-5 layers at different z with parallax as the camera moves.",
  "Sound and picture hit together: every entrance lands on a word of the voice (@word refs).",
  "At least two beats hold one strong image still for 2 s or more, with only the voice moving the story.",
  "No text animator in the whole film: lines appear and leave on cuts.",
  "Every beat's main image is real material (photo, footage, logo, map, product screen): no beat carried by type alone.",
  "No decorative shapes at all: every layer is information or real material.",
  "Three colors in total, counting the photos' grade.",
  "Inside a beat the frame never moves; all the energy is in the cuts between beats.",
  "The biggest moment is the quietest frame: one image, no text, a beat of silence before the last line.",
  "One gesture repeats across the film with variations (the same slide, the same push), so the film has a signature move.",
  "Asymmetric timing: one beat is twice as long as any other and holds its image.",
];

export const CONSTRAINTS_PER_VIDEO = 2;
export const REFERENCES_PER_DIRECTION = 3;
/** Constraints of this many recent videos are not drawn again. */
export const CONSTRAINT_MEMORY = 3;
