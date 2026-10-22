import type { SceneLayerView, SceneView } from "../../sceneView";

/**
 * The scene fields the AE timeline reads and writes, as the engine contract names them. Every
 * change goes out as an ordinary op (`patch`, `set_markers`, `set_work_area`), so Claude can do
 * the same thing through MCP.
 */

/** Per-layer switches, set with `patch`. */
export const LayerSwitch = {
  /** When any layer is solo, only solo layers draw. */
  Solo: "solo",
  /** The UI refuses to select or edit a locked layer. */
  Locked: "locked",
  /** Hidden from the timeline while the shy filter is on. */
  Shy: "shy",
} as const;
export type LayerSwitch = (typeof LayerSwitch)[keyof typeof LayerSwitch];

/** A composition marker (`set_markers`). */
export type Marker = { t: number; label: string; color?: string };
/** Preview range `[in, out]` in seconds (`set_work_area`); `null` = the whole video. */
export type WorkArea = [number, number];

export const MatteMode = {
  Alpha: "alpha",
  AlphaInverted: "alpha_inverted",
  Luma: "luma",
  LumaInverted: "luma_inverted",
} as const;
export type MatteMode = (typeof MatteMode)[keyof typeof MatteMode];
export type Matte = { layer: string; mode?: MatteMode };

/** A layer as the timeline reads it: the scene view plus the switches, matte and pivot. */
export type TimelineLayer = SceneLayerView & {
  solo?: boolean;
  locked?: boolean;
  shy?: boolean;
  matte?: Matte | null;
  pivot?: [number, number];
};
/** The scene as the timeline reads it: markers and work area on top of the scene view. */
export type TimelineScene = Omit<SceneView, "layers"> & {
  layers: TimelineLayer[];
  markers?: Marker[];
  work_area?: WorkArea | null;
};

export const isLocked = (l: { locked?: unknown } | undefined) => l?.locked === true;
export const isSolo = (l: { solo?: unknown }) => l.solo === true;
export const isShy = (l: { shy?: unknown }) => l.shy === true;

/** Every blend mode the engine draws (BlendMode in crates/scene/src/paint.rs), grouped like AE's menu. */
export const BlendMode = {
  Normal: "normal",
  Darken: "darken",
  Multiply: "multiply",
  ColorBurn: "color_burn",
  LinearBurn: "linear_burn",
  Add: "add",
  Lighten: "lighten",
  Screen: "screen",
  ColorDodge: "color_dodge",
  Overlay: "overlay",
  SoftLight: "soft_light",
  HardLight: "hard_light",
  Difference: "difference",
  Exclusion: "exclusion",
  Hue: "hue",
  Saturation: "saturation",
  Color: "color",
  Luminosity: "luminosity",
} as const;
export type BlendMode = (typeof BlendMode)[keyof typeof BlendMode];

/** AE's Mode menu: groups of [mode, label]. */
export const BLEND_GROUPS: [string, [BlendMode, string][]][] = [
  ["Normal", [[BlendMode.Normal, "Normal"]]],
  [
    "Darken",
    [
      [BlendMode.Darken, "Darken"],
      [BlendMode.Multiply, "Multiply"],
      [BlendMode.ColorBurn, "Color Burn"],
      [BlendMode.LinearBurn, "Linear Burn"],
    ],
  ],
  [
    "Lighten",
    [
      [BlendMode.Add, "Add"],
      [BlendMode.Lighten, "Lighten"],
      [BlendMode.Screen, "Screen"],
      [BlendMode.ColorDodge, "Color Dodge"],
    ],
  ],
  [
    "Contrast",
    [
      [BlendMode.Overlay, "Overlay"],
      [BlendMode.SoftLight, "Soft Light"],
      [BlendMode.HardLight, "Hard Light"],
    ],
  ],
  [
    "Difference",
    [
      [BlendMode.Difference, "Difference"],
      [BlendMode.Exclusion, "Exclusion"],
    ],
  ],
  [
    "Color",
    [
      [BlendMode.Hue, "Hue"],
      [BlendMode.Saturation, "Saturation"],
      [BlendMode.Color, "Color"],
      [BlendMode.Luminosity, "Luminosity"],
    ],
  ],
];

/** AE's label colors offered for markers (first = the default marker color). */
export const MARKER_COLORS = ["#a9cbc7", "#b53838", "#e4d84c", "#e5bcc9", "#677de0", "#4aa44c", "#e8920d", "#8e2c9a"] as const;
