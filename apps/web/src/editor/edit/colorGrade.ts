import { OpName, type Op } from "@motionily/protocol";

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

export const NEUTRAL_GRADE = Object.fromEntries(Object.entries(GRADE_FIELDS).map(([k, f]) => [k, f.neutral])) as Grade;

/** Looks, as plain grades: a preset is a starting point the sliders then refine. */
export const GRADE_PRESETS: { name: string; grade: Partial<Grade> }[] = [
  { name: "Natural", grade: {} },
  { name: "Warm", grade: { temperature: 0.35, vibrance: 0.15, highlights: -0.1 } },
  { name: "Cool", grade: { temperature: -0.35, tint: -0.05, contrast: 1.05 } },
  { name: "Cinematic", grade: { contrast: 1.15, highlights: -0.25, shadows: -0.1, temperature: -0.12, saturation: 0.9, vignette: 0.3 } },
  { name: "Punchy", grade: { contrast: 1.2, vibrance: 0.4, saturation: 1.1, shadows: -0.1 } },
  { name: "Faded", grade: { contrast: 0.85, shadows: 0.3, saturation: 0.8, highlights: -0.15 } },
  { name: "Vintage", grade: { temperature: 0.3, tint: 0.08, saturation: 0.75, contrast: 0.92, shadows: 0.2, vignette: 0.35 } },
  { name: "Moody", grade: { exposure: -0.3, contrast: 1.15, saturation: 0.75, temperature: -0.15, vignette: 0.45 } },
  { name: "B&W", grade: { saturation: 0, contrast: 1.2, vignette: 0.2 } },
];

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
  const others = ((layer?.effects as Effect[] | undefined) ?? []).filter((e) => e.fx !== COLOR_FX);
  const changed = Object.values(GradeField).filter((f) => Math.abs(grade[f] - GRADE_FIELDS[f].neutral) > 1e-4);
  if (!changed.length) return others;
  return [...others, { fx: COLOR_FX, ...Object.fromEntries(changed.map((f) => [f, Math.round(grade[f] * 1000) / 1000])) }];
}

/** Ops that give each layer `grade`. */
export function gradeOps(layers: { id: string; layer: Record<string, unknown> | undefined }[], grade: Grade): Op[] {
  return layers.map(({ id, layer }) => ({ op: OpName.Patch, id, fields: { effects: withGrade(layer, grade) } }));
}

export function presetGrade(p: Partial<Grade>): Grade {
  return { ...NEUTRAL_GRADE, ...p };
}
