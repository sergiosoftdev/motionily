import { BrickSlot, EngineSupport, ParamType } from "../brick.enums";
import type { ParamSpec } from "../brick.schema";

/**
 * The official brick library. This file IS the catalog: add a brick here, bump
 * its `version` to update it, and it is upserted on boot. No code changes.
 */
export type SeedBrick = {
  slot: BrickSlot;
  name: string;
  /** Last part of the key; the full key is `${slot}/${id}`. */
  id: string;
  description: string;
  tags?: string[];
  fits?: MotionStyleId[];
  payload?: Record<string, unknown>;
  params?: ParamSpec[];
  engine?: EngineSupport;
  version?: number;
};

export const MotionStyleId = {
  Apple: "apple",
  Startup: "startup",
  Isometric: "isometric",
  Anime: "anime",
  Cartoon: "cartoon",
  PaperCut: "paper_cut",
} as const;
export type MotionStyleId = (typeof MotionStyleId)[keyof typeof MotionStyleId];

const { Apple, Startup, Isometric, Anime, Cartoon, PaperCut } = MotionStyleId;

export const brickKey = (slot: BrickSlot, id: string) => `${slot}/${id}`;
const k = brickKey;
const S = BrickSlot;

const speed: ParamSpec = { key: "speed", label: "Velocidad", type: ParamType.Number, default: 1, min: 0.25, max: 3 };
const intensity: ParamSpec = { key: "intensity", label: "Intensidad", type: ParamType.Number, default: 1, min: 0, max: 2 };

const palette = (colors: [string, string, string, string, string]) => {
  const [background, surface, primary, accent, text] = colors;
  return { background, surface, primary, accent, text };
};

/** Default bricks a motion style (the "box") snaps into every slot. */
const kit = (d: {
  palette: string;
  composition: string;
  typography: string;
  render_style: string;
  captions: string;
  animations: string[];
  transitions: string[];
  characters?: string[];
  scenario?: string;
}) => ({
  defaults: {
    [S.Palette]: k(S.Palette, d.palette),
    [S.Composition]: k(S.Composition, d.composition),
    [S.Typography]: k(S.Typography, d.typography),
    [S.RenderStyle]: k(S.RenderStyle, d.render_style),
    [S.Captions]: k(S.Captions, d.captions),
    [S.Animation]: d.animations.map((a) => k(S.Animation, a)),
    [S.Transition]: d.transitions.map((t) => k(S.Transition, t)),
    [S.Character]: (d.characters ?? []).map((c) => k(S.Character, c)),
    ...(d.scenario ? { [S.Scenario]: k(S.Scenario, d.scenario) } : {}),
  },
});

