import { BrickSlot, type Brick, type PalettePayload } from "@motionily/protocol";

export const SlotGroup = {
  Style: "style",
  Motion: "motion",
  Scene: "scene",
  Captions: "captions",
} as const;
export type SlotGroup = (typeof SlotGroup)[keyof typeof SlotGroup];

export const GROUP_LABEL: Record<SlotGroup, string> = {
  [SlotGroup.Style]: "Aspecto",
  [SlotGroup.Motion]: "Movimiento",
  [SlotGroup.Scene]: "Escena",
  [SlotGroup.Captions]: "Subtítulos",
};

/** Slots whose options are best chosen by looking at them (grid of thumbnails). */
export const VISUAL_SLOTS: BrickSlot[] = [BrickSlot.MotionStyle, BrickSlot.Palette, BrickSlot.Typography];

export const SLOT_UI: { slot: BrickSlot; label: string; group: SlotGroup; icon: string; sheetHint: string }[] = [
  { slot: BrickSlot.MotionStyle, label: "Estilo", group: SlotGroup.Style, icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", sheetHint: "Define el look general. Puede traer sus propias opciones para todo lo demás." },
  { slot: BrickSlot.Palette, label: "Colores", group: SlotGroup.Style, icon: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-.9-.7-1.4-.7-2.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3zM7.5 12a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3-4a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z", sheetHint: "La paleta de todo el vídeo." },
  { slot: BrickSlot.RenderStyle, label: "Acabado", group: SlotGroup.Style, icon: "M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z", sheetHint: "La textura: plano, toon, papel…" },
  { slot: BrickSlot.Typography, label: "Tipografía", group: SlotGroup.Style, icon: "M5 19 10 5h4l5 14M7.5 13h9", sheetHint: "La letra de títulos y textos." },
  { slot: BrickSlot.Composition, label: "Composición", group: SlotGroup.Motion, icon: "M4 4h16v16H4zM4 12h16M12 4v16", sheetHint: "Cómo se reparte la pantalla." },
  { slot: BrickSlot.Animation, label: "Animaciones", group: SlotGroup.Motion, icon: "M4 17c3-8 6-8 8-4s5 4 8-4", sheetHint: "Las que el agente puede usar. Elige varias." },
  { slot: BrickSlot.Transition, label: "Transiciones", group: SlotGroup.Motion, icon: "M4 12h12M12 6l6 6-6 6", sheetHint: "Cómo se pasa de una escena a otra. Elige varias." },
  { slot: BrickSlot.Scenario, label: "Escenario", group: SlotGroup.Scene, icon: "M3 20h18M5 20V9l7-5 7 5v11", sheetHint: "Fondo 3D. Opcional." },
  { slot: BrickSlot.Character, label: "Personajes", group: SlotGroup.Scene, icon: "M12 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM6 20c0-3.3 2.7-6 6-6s6 2.7 6 6", sheetHint: "Puedes elegir varios. Opcional." },
  { slot: BrickSlot.Captions, label: "Tipo", group: SlotGroup.Captions, icon: "M4 6h16v12H4zM7 14h4M13 14h4M7 10h10", sheetHint: "Cómo aparecen las palabras en pantalla." },
];

export const slotUi = (slot: BrickSlot) => SLOT_UI.find((s) => s.slot === slot)!;

type KitPayload = { defaults?: Partial<Record<BrickSlot, string | string[]>> };

/** Colors to preview a brick with: its own palette, or the default palette of a style. */
export function previewPalette(brick: Brick, byKey: Map<string, Brick>): PalettePayload | null {
  if (brick.slot === BrickSlot.Palette) return brick.payload as PalettePayload;
  if (brick.slot === BrickSlot.MotionStyle) {
    const key = (brick.payload as KitPayload).defaults?.[BrickSlot.Palette];
    const palette = typeof key === "string" ? byKey.get(key) : undefined;
    return palette ? (palette.payload as PalettePayload) : null;
  }
  return null;
}

/** Fits the chosen style explicitly (recommended), fits everything, or was made for other styles. */
export const FitLevel = { Recommended: 0, Neutral: 1, Other: 2 } as const;
export type FitLevel = (typeof FitLevel)[keyof typeof FitLevel];

export function fitLevel(brick: Brick, styleKey: string): FitLevel {
  if (brick.slot === BrickSlot.MotionStyle || brick.fits.length === 0) return FitLevel.Neutral;
  return brick.fits.includes(styleKey) ? FitLevel.Recommended : FitLevel.Other;
}
