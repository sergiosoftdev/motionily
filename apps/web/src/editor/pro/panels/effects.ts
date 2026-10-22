/**
 * Everything the engine can do to a layer's look, as AE names it: the effect stack (`effects`,
 * crates/scene/src/paint.rs `Effect`), layer styles (their own layer fields), blend modes and
 * track mattes. Menus, Effects & Presets and Effect Controls all read this one catalog.
 */

/** `fx` tag of each effect in a layer's `effects` list. */
export const EffectKind = {
  Blur: "blur",
  MotionBlur: "motion_blur",
  Glow: "glow",
  Shadow: "shadow",
  Color: "color",
  Chromatic: "chromatic",
  Wave: "wave",
  Turbulence: "turbulence",
  Grain: "grain",
  Glass: "glass",
  Shader: "shader",
} as const;
export type EffectKind = (typeof EffectKind)[keyof typeof EffectKind];

export const EffectCategory = {
  Blur: "Blur & Sharpen",
  Color: "Color Correction",
  Distort: "Distort",
  Noise: "Noise & Grain",
  Perspective: "Perspective",
  Stylize: "Stylize",
  Custom: "Custom",
} as const;
export type EffectCategory = (typeof EffectCategory)[keyof typeof EffectCategory];

/** How a param is edited: an animatable number (stopwatch), a plain number, a color, or code. */
export const ParamKind = { Anim: "anim", Fixed: "fixed", Color: "color", Code: "code", Params: "params" } as const;
export type ParamKind = (typeof ParamKind)[keyof typeof ParamKind];

export type ParamDef = {
  key: string;
  label: string;
  kind: ParamKind;
  /** Value of a new effect; `undefined` leaves the field out (an optional color = automatic). */
  def?: unknown;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  decimals?: number;
  /** Whole numbers only. */
  integer?: boolean;
};

export type EffectDef = { kind: EffectKind; name: string; category: EffectCategory; hint: string; params: ParamDef[]; adjustment?: boolean };

const num = (key: string, label: string, def: number, o: Partial<ParamDef> = {}): ParamDef => ({ key, label, kind: ParamKind.Anim, def, step: 0.5, decimals: 1, ...o });
const fixed = (key: string, label: string, def: number, o: Partial<ParamDef> = {}): ParamDef => ({ key, label, kind: ParamKind.Fixed, def, step: 0.5, decimals: 1, ...o });
const color = (key: string, label: string, def?: string): ParamDef => ({ key, label, kind: ParamKind.Color, def });

/** A custom effect that leaves the picture as it is: the starting point the user edits. */
const PASS_THROUGH_WGSL = "fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let c = src(uv);\n  return c;\n}";

