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
  impact: "Impact",
  chime: "Chime",
  glitch: "Glitch",
  ui: "UI",
  texture: "Texture",
};

export type StarterSound = { name: string; category: SoundCategory; description: string; recipe: SoundRecipe };

const N = Wave.Noise;
const { Low, High, Band } = FilterKind;

/** The first library a user gets: everyday motion-graphics sounds, all synthesized. */
export const STARTER_PACK: StarterSound[] = [
  // Whooshes: filtered noise sweeps
  { name: "whoosh_fast", category: "whoosh", description: "Fast pass of an element crossing the screen", recipe: { duration: 0.35, voices: [{ wave: N, gain: 0.7, attack: 0.12, decay: 0.2, release: 0.05, filter: { kind: Band, freq: [400, 3500], q: 2.5 } }] } },
  { name: "whoosh_long", category: "whoosh", description: "Wide transition, in and out", recipe: { duration: 0.9, reverb: 0.3, voices: [{ wave: N, gain: 0.6, attack: 0.45, decay: 0.4, release: 0.05, filter: { kind: Band, freq: [250, 2400], q: 1.5 } }] } },
  { name: "whoosh_reverse", category: "whoosh", description: "Sweep that builds up and cuts off sharply", recipe: { duration: 0.6, voices: [{ wave: N, gain: 0.7, attack: 0.55, decay: 0.02, release: 0.02, filter: { kind: Band, freq: [300, 5000], q: 3 } }] } },
  { name: "swoosh_deep", category: "whoosh", description: "Heavy pass, for big blocks of color", recipe: { duration: 0.5, voices: [{ wave: N, gain: 0.8, attack: 0.15, decay: 0.3, filter: { kind: Low, freq: [200, 1200], q: 4 } }, { wave: Wave.Sine, freq: [90, 45], gain: 0.35, attack: 0.1, decay: 0.35 }] } },
  { name: "swipe", category: "whoosh", description: "Card or screen swipe", recipe: { duration: 0.22, voices: [{ wave: N, gain: 0.6, attack: 0.05, decay: 0.15, filter: { kind: High, freq: [1500, 6000], q: 1 } }] } },
  // Pops
  { name: "pop", category: "pop", description: "Bouncy pop-in of an element", recipe: { duration: 0.15, voices: [{ wave: Wave.Sine, freq: [900, 250], gain: 0.8, attack: 0.002, decay: 0.12 }] } },
  { name: "pop_high", category: "pop", description: "Small pop for dots and icons", recipe: { duration: 0.1, voices: [{ wave: Wave.Sine, freq: [1800, 700], gain: 0.6, attack: 0.001, decay: 0.08 }] } },
  { name: "bubble", category: "pop", description: "Round, soft pop", recipe: { duration: 0.2, voices: [{ wave: Wave.Sine, freq: [300, 1100], gain: 0.6, attack: 0.005, decay: 0.15, wobble: { rate: 30, depth: 40 } }] } },
  { name: "pop_double", category: "pop", description: "Two pops in a row, for pairs of elements", recipe: { duration: 0.25, voices: [{ wave: Wave.Sine, freq: [1000, 300], gain: 0.7, decay: 0.08 }, { wave: Wave.Sine, freq: [1300, 400], gain: 0.6, start: 0.1, decay: 0.08 }] } },
  // Clicks & ticks
  { name: "click", category: "click", description: "Button or cursor click", recipe: { duration: 0.05, voices: [{ wave: N, gain: 0.8, attack: 0.001, decay: 0.03, filter: { kind: High, freq: 3000, q: 1 } }, { wave: Wave.Sine, freq: 2200, gain: 0.3, decay: 0.02 }] } },
  { name: "tick", category: "click", description: "Clock or counter tick", recipe: { duration: 0.04, voices: [{ wave: Wave.Square, freq: 3200, gain: 0.25, attack: 0.001, decay: 0.02, filter: { kind: Band, freq: 3200, q: 8 } }] } },
  { name: "keystroke", category: "click", description: "Keyboard key (repeat it per letter)", recipe: { duration: 0.06, voices: [{ wave: N, gain: 0.6, decay: 0.04, filter: { kind: Band, freq: 2500, q: 3 } }, { wave: Wave.Sine, freq: [500, 300], gain: 0.25, decay: 0.03 }] } },
  { name: "toggle", category: "click", description: "On/off toggle", recipe: { duration: 0.12, voices: [{ wave: N, gain: 0.7, decay: 0.02, filter: { kind: High, freq: 2500 } }, { wave: N, gain: 0.5, start: 0.06, decay: 0.02, filter: { kind: High, freq: 3500 } }] } },
  // Risers
  { name: "riser", category: "riser", description: "Tension rising before a reveal", recipe: { duration: 2, reverb: 0.4, voices: [{ wave: Wave.Saw, freq: [110, 880], gain: 0.25, attack: 1.8, decay: 0.1, filter: { kind: Low, freq: [400, 6000], q: 6 } }, { wave: N, gain: 0.3, attack: 1.9, decay: 0.05, filter: { kind: High, freq: [500, 8000] } }] } },
  { name: "riser_short", category: "riser", description: "Short rise before a cut", recipe: { duration: 0.8, voices: [{ wave: N, gain: 0.5, attack: 0.75, decay: 0.03, filter: { kind: Band, freq: [600, 9000], q: 2 } }] } },
  { name: "loading", category: "riser", description: "Loading bar or counter going up", recipe: { duration: 1.2, voices: [{ wave: Wave.Triangle, freq: [220, 1320], gain: 0.3, attack: 0.05, decay: 1.1, sustain: 0.6, wobble: { rate: 12, depth: 15 } }] } },
  // Impacts
  { name: "impact", category: "impact", description: "Hit as a headline lands", recipe: { duration: 0.8, reverb: 0.35, voices: [{ wave: Wave.Sine, freq: [140, 40], gain: 1, attack: 0.002, decay: 0.6 }, { wave: N, gain: 0.6, decay: 0.1, filter: { kind: Low, freq: [3000, 300] } }] } },
  { name: "boom_sub", category: "impact", description: "Deep sub for big moments", recipe: { duration: 1.4, voices: [{ wave: Wave.Sine, freq: [70, 30], gain: 1, attack: 0.005, decay: 1.3 }] } },
  { name: "hit_dry", category: "impact", description: "Short, dry hit for cuts", recipe: { duration: 0.25, drive: 0.4, voices: [{ wave: Wave.Sine, freq: [200, 60], gain: 0.9, decay: 0.18 }, { wave: N, gain: 0.5, decay: 0.04, filter: { kind: Low, freq: 2500 } }] } },
  { name: "logo_sting", category: "impact", description: "Hit with a tail for the final logo", recipe: { duration: 2, reverb: 0.7, voices: [{ wave: Wave.Sine, freq: [110, 55], gain: 0.9, decay: 1.2 }, { wave: Wave.Triangle, freq: 880, gain: 0.25, decay: 1.5 }, { wave: Wave.Triangle, freq: 1320, gain: 0.15, decay: 1.4 }] } },
  // Chimes
  { name: "ding", category: "chime", description: "Success, check, positive number", recipe: { duration: 1, reverb: 0.3, voices: [{ wave: Wave.Sine, freq: 1320, gain: 0.5, attack: 0.002, decay: 0.9 }, { wave: Wave.Sine, freq: 2640, gain: 0.15, decay: 0.5 }] } },
  { name: "success", category: "chime", description: "Two rising success notes", recipe: { duration: 0.8, reverb: 0.3, voices: [{ wave: Wave.Triangle, freq: 880, gain: 0.45, decay: 0.3 }, { wave: Wave.Triangle, freq: 1320, gain: 0.45, start: 0.12, decay: 0.6 }] } },
  { name: "notification", category: "chime", description: "Phone notification alert", recipe: { duration: 0.6, voices: [{ wave: Wave.Sine, freq: 1046, gain: 0.45, decay: 0.15 }, { wave: Wave.Sine, freq: 1568, gain: 0.45, start: 0.1, decay: 0.4 }] } },
  { name: "sparkle", category: "chime", description: "Magic sparkle, to highlight", recipe: { duration: 1.2, reverb: 0.5, voices: [0, 0.06, 0.12, 0.18, 0.24].map((t, i) => ({ wave: Wave.Sine, freq: 1500 + i * 400, gain: 0.25, start: t, decay: 0.5 })) } },
  { name: "error", category: "chime", description: "Something goes wrong, negative number", recipe: { duration: 0.5, voices: [{ wave: Wave.Square, freq: 220, gain: 0.25, decay: 0.15, filter: { kind: Low, freq: 1500 } }, { wave: Wave.Square, freq: 185, gain: 0.25, start: 0.16, decay: 0.25, filter: { kind: Low, freq: 1500 } }] } },
  // Glitches
  { name: "glitch", category: "glitch", description: "Broken digital cut", recipe: { duration: 0.3, drive: 0.6, voices: [0, 0.05, 0.11, 0.19].map((t, i) => ({ wave: i % 2 ? Wave.Square : N, freq: 200 + i * 700, gain: 0.5, start: t, length: 0.04, decay: 0.03 })) } },
  { name: "static", category: "glitch", description: "Burst of static", recipe: { duration: 0.4, voices: [{ wave: N, gain: 0.5, attack: 0.01, decay: 0.3, filter: { kind: Band, freq: [6000, 2000], q: 0.8 } }] } },
  { name: "data_beeps", category: "glitch", description: "Data beeps, for tech screens", recipe: { duration: 0.5, voices: [0, 0.07, 0.14, 0.21, 0.28].map((t, i) => ({ wave: Wave.Square, freq: [2400, 1800, 3000, 2100, 2700][i]!, gain: 0.15, start: t, length: 0.05, decay: 0.04 })) } },
  // UI
  { name: "panel_open", category: "ui", description: "A panel or modal opening", recipe: { duration: 0.3, voices: [{ wave: Wave.Sine, freq: [400, 900], gain: 0.4, attack: 0.01, decay: 0.25 }, { wave: N, gain: 0.25, decay: 0.15, filter: { kind: High, freq: 4000 } }] } },
  { name: "panel_close", category: "ui", description: "A panel closing", recipe: { duration: 0.3, voices: [{ wave: Wave.Sine, freq: [900, 350], gain: 0.4, attack: 0.01, decay: 0.25 }] } },
  { name: "hover", category: "ui", description: "Cursor over a button", recipe: { duration: 0.08, voices: [{ wave: Wave.Sine, freq: 2000, gain: 0.2, decay: 0.06 }] } },
  // Textures
  { name: "tech_hum", category: "texture", description: "Continuous tech background (bed)", recipe: { duration: 4, volume: 0.5, voices: [{ wave: Wave.Saw, freq: 55, gain: 0.2, attack: 0.5, sustain: 1, decay: 0.1, release: 0.5, filter: { kind: Low, freq: 400, q: 2 }, wobble: { rate: 0.3, depth: 2 } }, { wave: N, gain: 0.05, attack: 0.5, sustain: 1, release: 0.5, filter: { kind: Band, freq: 1200, q: 0.7 } }] } },
  { name: "air", category: "texture", description: "Soft ambience for calm shots", recipe: { duration: 4, volume: 0.5, voices: [{ wave: N, gain: 0.15, attack: 1, sustain: 1, decay: 0.1, release: 1, filter: { kind: Low, freq: [600, 900], q: 0.5 } }] } },
];
