import { GRADE_NEUTRAL, LOOKS, OpName, effectsWithGrade, type Op } from "@motionily/protocol";

/** The engine's color effect (`{"fx":"color", …}`, crates/scene/src/paint.rs). */
export const COLOR_FX = "color";

/** Grade fields the editor exposes, with their neutral value and slider range. */
export const GradeField = {
  Exposure: "exposure",
  Contrast: "contrast",
  Highlights: "highlights",
  Shadows: "shadows",
  Temperature: "temperature",
  Tint: "tint",
  Saturation: "saturation",
  Vibrance: "vibrance",
  Vignette: "vignette",
} as const;
export type GradeField = (typeof GradeField)[keyof typeof GradeField];

export type Grade = Record<GradeField, number>;
// The field names match GRADE_NEUTRAL in @motionily/protocol (shared with agents).

type FieldSpec = { label: string; neutral: number; min: number; max: number; step: number; format: (v: number) => string };

const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
const percent = (v: number) => `${Math.round(v * 100)}%`;

export const GRADE_FIELDS: Record<GradeField, FieldSpec> = {
  [GradeField.Exposure]: { label: "Exposure", neutral: 0, min: -2, max: 2, step: 0.05, format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV` },
  [GradeField.Contrast]: { label: "Contrast", neutral: 1, min: 0.5, max: 1.6, step: 0.01, format: percent },
  [GradeField.Highlights]: { label: "Highlights", neutral: 0, min: -1, max: 1, step: 0.02, format: signed },
  [GradeField.Shadows]: { label: "Shadows", neutral: 0, min: -1, max: 1, step: 0.02, format: signed },
  [GradeField.Temperature]: { label: "Temperature", neutral: 0, min: -1, max: 1, step: 0.02, format: signed },
  [GradeField.Tint]: { label: "Tint", neutral: 0, min: -1, max: 1, step: 0.02, format: signed },
  [GradeField.Saturation]: { label: "Saturation", neutral: 1, min: 0, max: 2, step: 0.01, format: percent },
  [GradeField.Vibrance]: { label: "Vibrance", neutral: 0, min: -1, max: 1, step: 0.02, format: signed },
  [GradeField.Vignette]: { label: "Vignette", neutral: 0, min: 0, max: 1, step: 0.02, format: percent },
};

/** Groups shown together, like a grading panel's sections. */
export const GRADE_GROUPS: { title: string; fields: GradeField[] }[] = [
  { title: "Light", fields: [GradeField.Exposure, GradeField.Contrast, GradeField.Highlights, GradeField.Shadows] },
  { title: "Color", fields: [GradeField.Temperature, GradeField.Tint, GradeField.Saturation, GradeField.Vibrance] },
  { title: "Effects", fields: [GradeField.Vignette] },
];

export const NEUTRAL_GRADE: Grade = { ...GRADE_NEUTRAL };

/** Looks, shared with agents (`apply_look`) through @motionily/protocol. */
export const GRADE_PRESETS = LOOKS;

type Effect = Record<string, unknown> & { fx?: string };

/** The clip's grade (neutral fields filled in), and whether any field is animated (keys or expressions). */
export function readGrade(layer: Record<string, unknown> | undefined): { grade: Grade; animated: boolean } {
  const fx = ((layer?.effects as Effect[] | undefined) ?? []).find((e) => e.fx === COLOR_FX);
  const grade = { ...NEUTRAL_GRADE };
  let animated = false;
  for (const f of Object.values(GradeField)) {
    const v = fx?.[f];
    if (typeof v === "number") grade[f] = v;
    else if (v !== undefined) animated = true;
  }
  return { grade, animated };
}

/** The layer's effects with its color effect set to `grade` (dropped when neutral); other effects stay. */
export function withGrade(layer: Record<string, unknown> | undefined, grade: Grade): Effect[] {
  return effectsWithGrade(layer?.effects as unknown[] | undefined, grade) as Effect[];
}

/** Ops that give each layer `grade`. */
export function gradeOps(layers: { id: string; layer: Record<string, unknown> | undefined }[], grade: Grade): Op[] {
  return layers.map(({ id, layer }) => ({ op: OpName.Patch, id, fields: { effects: withGrade(layer, grade) } }));
}

export function presetGrade(p: Partial<Grade>): Grade {
  return { ...NEUTRAL_GRADE, ...p };
}
