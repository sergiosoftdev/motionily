/** After Effects look for Pro mode: dark panels, blue accents, label colors per layer type. */
export const AE = {
  gap: "#121212",
  panel: "#232323",
  field: "#1b1b1b",
  row: "#262626",
  rowAlt: "#2a2a2a",
  rowSelected: "#3e3e3e",
  line: "#151515",
  text: "#c9c9c9",
  dim: "#8a8a8a",
  blue: "#2d8ceb",
  value: "#4aa3f0",
  cti: "#e5484d",
} as const;

/** AE's label colors. */
const LABEL = {
  red: "#b53838",
  yellow: "#e4d84c",
  aqua: "#a9cbc7",
  pink: "#e5bcc9",
  lavender: "#a9a9ca",
  peach: "#e7c19e",
  seaFoam: "#b3c7b3",
  blue: "#677de0",
  green: "#4aa44c",
  purple: "#8e2c9a",
  orange: "#e8920d",
  fuchsia: "#f46dd6",
  cyan: "#3da2a5",
  sandstone: "#a89677",
} as const;

/** Label color per layer type, like AE's defaults (text red, shapes blue, footage aqua…). */
const TYPE_LABEL: Record<string, string> = {
  text: LABEL.red,
  shape: LABEL.blue,
  path: LABEL.blue,
  image: LABEL.lavender,
  video: LABEL.aqua,
  object: LABEL.peach,
  shader: LABEL.fuchsia,
  character: LABEL.yellow,
  particles: LABEL.orange,
  use: LABEL.sandstone,
};
export const GROUP_LABEL = LABEL.purple;
export const CAMERA_LABEL = LABEL.pink;
export const AUDIO_LABEL = LABEL.seaFoam;
export const CAPTIONS_LABEL = LABEL.cyan;
export const SFX_LABEL = LABEL.green;

export function labelColor(layer: { type: string; camera?: unknown }) {
  if (layer.camera) return CAMERA_LABEL;
  return TYPE_LABEL[layer.type] ?? LABEL.seaFoam;
}

/** One-glyph icon per layer type, in the Source Name column. */
const TYPE_ICON: Record<string, string> = {
  text: "T",
  shape: "★",
  path: "✎",
  image: "▣",
  video: "▶",
  object: "◆",
  shader: "ƒ",
  character: "☺",
  particles: "✷",
  use: "⧉",
};
export function typeIcon(layer: { type: string; camera?: unknown }) {
  if (layer.camera) return "◉";
  return TYPE_ICON[layer.type] ?? "▢";
}