const BASE: SeedBrick[] = [
  // ── Cajas: estilos de motion ────────────────────────────────────────────
  {
    slot: S.MotionStyle, id: Apple, name: "Apple",
    description: "Minimal and premium: lots of air, big type, smooth and precise moves.",
    tags: ["minimal", "premium", "producto"],
    payload: kit({ palette: "mono_light", composition: "centered", typography: "clean_sans", render_style: "soft_depth",
      captions: "minimal", animations: ["fade_up", "mask_reveal"], transitions: ["zoom_through"] }),
  },
  {
    slot: S.MotionStyle, id: Startup, name: "Startup",
    description: "The SaaS ad: color blocks, kinetic type, fast pace and one hero component.",
    tags: ["saas", "energetic", "product"],
    payload: kit({ palette: "startup_green", composition: "asymmetric", typography: "grotesk_bold", render_style: "flat",
      captions: "highlight", animations: ["pop_in", "slide_in", "fade_up"], transitions: ["shape_wipe"],
      characters: ["stickman_outfit"] }),
  },
  {
    slot: S.MotionStyle, id: Isometric, name: "Isometric",
    description: "Isometric worlds that build up piece by piece; ideal for explaining processes.",
    tags: ["explicativo", "3d", "procesos"],
    payload: kit({ palette: "iso_blueprint", composition: "iso_grid", typography: "clean_sans", render_style: "iso_flat",
      captions: "minimal", animations: ["iso_rise", "pop_in"], transitions: ["zoom_through"], scenario: "iso_city" }),
  },
  {
    slot: S.MotionStyle, id: Anime, name: "Anime",
    description: "Cel shading, speed lines, saturated skies and punchy cuts.",
    tags: ["dynamic", "youthful"],
    payload: kit({ palette: "anime_sky", composition: "asymmetric", typography: "brush_display", render_style: "cel_anime",
      captions: "pop_word", animations: ["speed_lines", "pop_in"], transitions: ["flash_cut"], characters: ["chibi"] }),
  },
  {
    slot: S.MotionStyle, id: Cartoon, name: "Cartoon",
    description: "Squishy shapes, squash & stretch, thick outlines and toy colors.",
    tags: ["divertido", "cercano"],
    payload: kit({ palette: "toybox", composition: "centered", typography: "rounded_display", render_style: "toon_outline",
      captions: "sticker", animations: ["squash_stretch", "wobble", "pop_in"], transitions: ["shape_wipe"],
      characters: ["stickman_plain", "blob"] }),
  },
  {
    slot: S.MotionStyle, id: PaperCut, name: "Paper cut",
    description: "Cut-paper layers with real shadows, texture and stop-motion moves.",
    tags: ["handmade", "warm"],
    payload: kit({ palette: "kraft", composition: "layered", typography: "cut_letters", render_style: "paper_cut",
      captions: "minimal", animations: ["paper_flutter", "slide_in"], transitions: ["page_flip"] }),
  },

  // ── Paletas ─────────────────────────────────────────────────────────────
  { slot: S.Palette, id: "mono_light", name: "Mono light", description: "Whites, greys and one blue accent.", fits: [Apple, Isometric],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#f5f5f7", "#ffffff", "#1d1d1f", "#0071e3", "#1d1d1f"]) },
  { slot: S.Palette, id: "midnight", name: "Midnight", description: "Elegant dark with a violet accent.", fits: [Apple, Startup, Anime],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#0b0b12", "#1a1a26", "#7c5cff", "#22d3ee", "#f4f4f6"]) },
  { slot: S.Palette, id: "startup_green", name: "Startup green", description: "Brand green, cream and black.", fits: [Startup, Cartoon],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#f4f1ea", "#ffffff", "#16a34a", "#fbbf24", "#0f172a"]) },
  { slot: S.Palette, id: "sunset", name: "Sunset", description: "Warm oranges and pinks.",
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#fff1e6", "#ffffff", "#ff6b35", "#ff3d7f", "#2b1b17"]) },
  { slot: S.Palette, id: "pastel_pop", name: "Pastel pop", description: "Soft lilacs, yellows and pinks.", fits: [Cartoon, PaperCut, Startup],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#fdf2f8", "#ffffff", "#a78bfa", "#fbbf24", "#3b0764"]) },
  { slot: S.Palette, id: "anime_sky", name: "Anime sky", description: "Saturated blues and cloud white.", fits: [Anime],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#4aa8ff", "#ffffff", "#ff4d6d", "#ffd23f", "#0d1b2a"]) },
  { slot: S.Palette, id: "toybox", name: "Toybox", description: "Bright primaries on yellow.", fits: [Cartoon],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#ffd60a", "#ffffff", "#ff3b30", "#2563eb", "#111111"]) },
  { slot: S.Palette, id: "kraft", name: "Kraft", description: "Kraft paper, earthy cardstock and ink.", fits: [PaperCut],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#d9c3a0", "#f3e9d8", "#c2553a", "#3f7d6e", "#2a211b"]) },
  { slot: S.Palette, id: "iso_blueprint", name: "Blueprint", description: "Technical blues with a coral accent.", fits: [Isometric],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#e8f0fb", "#ffffff", "#2f6fed", "#ff7a59", "#13213c"]) },

  // ── Composición ─────────────────────────────────────────────────────────
  { slot: S.Composition, id: "centered", name: "Centered", description: "Hero in the middle, symmetry and air." },
  { slot: S.Composition, id: "asymmetric", name: "Asymmetric", description: "Weight on one side, text on the other; tension and energy.",
    fits: [Startup, Anime], payload: { anchors: { hero: [0.32, 0.45], text: [0.7, 0.62] } } },
  { slot: S.Composition, id: "split", name: "Split", description: "Split screen: two blocks in conversation." },
  { slot: S.Composition, id: "negative_space", name: "Negative space", description: "A big empty area framing the hero.",
    fits: [Startup, Apple] },
  { slot: S.Composition, id: "iso_grid", name: "Isometric grid", description: "Everything snaps to a 30° grid.", fits: [Isometric] },
  { slot: S.Composition, id: "layered", name: "Layers", description: "Overlapping planes with depth.", fits: [PaperCut, Cartoon] },

  // ── Tipografía ──────────────────────────────────────────────────────────
  { slot: S.Typography, id: "clean_sans", name: "Sans limpia", description: "Inter, pesos medios, titulares grandes.",
    payload: { family: "Inter", body: 500, heading: 600 } },
  { slot: S.Typography, id: "grotesk_bold", name: "Grotesque", description: "Compact, punchy grotesque.", fits: [Startup],
    payload: { family: "Space Grotesk", body: 500, heading: 700 } },
  { slot: S.Typography, id: "rounded_display", name: "Rounded", description: "Round, friendly display.", fits: [Cartoon],
    payload: { family: "Baloo 2", body: 500, heading: 800 } },
  { slot: S.Typography, id: "brush_display", name: "Brush", description: "Brush-stroke lettering.", fits: [Anime],
    payload: { family: "Dela Gothic One", body: 400, heading: 400 } },
  { slot: S.Typography, id: "cut_letters", name: "Letras recortadas", description: "Letras que parecen cortadas a tijera.", fits: [PaperCut],
    payload: { family: "Fraunces", body: 500, heading: 700 } },

  // ── Estilo de render ────────────────────────────────────────────────────
  { slot: S.RenderStyle, id: "flat", name: "Flat", description: "Flat color, no shadows.", engine: EngineSupport.Supported },
  { slot: S.RenderStyle, id: "soft_depth", name: "Soft depth", description: "Diffuse shadows and subtle highlights.", fits: [Apple, Startup] },
  { slot: S.RenderStyle, id: "toon_outline", name: "Toon outline", description: "Thick outlines and two-tone shading.",
    fits: [Cartoon], params: [{ key: "outline", label: "Outline width", type: ParamType.Number, default: 6, min: 0, max: 20 }] },
  { slot: S.RenderStyle, id: "cel_anime", name: "Cel anime", description: "Cel shading with hard highlights and halftones.", fits: [Anime] },
  { slot: S.RenderStyle, id: "paper_cut", name: "Paper cut", description: "Paper texture, rough edges and cast shadows.",
    fits: [PaperCut], params: [{ key: "shadow", label: "Sombra", type: ParamType.Number, default: 1, min: 0, max: 2 }] },
  { slot: S.RenderStyle, id: "iso_flat", name: "Iso flat", description: "Flat faces with three tones per volume.", fits: [Isometric] },

  // ── Subtítulos ──────────────────────────────────────────────────────────
  { slot: S.Captions, id: "minimal", name: "Minimal", description: "Texto limpio abajo, frase a frase." },
  { slot: S.Captions, id: "karaoke", name: "Karaoke", description: "The spoken word lights up." },
  { slot: S.Captions, id: "pop_word", name: "Pop", description: "Word by word with a bounce.", fits: [Anime, Startup, Cartoon] },
  { slot: S.Captions, id: "highlight", name: "Highlight", description: "Highlights key words with a color block.", fits: [Startup] },
  { slot: S.Captions, id: "sticker", name: "Sticker", description: "Words as stickers with a white border.", fits: [Cartoon] },

  // ── Animaciones ─────────────────────────────────────────────────────────
  { slot: S.Animation, id: "fade_up", name: "Fade up", description: "Aparece subiendo un poco.", params: [speed],
    payload: { keys: { opacity: [[0, 0], [0.45, 1]], dy: [[0, 40, "ease_out"], [0.45, 0]] } } },
  { slot: S.Animation, id: "pop_in", name: "Pop in", description: "Scales up from zero with a bounce.", params: [speed, intensity],
    payload: { keys: { scale: [[0, 0, "back"], [0.5, 1]] } } },
  { slot: S.Animation, id: "slide_in", name: "Slide in", description: "Entra deslizando desde un lado.", params: [speed,
      { key: "from", label: "Desde", type: ParamType.Choice, default: "left", options: ["left", "right", "top", "bottom"] }],
    payload: { keys: { dx: [[0, -600, "ease_out"], [0.6, 0]] } } },
  { slot: S.Animation, id: "mask_reveal", name: "Mask reveal", description: "Revealed from behind a mask.", fits: [Apple, Startup] },
  { slot: S.Animation, id: "squash_stretch", name: "Squash & stretch", description: "Squashes and stretches as it lands.", fits: [Cartoon], params: [intensity] },
  { slot: S.Animation, id: "wobble", name: "Wobble", description: "Bamboleo blandito en reposo.", fits: [Cartoon], params: [intensity] },
  { slot: S.Animation, id: "speed_lines", name: "Speed lines", description: "Radial lines behind it as it enters.", fits: [Anime] },
  { slot: S.Animation, id: "paper_flutter", name: "Paper flutter", description: "Flutters and settles like paper.", fits: [PaperCut] },
  { slot: S.Animation, id: "iso_rise", name: "Iso rise", description: "Blocks grow up from the ground.", fits: [Isometric] },
  { slot: S.Animation, id: "typewriter", name: "Typewriter", description: "Text appears letter by letter." },

  // ── Transiciones ────────────────────────────────────────────────────────
  { slot: S.Transition, id: "shape_wipe", name: "Shape wipe", description: "A color shape crosses and changes the scene." },
  { slot: S.Transition, id: "zoom_through", name: "Zoom through", description: "The camera flies through an element into the next scene." },
  { slot: S.Transition, id: "page_flip", name: "Page flip", description: "The scene turns like a page.", fits: [PaperCut] },
  { slot: S.Transition, id: "flash_cut", name: "Flash cut", description: "A punchy white flash.", fits: [Anime] },

  // ── Personajes ──────────────────────────────────────────────────────────
  { slot: S.Character, id: "stickman_plain", name: "Plain stick figure", description: "One-color stick figure without hands or feet." },
  { slot: S.Character, id: "stickman_outfit", name: "Dressed stick figure", description: "The same stick figure with outfit presets.",
    params: [{ key: "outfit", label: "Ropa", type: ParamType.Choice, default: "casual", options: ["casual", "doctor", "office", "sport"] }] },
  { slot: S.Character, id: "blob", name: "Blob", description: "Squishy, expressive creature.", fits: [Cartoon] },
  { slot: S.Character, id: "chibi", name: "Chibi", description: "Big-headed anime-style character.", fits: [Anime] },

  // ── Escenarios ──────────────────────────────────────────────────────────
  { slot: S.Scenario, id: "empty_studio", name: "Empty studio", description: "Infinite cyclorama, soft light." },
  { slot: S.Scenario, id: "clinic_room", name: "Clinic room", description: "Exam room with a treatment table." },
  { slot: S.Scenario, id: "office", name: "Office", description: "Desks, plants and screens." },
  { slot: S.Scenario, id: "iso_city", name: "Isometric city", description: "City blocks that rise piece by piece.", fits: [Isometric] },
];

/**
 * Data the render engine reads for animation, composition and transition bricks
 * (phase 4). Kept apart from the descriptions above so the library reads like a
 * catalog. Anchors are normalized (0..1) points; animation keys are `[t, v, ease?]`
 * where opacity/scale multiply and dx/dy/rotation add to the layer.
 */
const ENGINE_DATA: Record<string, Record<string, unknown>> = {
  [k(S.Animation, "fade_up")]: { keys: { opacity: [[0, 0], [0.45, 1]], dy: [[0, 40, "ease_out"], [0.45, 0]] } },
  [k(S.Animation, "pop_in")]: { keys: { scale: [[0, 0, "back"], [0.5, 1]] } },
  [k(S.Animation, "slide_in")]: { keys: { dx: [[0, -600, "ease_out"], [0.6, 0]], opacity: [[0, 0], [0.2, 1]] } },
  [k(S.Animation, "mask_reveal")]: {
    keys: { opacity: [[0, 0], [0.15, 1]], dy: [[0, 24, "ease_out"], [0.5, 0]], scale: [[0, 0.92, "ease_out"], [0.5, 1]] },
  },
  [k(S.Animation, "squash_stretch")]: {
    keys: { dy: [[0, -300, "ease_in"], [0.35, 0]], scale: [[0.35, 1], [0.42, 0.82, "ease_out"], [0.6, 1.08], [0.75, 1]] },
  },
  [k(S.Animation, "wobble")]: { keys: { rotation: [[0, 0], [0.25, 6], [0.5, -6], [0.75, 3], [1, 0]] } },
  [k(S.Animation, "speed_lines")]: { keys: { dx: [[0, -900, "ease_out"], [0.25, 0]], scale: [[0, 1.3], [0.25, 1]] } },
  [k(S.Animation, "paper_flutter")]: {
    keys: {
      rotation: [[0, -12, "ease_out"], [0.3, 6], [0.55, -3], [0.8, 0]],
      dy: [[0, -200, "ease_out"], [0.8, 0]],
      opacity: [[0, 0], [0.2, 1]],
    },
  },
  [k(S.Animation, "iso_rise")]: { keys: { dy: [[0, 120, "back"], [0.6, 0]], scale: [[0, 0, "back"], [0.6, 1]] } },
  [k(S.Animation, "typewriter")]: { keys: { opacity: [[0, 0, "hold"], [0.05, 1]] } },

  [k(S.Transition, "shape_wipe")]: { kind: "shape_wipe" },
  [k(S.Transition, "zoom_through")]: { kind: "zoom_through" },
  [k(S.Transition, "page_flip")]: { kind: "page_flip" },
  [k(S.Transition, "flash_cut")]: { kind: "flash_cut" },

  [k(S.Composition, "centered")]: { anchors: { hero: [0.5, 0.45], title: [0.5, 0.22], caption: [0.5, 0.82], accent: [0.78, 0.68] } },
  [k(S.Composition, "asymmetric")]: {
    anchors: { hero: [0.32, 0.45], text: [0.7, 0.62], title: [0.62, 0.2], caption: [0.5, 0.84], accent: [0.8, 0.75] },
  },
  [k(S.Composition, "split")]: { anchors: { hero: [0.5, 0.28], title: [0.5, 0.62], caption: [0.5, 0.86], accent: [0.82, 0.5] } },
  [k(S.Composition, "negative_space")]: {
    anchors: { hero: [0.68, 0.68], title: [0.3, 0.2], caption: [0.5, 0.88], accent: [0.2, 0.8] },
  },
  [k(S.Composition, "iso_grid")]: { anchors: { hero: [0.5, 0.55], title: [0.5, 0.15], caption: [0.5, 0.88], accent: [0.75, 0.4] } },
  [k(S.Composition, "layered")]: { anchors: { hero: [0.5, 0.5], title: [0.38, 0.25], caption: [0.5, 0.85], accent: [0.7, 0.7] } },
};

/** Bricks the engine renders from their existing payload (5: text, captions; 6: finishes; 7: characters, scenarios). */
const RENDERED_AS_IS = new Set<BrickSlot>([S.Typography, S.Captions, S.RenderStyle, S.Character, S.Scenario]);

export const CATALOG: SeedBrick[] = BASE.map((b) => {
  const data = ENGINE_DATA[k(b.slot, b.id)];
  if (!data) {
    return RENDERED_AS_IS.has(b.slot) ? { ...b, engine: EngineSupport.Supported, version: (b.version ?? 1) + 1 } : b;
  }
  return { ...b, payload: { ...b.payload, ...data }, engine: EngineSupport.Supported, version: (b.version ?? 1) + 1 };
});
