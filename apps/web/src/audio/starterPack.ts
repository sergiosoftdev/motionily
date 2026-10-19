import { FilterKind, Wave, type SoundRecipe } from "./synth";

export const SoundCategory = {
  Whoosh: "whoosh",
  Pop: "pop",
  Click: "click",
  Riser: "riser",
  Impact: "impact",
  Chime: "chime",
  Glitch: "glitch",
  Ui: "ui",
  Texture: "texture",
} as const;
export type SoundCategory = (typeof SoundCategory)[keyof typeof SoundCategory];

export const CATEGORY_LABEL: Record<SoundCategory, string> = {
  whoosh: "Whoosh",
  pop: "Pop",
  click: "Click",
  riser: "Riser",
  impact: "Impacto",
  chime: "Campana",
  glitch: "Glitch",
  ui: "Interfaz",
  texture: "Textura",
};

export type StarterSound = { name: string; category: SoundCategory; description: string; recipe: SoundRecipe };

const N = Wave.Noise;
const { Low, High, Band } = FilterKind;

/** The first library a user gets: everyday motion-graphics sounds, all synthesized. */
export const STARTER_PACK: StarterSound[] = [
  // Whooshes: filtered noise sweeps
  { name: "whoosh_rapido", category: "whoosh", description: "Paso rápido de un elemento cruzando la pantalla", recipe: { duration: 0.35, voices: [{ wave: N, gain: 0.7, attack: 0.12, decay: 0.2, release: 0.05, filter: { kind: Band, freq: [400, 3500], q: 2.5 } }] } },
  { name: "whoosh_largo", category: "whoosh", description: "Transición amplia, entra y sale", recipe: { duration: 0.9, reverb: 0.3, voices: [{ wave: N, gain: 0.6, attack: 0.45, decay: 0.4, release: 0.05, filter: { kind: Band, freq: [250, 2400], q: 1.5 } }] } },
  { name: "whoosh_inverso", category: "whoosh", description: "Barrido que se acerca y corta en seco", recipe: { duration: 0.6, voices: [{ wave: N, gain: 0.7, attack: 0.55, decay: 0.02, release: 0.02, filter: { kind: Band, freq: [300, 5000], q: 3 } }] } },
  { name: "swoosh_grave", category: "whoosh", description: "Paso pesado, para bloques grandes de color", recipe: { duration: 0.5, voices: [{ wave: N, gain: 0.8, attack: 0.15, decay: 0.3, filter: { kind: Low, freq: [200, 1200], q: 4 } }, { wave: Wave.Sine, freq: [90, 45], gain: 0.35, attack: 0.1, decay: 0.35 }] } },
  { name: "swipe", category: "whoosh", description: "Deslizar tarjeta o pantalla", recipe: { duration: 0.22, voices: [{ wave: N, gain: 0.6, attack: 0.05, decay: 0.15, filter: { kind: High, freq: [1500, 6000], q: 1 } }] } },
  // Pops
  { name: "pop", category: "pop", description: "Aparición con rebote de un elemento", recipe: { duration: 0.15, voices: [{ wave: Wave.Sine, freq: [900, 250], gain: 0.8, attack: 0.002, decay: 0.12 }] } },
  { name: "pop_agudo", category: "pop", description: "Pop pequeño para puntos e iconos", recipe: { duration: 0.1, voices: [{ wave: Wave.Sine, freq: [1800, 700], gain: 0.6, attack: 0.001, decay: 0.08 }] } },
  { name: "burbuja", category: "pop", description: "Pop redondo y blando", recipe: { duration: 0.2, voices: [{ wave: Wave.Sine, freq: [300, 1100], gain: 0.6, attack: 0.005, decay: 0.15, wobble: { rate: 30, depth: 40 } }] } },
  { name: "pop_doble", category: "pop", description: "Dos pops seguidos, para pares de elementos", recipe: { duration: 0.25, voices: [{ wave: Wave.Sine, freq: [1000, 300], gain: 0.7, decay: 0.08 }, { wave: Wave.Sine, freq: [1300, 400], gain: 0.6, start: 0.1, decay: 0.08 }] } },
  // Clicks & ticks
  { name: "click", category: "click", description: "Click de botón o cursor", recipe: { duration: 0.05, voices: [{ wave: N, gain: 0.8, attack: 0.001, decay: 0.03, filter: { kind: High, freq: 3000, q: 1 } }, { wave: Wave.Sine, freq: 2200, gain: 0.3, decay: 0.02 }] } },
  { name: "tick", category: "click", description: "Tic de reloj o contador", recipe: { duration: 0.04, voices: [{ wave: Wave.Square, freq: 3200, gain: 0.25, attack: 0.001, decay: 0.02, filter: { kind: Band, freq: 3200, q: 8 } }] } },
  { name: "tecleo", category: "click", description: "Tecla de teclado (repítelo por letra)", recipe: { duration: 0.06, voices: [{ wave: N, gain: 0.6, decay: 0.04, filter: { kind: Band, freq: 2500, q: 3 } }, { wave: Wave.Sine, freq: [500, 300], gain: 0.25, decay: 0.03 }] } },
  { name: "interruptor", category: "click", description: "Toggle encendido/apagado", recipe: { duration: 0.12, voices: [{ wave: N, gain: 0.7, decay: 0.02, filter: { kind: High, freq: 2500 } }, { wave: N, gain: 0.5, start: 0.06, decay: 0.02, filter: { kind: High, freq: 3500 } }] } },
  // Risers
  { name: "riser", category: "riser", description: "Tensión que sube antes de una revelación", recipe: { duration: 2, reverb: 0.4, voices: [{ wave: Wave.Saw, freq: [110, 880], gain: 0.25, attack: 1.8, decay: 0.1, filter: { kind: Low, freq: [400, 6000], q: 6 } }, { wave: N, gain: 0.3, attack: 1.9, decay: 0.05, filter: { kind: High, freq: [500, 8000] } }] } },
  { name: "riser_corto", category: "riser", description: "Subida breve antes de un corte", recipe: { duration: 0.8, voices: [{ wave: N, gain: 0.5, attack: 0.75, decay: 0.03, filter: { kind: Band, freq: [600, 9000], q: 2 } }] } },
  { name: "carga", category: "riser", description: "Barra de carga o contador que sube", recipe: { duration: 1.2, voices: [{ wave: Wave.Triangle, freq: [220, 1320], gain: 0.3, attack: 0.05, decay: 1.1, sustain: 0.6, wobble: { rate: 12, depth: 15 } }] } },
  // Impacts
  { name: "impacto", category: "impact", description: "Golpe al aterrizar un titular", recipe: { duration: 0.8, reverb: 0.35, voices: [{ wave: Wave.Sine, freq: [140, 40], gain: 1, attack: 0.002, decay: 0.6 }, { wave: N, gain: 0.6, decay: 0.1, filter: { kind: Low, freq: [3000, 300] } }] } },
  { name: "boom_sub", category: "impact", description: "Sub grave para momentos grandes", recipe: { duration: 1.4, voices: [{ wave: Wave.Sine, freq: [70, 30], gain: 1, attack: 0.005, decay: 1.3 }] } },
  { name: "golpe_seco", category: "impact", description: "Golpe corto y seco, para cortes", recipe: { duration: 0.25, drive: 0.4, voices: [{ wave: Wave.Sine, freq: [200, 60], gain: 0.9, decay: 0.18 }, { wave: N, gain: 0.5, decay: 0.04, filter: { kind: Low, freq: 2500 } }] } },
  { name: "cierre_logo", category: "impact", description: "Golpe con cola para el logo final", recipe: { duration: 2, reverb: 0.7, voices: [{ wave: Wave.Sine, freq: [110, 55], gain: 0.9, decay: 1.2 }, { wave: Wave.Triangle, freq: 880, gain: 0.25, decay: 1.5 }, { wave: Wave.Triangle, freq: 1320, gain: 0.15, decay: 1.4 }] } },
  // Chimes
  { name: "ding", category: "chime", description: "Acierto, check, dato positivo", recipe: { duration: 1, reverb: 0.3, voices: [{ wave: Wave.Sine, freq: 1320, gain: 0.5, attack: 0.002, decay: 0.9 }, { wave: Wave.Sine, freq: 2640, gain: 0.15, decay: 0.5 }] } },
  { name: "exito", category: "chime", description: "Dos notas ascendentes de éxito", recipe: { duration: 0.8, reverb: 0.3, voices: [{ wave: Wave.Triangle, freq: 880, gain: 0.45, decay: 0.3 }, { wave: Wave.Triangle, freq: 1320, gain: 0.45, start: 0.12, decay: 0.6 }] } },
  { name: "notificacion", category: "chime", description: "Aviso de notificación del móvil", recipe: { duration: 0.6, voices: [{ wave: Wave.Sine, freq: 1046, gain: 0.45, decay: 0.15 }, { wave: Wave.Sine, freq: 1568, gain: 0.45, start: 0.1, decay: 0.4 }] } },
  { name: "brillo", category: "chime", description: "Destello mágico, para resaltar", recipe: { duration: 1.2, reverb: 0.5, voices: [0, 0.06, 0.12, 0.18, 0.24].map((t, i) => ({ wave: Wave.Sine, freq: 1500 + i * 400, gain: 0.25, start: t, decay: 0.5 })) } },
  { name: "error", category: "chime", description: "Algo sale mal, dato negativo", recipe: { duration: 0.5, voices: [{ wave: Wave.Square, freq: 220, gain: 0.25, decay: 0.15, filter: { kind: Low, freq: 1500 } }, { wave: Wave.Square, freq: 185, gain: 0.25, start: 0.16, decay: 0.25, filter: { kind: Low, freq: 1500 } }] } },
  // Glitches
  { name: "glitch", category: "glitch", description: "Corte digital roto", recipe: { duration: 0.3, drive: 0.6, voices: [0, 0.05, 0.11, 0.19].map((t, i) => ({ wave: i % 2 ? Wave.Square : N, freq: 200 + i * 700, gain: 0.5, start: t, length: 0.04, decay: 0.03 })) } },
  { name: "estatica", category: "glitch", description: "Ráfaga de estática", recipe: { duration: 0.4, voices: [{ wave: N, gain: 0.5, attack: 0.01, decay: 0.3, filter: { kind: Band, freq: [6000, 2000], q: 0.8 } }] } },
  { name: "bip_datos", category: "glitch", description: "Pitidos de datos, para pantallas técnicas", recipe: { duration: 0.5, voices: [0, 0.07, 0.14, 0.21, 0.28].map((t, i) => ({ wave: Wave.Square, freq: [2400, 1800, 3000, 2100, 2700][i]!, gain: 0.15, start: t, length: 0.05, decay: 0.04 })) } },
  // UI
  { name: "abrir_panel", category: "ui", description: "Un panel o modal que se abre", recipe: { duration: 0.3, voices: [{ wave: Wave.Sine, freq: [400, 900], gain: 0.4, attack: 0.01, decay: 0.25 }, { wave: N, gain: 0.25, decay: 0.15, filter: { kind: High, freq: 4000 } }] } },
  { name: "cerrar_panel", category: "ui", description: "Un panel que se cierra", recipe: { duration: 0.3, voices: [{ wave: Wave.Sine, freq: [900, 350], gain: 0.4, attack: 0.01, decay: 0.25 }] } },
  { name: "hover", category: "ui", description: "Cursor sobre un botón", recipe: { duration: 0.08, voices: [{ wave: Wave.Sine, freq: 2000, gain: 0.2, decay: 0.06 }] } },
  // Textures
  { name: "zumbido_tech", category: "texture", description: "Fondo tecnológico continuo (cama)", recipe: { duration: 4, volume: 0.5, voices: [{ wave: Wave.Saw, freq: 55, gain: 0.2, attack: 0.5, sustain: 1, decay: 0.1, release: 0.5, filter: { kind: Low, freq: 400, q: 2 }, wobble: { rate: 0.3, depth: 2 } }, { wave: N, gain: 0.05, attack: 0.5, sustain: 1, release: 0.5, filter: { kind: Band, freq: 1200, q: 0.7 } }] } },
  { name: "aire", category: "texture", description: "Ambiente suave para planos tranquilos", recipe: { duration: 4, volume: 0.5, voices: [{ wave: N, gain: 0.15, attack: 1, sustain: 1, decay: 0.1, release: 1, filter: { kind: Low, freq: [600, 900], q: 0.5 } }] } },
];
