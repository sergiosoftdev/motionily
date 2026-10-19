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
    description: "Minimalista y premium: mucho aire, tipografía grande, movimientos suaves y precisos.",
    tags: ["minimal", "premium", "producto"],
    payload: kit({ palette: "mono_light", composition: "centered", typography: "clean_sans", render_style: "soft_depth",
      captions: "minimal", animations: ["fade_up", "mask_reveal"], transitions: ["zoom_through"] }),
  },
  {
    slot: S.MotionStyle, id: Startup, name: "Startup",
    description: "El anuncio de SaaS: bloques de color, tipografía cinética, ritmo rápido y un componente protagonista.",
    tags: ["saas", "energético", "producto"],
    payload: kit({ palette: "startup_green", composition: "asymmetric", typography: "grotesk_bold", render_style: "flat",
      captions: "highlight", animations: ["pop_in", "slide_in", "fade_up"], transitions: ["shape_wipe"],
      characters: ["stickman_outfit"] }),
  },
  {
    slot: S.MotionStyle, id: Isometric, name: "Isométrico",
    description: "Mundos isométricos que se construyen pieza a pieza; ideal para explicar procesos.",
    tags: ["explicativo", "3d", "procesos"],
    payload: kit({ palette: "iso_blueprint", composition: "iso_grid", typography: "clean_sans", render_style: "iso_flat",
      captions: "minimal", animations: ["iso_rise", "pop_in"], transitions: ["zoom_through"], scenario: "iso_city" }),
  },
  {
    slot: S.MotionStyle, id: Anime, name: "Anime",
    description: "Cel shading, líneas de velocidad, cielos saturados y cortes con impacto.",
    tags: ["dinámico", "juvenil"],
    payload: kit({ palette: "anime_sky", composition: "asymmetric", typography: "brush_display", render_style: "cel_anime",
      captions: "pop_word", animations: ["speed_lines", "pop_in"], transitions: ["flash_cut"], characters: ["chibi"] }),
  },
  {
    slot: S.MotionStyle, id: Cartoon, name: "Cartoon",
    description: "Formas blanditas, squash & stretch, contornos gruesos y colores de juguete.",
    tags: ["divertido", "cercano"],
    payload: kit({ palette: "toybox", composition: "centered", typography: "rounded_display", render_style: "toon_outline",
      captions: "sticker", animations: ["squash_stretch", "wobble", "pop_in"], transitions: ["shape_wipe"],
      characters: ["stickman_plain", "blob"] }),
  },
  {
    slot: S.MotionStyle, id: PaperCut, name: "Paper cut",
    description: "Capas de papel recortado con sombras reales, textura y movimientos de stop motion.",
    tags: ["artesanal", "cálido"],
    payload: kit({ palette: "kraft", composition: "layered", typography: "cut_letters", render_style: "paper_cut",
      captions: "minimal", animations: ["paper_flutter", "slide_in"], transitions: ["page_flip"] }),
  },

  // ── Paletas ─────────────────────────────────────────────────────────────
  { slot: S.Palette, id: "mono_light", name: "Mono claro", description: "Blancos, grises y un acento azul.", fits: [Apple, Isometric],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#f5f5f7", "#ffffff", "#1d1d1f", "#0071e3", "#1d1d1f"]) },
  { slot: S.Palette, id: "midnight", name: "Medianoche", description: "Oscuro elegante con acento violeta.", fits: [Apple, Startup, Anime],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#0b0b12", "#1a1a26", "#7c5cff", "#22d3ee", "#f4f4f6"]) },
  { slot: S.Palette, id: "startup_green", name: "Verde startup", description: "Verde de marca, crema y negro.", fits: [Startup, Cartoon],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#f4f1ea", "#ffffff", "#16a34a", "#fbbf24", "#0f172a"]) },
  { slot: S.Palette, id: "sunset", name: "Atardecer", description: "Naranjas y rosas cálidos.",
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#fff1e6", "#ffffff", "#ff6b35", "#ff3d7f", "#2b1b17"]) },
  { slot: S.Palette, id: "pastel_pop", name: "Pastel pop", description: "Lilas, amarillos y rosas suaves.", fits: [Cartoon, PaperCut, Startup],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#fdf2f8", "#ffffff", "#a78bfa", "#fbbf24", "#3b0764"]) },
  { slot: S.Palette, id: "anime_sky", name: "Cielo anime", description: "Azules saturados y blanco nube.", fits: [Anime],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#4aa8ff", "#ffffff", "#ff4d6d", "#ffd23f", "#0d1b2a"]) },
  { slot: S.Palette, id: "toybox", name: "Caja de juguetes", description: "Primarios vivos sobre amarillo.", fits: [Cartoon],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#ffd60a", "#ffffff", "#ff3b30", "#2563eb", "#111111"]) },
  { slot: S.Palette, id: "kraft", name: "Kraft", description: "Papel kraft, cartulinas terrosas y tinta.", fits: [PaperCut],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#d9c3a0", "#f3e9d8", "#c2553a", "#3f7d6e", "#2a211b"]) },
  { slot: S.Palette, id: "iso_blueprint", name: "Blueprint", description: "Azules técnicos con acento coral.", fits: [Isometric],
    engine: EngineSupport.Supported, version: 2,
    payload: palette(["#e8f0fb", "#ffffff", "#2f6fed", "#ff7a59", "#13213c"]) },

  // ── Composición ─────────────────────────────────────────────────────────
  { slot: S.Composition, id: "centered", name: "Centrada", description: "Protagonista en el centro, simetría y aire." },
  { slot: S.Composition, id: "asymmetric", name: "Asimétrica", description: "Peso a un lado, texto al otro; tensión y dinamismo.",
    fits: [Startup, Anime], payload: { anchors: { hero: [0.32, 0.45], text: [0.7, 0.62] } } },
  { slot: S.Composition, id: "split", name: "Split", description: "Pantalla partida en dos bloques que dialogan." },
  { slot: S.Composition, id: "negative_space", name: "Hueco", description: "Un gran hueco que enmarca al protagonista.",
    fits: [Startup, Apple] },
  { slot: S.Composition, id: "iso_grid", name: "Rejilla isométrica", description: "Todo se alinea a una rejilla de 30°.", fits: [Isometric] },
  { slot: S.Composition, id: "layered", name: "Capas", description: "Planos superpuestos con profundidad.", fits: [PaperCut, Cartoon] },

  // ── Tipografía ──────────────────────────────────────────────────────────
  { slot: S.Typography, id: "clean_sans", name: "Sans limpia", description: "Inter, pesos medios, titulares grandes.",
    payload: { family: "Inter", body: 500, heading: 600 } },
  { slot: S.Typography, id: "grotesk_bold", name: "Grotesca", description: "Grotesca compacta y contundente.", fits: [Startup],
    payload: { family: "Space Grotesk", body: 500, heading: 700 } },
  { slot: S.Typography, id: "rounded_display", name: "Redondeada", description: "Display redonda y amable.", fits: [Cartoon],
    payload: { family: "Baloo 2", body: 500, heading: 800 } },
  { slot: S.Typography, id: "brush_display", name: "Pincel", description: "Rotulación con trazo de pincel.", fits: [Anime],
    payload: { family: "Dela Gothic One", body: 400, heading: 400 } },
  { slot: S.Typography, id: "cut_letters", name: "Letras recortadas", description: "Letras que parecen cortadas a tijera.", fits: [PaperCut],
    payload: { family: "Fraunces", body: 500, heading: 700 } },

  // ── Estilo de render ────────────────────────────────────────────────────
  { slot: S.RenderStyle, id: "flat", name: "Flat", description: "Color plano, sin sombras.", engine: EngineSupport.Supported },
  { slot: S.RenderStyle, id: "soft_depth", name: "Profundidad suave", description: "Sombras difusas y brillos sutiles.", fits: [Apple, Startup] },
  { slot: S.RenderStyle, id: "toon_outline", name: "Toon con contorno", description: "Contornos gruesos y sombra en dos tonos.",
    fits: [Cartoon], params: [{ key: "outline", label: "Grosor del contorno", type: ParamType.Number, default: 6, min: 0, max: 20 }] },
  { slot: S.RenderStyle, id: "cel_anime", name: "Cel anime", description: "Cel shading con brillo duro y tramas.", fits: [Anime] },
  { slot: S.RenderStyle, id: "paper_cut", name: "Papel recortado", description: "Textura de papel, bordes irregulares y sombra proyectada.",
    fits: [PaperCut], params: [{ key: "shadow", label: "Sombra", type: ParamType.Number, default: 1, min: 0, max: 2 }] },
  { slot: S.RenderStyle, id: "iso_flat", name: "Iso flat", description: "Caras planas con tres tonos por volumen.", fits: [Isometric] },

  // ── Subtítulos ──────────────────────────────────────────────────────────
  { slot: S.Captions, id: "minimal", name: "Minimal", description: "Texto limpio abajo, frase a frase." },
  { slot: S.Captions, id: "karaoke", name: "Karaoke", description: "La palabra hablada se ilumina." },
  { slot: S.Captions, id: "pop_word", name: "Pop", description: "Palabra a palabra con rebote.", fits: [Anime, Startup, Cartoon] },
  { slot: S.Captions, id: "highlight", name: "Highlight", description: "Resalta las palabras clave con un bloque de color.", fits: [Startup] },
  { slot: S.Captions, id: "sticker", name: "Pegatina", description: "Palabras como pegatinas con borde blanco.", fits: [Cartoon] },

  // ── Animaciones ─────────────────────────────────────────────────────────
  { slot: S.Animation, id: "fade_up", name: "Fade up", description: "Aparece subiendo un poco.", params: [speed],
    payload: { keys: { opacity: [[0, 0], [0.45, 1]], dy: [[0, 40, "ease_out"], [0.45, 0]] } } },
  { slot: S.Animation, id: "pop_in", name: "Pop in", description: "Escala desde cero con rebote.", params: [speed, intensity],
    payload: { keys: { scale: [[0, 0, "back"], [0.5, 1]] } } },
  { slot: S.Animation, id: "slide_in", name: "Slide in", description: "Entra deslizando desde un lado.", params: [speed,
      { key: "from", label: "Desde", type: ParamType.Choice, default: "left", options: ["left", "right", "top", "bottom"] }],
    payload: { keys: { dx: [[0, -600, "ease_out"], [0.6, 0]] } } },
  { slot: S.Animation, id: "mask_reveal", name: "Revelado con máscara", description: "Se descubre tras una máscara.", fits: [Apple, Startup] },
  { slot: S.Animation, id: "squash_stretch", name: "Squash & stretch", description: "Aplasta y estira al aterrizar.", fits: [Cartoon], params: [intensity] },
  { slot: S.Animation, id: "wobble", name: "Wobble", description: "Bamboleo blandito en reposo.", fits: [Cartoon], params: [intensity] },
  { slot: S.Animation, id: "speed_lines", name: "Líneas de velocidad", description: "Fondo de líneas radiales al entrar.", fits: [Anime] },
  { slot: S.Animation, id: "paper_flutter", name: "Papel al viento", description: "Ondea y se asienta como papel.", fits: [PaperCut] },
  { slot: S.Animation, id: "iso_rise", name: "Iso rise", description: "Los bloques crecen desde el suelo.", fits: [Isometric] },
  { slot: S.Animation, id: "typewriter", name: "Máquina de escribir", description: "El texto aparece letra a letra." },

  // ── Transiciones ────────────────────────────────────────────────────────
  { slot: S.Transition, id: "shape_wipe", name: "Barrido de forma", description: "Una forma de color cruza y cambia la escena." },
  { slot: S.Transition, id: "zoom_through", name: "Zoom a través", description: "La cámara atraviesa un elemento hacia la siguiente escena." },
  { slot: S.Transition, id: "page_flip", name: "Pasar página", description: "La escena se pasa como una hoja.", fits: [PaperCut] },
  { slot: S.Transition, id: "flash_cut", name: "Corte con flash", description: "Destello blanco con impacto.", fits: [Anime] },

  // ── Personajes ──────────────────────────────────────────────────────────
  { slot: S.Character, id: "stickman_plain", name: "Monigote liso", description: "Monigote sin manos ni pies, de un color." },
  { slot: S.Character, id: "stickman_outfit", name: "Monigote con ropa", description: "El mismo monigote con presets de ropa.",
    params: [{ key: "outfit", label: "Ropa", type: ParamType.Choice, default: "casual", options: ["casual", "doctor", "office", "sport"] }] },
  { slot: S.Character, id: "blob", name: "Blob", description: "Criatura blandita y expresiva.", fits: [Cartoon] },
  { slot: S.Character, id: "chibi", name: "Chibi", description: "Personaje cabezón estilo anime.", fits: [Anime] },

  // ── Escenarios ──────────────────────────────────────────────────────────
  { slot: S.Scenario, id: "empty_studio", name: "Estudio vacío", description: "Ciclorama infinito, luz suave." },
  { slot: S.Scenario, id: "clinic_room", name: "Consulta", description: "Sala de consulta con camilla." },
  { slot: S.Scenario, id: "office", name: "Oficina", description: "Escritorios, plantas y pantallas." },
  { slot: S.Scenario, id: "iso_city", name: "Ciudad isométrica", description: "Manzanas que se levantan pieza a pieza.", fits: [Isometric] },
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
