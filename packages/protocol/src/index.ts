/**
 * Wire protocol between the MCP server (the agent's side) and the editor
 * (the human's side). The scene itself is owned by the Rust engine; this
 * package only describes the messages that move ops, scenes and feedback.
 */

export const BRIDGE_PORT = 7420;

export const StylePreset = {
  Clean: "clean",
  Neon: "neon",
  Bold: "bold",
  Pastel: "pastel",
} as const;
export type StylePreset = (typeof StylePreset)[keyof typeof StylePreset];

export const CaptionStyle = {
  Minimal: "minimal",
  Karaoke: "karaoke",
  PopWord: "pop_word",
  Highlight: "highlight",
} as const;
export type CaptionStyle = (typeof CaptionStyle)[keyof typeof CaptionStyle];

/** A scene op, validated by the Rust engine. Kept loose here on purpose: one validator, in Rust. */
export type Op = { op: string } & Record<string, unknown>;

export const FeedbackKind = {
  Comment: "comment",
  BrickChosen: "brick_chosen",
} as const;
export type FeedbackKind = (typeof FeedbackKind)[keyof typeof FeedbackKind];

/** Feedback as stored by the API (/projects/:id/feedback). */
export type Feedback = {
  kind: FeedbackKind;
  text?: string;
  at?: number;
  slot?: string;
  value?: string | string[] | null;
  createdAt: string;
};

export const ServerMessageType = {
  ApplyOps: "apply_ops",
  LoadScene: "load_scene",
  /** The agent accepted this editor as the one showing its project. */
  Attached: "attached",
} as const;
export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

/** Agent -> editor. Each request gets exactly one `result` back. */
export type ServerMessage =
  | { type: typeof ServerMessageType.ApplyOps; requestId: string; projectId: string; ops: Op[] }
  | { type: typeof ServerMessageType.LoadScene; requestId: string; projectId: string; scene: string }
  | { type: typeof ServerMessageType.Attached; projectId: string };

export const EditorMessageType = {
  Hello: "hello",
  Result: "result",
  SceneChanged: "scene_changed",
} as const;
export type EditorMessageType = (typeof EditorMessageType)[keyof typeof EditorMessageType];

/** Editor -> agent. `scene` is the full scene JSON, `summary` the token-cheap version. */
export type EditorMessage =
  | { type: typeof EditorMessageType.Hello; projectId: string; scene: string; summary: string }
  | {
      type: typeof EditorMessageType.Result;
      requestId: string;
      ok: boolean;
      error?: string;
      scene?: string;
      summary?: string;
    }
  | { type: typeof EditorMessageType.SceneChanged; projectId: string; scene: string; summary: string };


/** Op names the editor itself sends. The full list lives in docs/scene-reference.md. */
export const OpName = {
  SetStyle: "set_style",
  SetCaptionStyle: "set_caption_style",
  SetPalette: "set_palette",
  SetLibrary: "set_library",
  DefineAnim: "define_anim",
} as const;
export type OpName = (typeof OpName)[keyof typeof OpName];

// ── API (apps/api) shapes used by the editor and the MCP server ───────────

export const BrickSlot = {
  MotionStyle: "motion_style",
  Palette: "palette",
  Composition: "composition",
  Typography: "typography",
  RenderStyle: "render_style",
  Captions: "captions",
  Scenario: "scenario",
  Character: "character",
  Animation: "animation",
  Transition: "transition",
} as const;
export type BrickSlot = (typeof BrickSlot)[keyof typeof BrickSlot];

export const SlotCardinality = { One: "one", Optional: "optional", Many: "many" } as const;
export type SlotCardinality = (typeof SlotCardinality)[keyof typeof SlotCardinality];

export const SLOT_CARDINALITY: Record<BrickSlot, SlotCardinality> = {
  motion_style: SlotCardinality.One,
  palette: SlotCardinality.One,
  composition: SlotCardinality.One,
  typography: SlotCardinality.One,
  render_style: SlotCardinality.One,
  captions: SlotCardinality.One,
  scenario: SlotCardinality.Optional,
  character: SlotCardinality.Many,
  animation: SlotCardinality.Many,
  transition: SlotCardinality.Many,
};

export const EngineSupport = { Supported: "supported", Planned: "planned" } as const;
export type EngineSupport = (typeof EngineSupport)[keyof typeof EngineSupport];

export const BrickVisibility = { Official: "official", Private: "private" } as const;
export type BrickVisibility = (typeof BrickVisibility)[keyof typeof BrickVisibility];

export type Brick = {
  key: string;
  slot: BrickSlot;
  name: string;
  description: string;
  tags: string[];
  fits: string[];
  payload: Record<string, unknown>;
  engine: EngineSupport;
  visibility: BrickVisibility;
  version: number;
};

export type PalettePayload = { background: string; surface: string; primary: string; accent: string; text: string };

export type Build = {
  motion_style: string;
  palette: string;
  composition: string;
  typography: string;
  render_style: string;
  captions: string;
  scenario: string | null;
  character: string[];
  animation: string[];
  transition: string[];
};

export type Project = {
  id: string;
  name: string;
  brief: string;
  build: Build;
  misfits: string[];
  scene: Record<string, unknown> | null;
  sceneRevision: number;
  updatedAt: string;
};

export type ProjectListItem = { _id: string; name: string; build: Build; updatedAt: string };

export type User = { id: string; email: string; name: string; avatarUrl: string | null; provider: string };
