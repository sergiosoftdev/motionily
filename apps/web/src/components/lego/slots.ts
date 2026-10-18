import { BrickSlot } from "@motionily/protocol";

/** How each slot looks and reads in the UI. Order is the build order shown to the user. */
export const SLOTS: { slot: BrickSlot; label: string; hint: string; color: string }[] = [
  { slot: BrickSlot.MotionStyle, label: "Estilo de motion", hint: "La caja: trae piezas para todo lo demás", color: "#e5484d" },
  { slot: BrickSlot.Palette, label: "Paleta", hint: "Colores de todo el vídeo", color: "#f5a524" },
  { slot: BrickSlot.Composition, label: "Composición", hint: "Dónde cae cada cosa", color: "#3e63dd" },
  { slot: BrickSlot.Typography, label: "Tipografía", hint: "Letra de títulos y textos", color: "#30a46c" },
  { slot: BrickSlot.RenderStyle, label: "Acabado", hint: "Flat, toon, papel…", color: "#f76b15" },
  { slot: BrickSlot.Captions, label: "Subtítulos", hint: "Cómo aparecen las palabras", color: "#8e4ec6" },
  { slot: BrickSlot.Scenario, label: "Escenario", hint: "Fondo 3D (opcional)", color: "#12a594" },
  { slot: BrickSlot.Character, label: "Personajes", hint: "Puedes poner varios", color: "#d6409f" },
  { slot: BrickSlot.Animation, label: "Animaciones", hint: "El agente las usa para montar", color: "#7c9c1a" },
  { slot: BrickSlot.Transition, label: "Transiciones", hint: "Cómo se pasa de escena", color: "#0090ff" },
];

export const slotMeta = (slot: BrickSlot) => SLOTS.find((s) => s.slot === slot)!;