export const EFFECTS: EffectDef[] = [
  { kind: EffectKind.Blur, name: "Gaussian Blur", category: EffectCategory.Blur, hint: "Soft blur of the layer (depth of field, frosted backgrounds).", params: [num("radius", "Blurriness", 12, { min: 0, unit: " px" })] },
  {
    kind: EffectKind.MotionBlur,
    name: "Motion Blur",
    category: EffectCategory.Blur,
    hint: "The layer averaged over the shutter while it moves (180° = film look).",
    params: [fixed("shutter", "Shutter Angle", 180, { min: 0, max: 720, step: 1, decimals: 0, unit: "°" }), fixed("samples", "Samples", 8, { min: 1, max: 16, step: 0.1, decimals: 0, integer: true })],
  },
  {
    kind: EffectKind.Color,
    name: "Hue/Saturation",
    category: EffectCategory.Color,
    hint: "Hue shift, saturation (0 = grey), brightness and contrast.",
    params: [
      num("hue", "Hue", 0, { unit: "°" }),
      num("saturation", "Saturation", 1, { step: 0.01, decimals: 2, min: 0 }),
      num("brightness", "Brightness", 0, { step: 0.01, decimals: 2, min: -1, max: 1 }),
      num("contrast", "Contrast", 1, { step: 0.01, decimals: 2, min: 0 }),
    ],
  },
  {
    kind: EffectKind.Wave,
    name: "Wave Warp",
    category: EffectCategory.Distort,
    hint: "A travelling sine pushes pixels sideways (heat haze, flags, liquid).",
    params: [num("amplitude", "Wave Height", 12, { unit: " px" }), num("wavelength", "Wave Width", 200, { min: 1, step: 1, decimals: 0, unit: " px" }), num("speed", "Wave Speed", 1, { step: 0.01, decimals: 2 })],
  },
  {
    kind: EffectKind.Turbulence,
    name: "Turbulent Displace",
    category: EffectCategory.Distort,
    hint: "Flowing fractal noise pushes pixels around (liquid, smoke, cloudy gradients).",
    params: [num("amount", "Amount", 40, { unit: " px" }), num("size", "Size", 320, { min: 1, step: 1, decimals: 0, unit: " px" }), num("speed", "Evolution Speed", 1, { step: 0.01, decimals: 2 })],
  },
  { kind: EffectKind.Chromatic, name: "RGB Split", category: EffectCategory.Distort, hint: "Red and blue shifted apart (glitch, lens edge).", params: [num("amount", "Amount", 6, { unit: " px" })] },
  { kind: EffectKind.Grain, name: "Add Grain", category: EffectCategory.Noise, hint: "Animated film grain.", params: [num("amount", "Intensity", 0.06, { step: 0.005, decimals: 3, min: 0, max: 1 })] },
  {
    kind: EffectKind.Glass,
    name: "Liquid Glass",
    category: EffectCategory.Perspective,
    hint: "Refracts and blurs what is below, in the layer's shape (turns it into an adjustment layer).",
    adjustment: true,
    params: [
      fixed("thickness", "Thickness", 40, { min: 0, step: 1, decimals: 0, unit: " px" }),
      fixed("bevel", "Bevel", 60, { min: 0, step: 1, decimals: 0, unit: " px" }),
      fixed("blur", "Blur", 12, { min: 0, unit: " px" }),
      fixed("ior", "Refraction Index", 1.5, { min: 1, max: 3, step: 0.01, decimals: 2 }),
      fixed("dispersion", "Dispersion", 0, { min: 0, max: 0.2, step: 0.001, decimals: 3 }),
      fixed("specular", "Specular", 1, { min: 0, step: 0.01, decimals: 2 }),
      color("tint", "Tint"),
    ],
  },
  {
    kind: EffectKind.Glow,
    name: "Glow",
    category: EffectCategory.Stylize,
    hint: "Bloom around the layer; a threshold keeps only the bright parts glowing.",
    params: [
      num("radius", "Glow Radius", 24, { min: 0, unit: " px" }),
      num("strength", "Glow Intensity", 1, { step: 0.01, decimals: 2, min: 0 }),
      color("color", "Glow Color"),
      fixed("threshold", "Glow Threshold", 0, { min: 0, max: 1, step: 0.01, decimals: 2 }),
    ],
  },
  {
    kind: EffectKind.Shadow,
    name: "Drop Shadow",
    category: EffectCategory.Stylize,
    hint: "Soft drop shadow (tint it with the brand color for a premium look).",
    params: [
      num("x", "Offset X", 0, { unit: " px" }),
      num("y", "Offset Y", 18, { unit: " px" }),
      num("blur", "Softness", 36, { min: 0, unit: " px" }),
      color("color", "Shadow Color", "#0f121f"),
      num("opacity", "Opacity", 0.25, { step: 0.01, decimals: 2, min: 0, max: 1 }),
    ],
  },
  {
    kind: EffectKind.Shader,
    name: "Custom Shader (WGSL)",
    category: EffectCategory.Custom,
    hint: "Your own GPU code rewrites every pixel of the layer (src(uv) reads it).",
    params: [{ key: "code", label: "Code", kind: ParamKind.Code, def: PASS_THROUGH_WGSL }, { key: "params", label: "Params (fx0…fx7)", kind: ParamKind.Params, def: [] }],
  },
];

export const effectDef = (kind: string) => EFFECTS.find((e) => e.kind === kind);

/** An effect as stored in `effects`: its tag plus params. */
export type Fx = { fx: string; enabled?: boolean; [param: string]: unknown };

/** Field that switches one effect off without losing it (AE's fx switch). */
export const FX_ENABLED = "enabled";

/** A new effect with the catalog's defaults (optional params left out). */
export function newEffect(def: EffectDef): Fx {
  const fx: Fx = { fx: def.kind };
  for (const p of def.params) if (p.def !== undefined) fx[p.key] = p.def;
  return fx;
}

/** Layer styles are their own layer fields, not entries of the effect stack. */
export const LayerStyleKind = {
  InnerShadow: "inner_shadow",
  InnerGlow: "inner_glow",
  Bevel: "bevel",
  Sheen: "sheen",
  Feather: "feather",
  Frosted: "frosted",
} as const;
export type LayerStyleKind = (typeof LayerStyleKind)[keyof typeof LayerStyleKind];

export type LayerStyleDef = { kind: LayerStyleKind; name: string; hint: string; field: string; value: unknown };

export const LAYER_STYLES: LayerStyleDef[] = [
  { kind: LayerStyleKind.InnerShadow, name: "Inner Shadow", hint: "Shadow inside the shape's edge (rect, ellipse).", field: "inner", value: { x: 0, y: 6, blur: 12, color: "#000000", opacity: 0.35 } },
  { kind: LayerStyleKind.InnerGlow, name: "Inner Glow", hint: "Light along the inside of the edge.", field: "inner", value: { x: 0, y: 0, blur: 18, color: "#ffffff", opacity: 0.6 } },
  { kind: LayerStyleKind.Bevel, name: "Bevel and Emboss", hint: "Embossed plastic edge lit from the top left.", field: "bevel", value: { width: 6, strength: 0.35 } },
  { kind: LayerStyleKind.Sheen, name: "Light Sweep", hint: "A band of light across the shape; animate At from 0 to 1.", field: "sheen", value: { at: 0.5, angle: 20, width: 0.18, opacity: 0.45 } },
  { kind: LayerStyleKind.Feather, name: "Feather Edges", hint: "Soft edge (big values = mesh-gradient blobs).", field: "soft", value: 20 },
  { kind: LayerStyleKind.Frosted, name: "Frosted Glass", hint: "Blurs what is behind the shape (pair with a light translucent fill).", field: "backdrop", value: 24 },
];

/** Blend modes the engine draws (paint.rs `BlendMode`), with AE's names. */
export const BLEND_MODES: [string, string][] = [
  ["normal", "Normal"],
  ["darken", "Darken"],
  ["multiply", "Multiply"],
  ["color_burn", "Color Burn"],
  ["linear_burn", "Linear Burn"],
  ["lighten", "Lighten"],
  ["screen", "Screen"],
  ["color_dodge", "Color Dodge"],
  ["add", "Add"],
  ["overlay", "Overlay"],
  ["soft_light", "Soft Light"],
  ["hard_light", "Hard Light"],
  ["difference", "Difference"],
  ["exclusion", "Exclusion"],
  ["hue", "Hue"],
  ["saturation", "Saturation"],
  ["color", "Color"],
  ["luminosity", "Luminosity"],
];
export const NORMAL_BLEND = "normal";
/** Where AE draws a line between blend mode families. */
export const BLEND_BREAKS = new Set(["darken", "lighten", "overlay", "difference", "hue"]);

/** Track matte modes (paint.rs `MatteMode`). */
export const MatteMode = { Alpha: "alpha", AlphaInverted: "alpha_inverted", Luma: "luma", LumaInverted: "luma_inverted" } as const;
export type MatteMode = (typeof MatteMode)[keyof typeof MatteMode];
export const MATTE_MODES: [MatteMode, string][] = [
  [MatteMode.Alpha, "Alpha Matte"],
  [MatteMode.AlphaInverted, "Alpha Inverted Matte"],
  [MatteMode.Luma, "Luma Matte"],
  [MatteMode.LumaInverted, "Luma Inverted Matte"],
];
export type Matte = { layer: string; mode?: MatteMode };

/** Camera presets: AE's lens names; zoom in px = focal mm × comp width / 36 mm film. */
export const LENSES: [string, number][] = [
  ["15mm", 15],
  ["20mm", 20],
  ["24mm", 24],
  ["28mm", 28],
  ["35mm", 35],
  ["50mm", 50],
  ["80mm", 80],
  ["135mm", 135],
  ["200mm", 200],
];
export const FILM_MM = 36;
export const DEFAULT_LENS_MM = 35;
