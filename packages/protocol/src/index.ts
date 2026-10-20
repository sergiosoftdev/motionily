/**
 * Wire protocol between the MCP server (the agent's side) and the editor
 * (the human's side). The scene itself is owned by the Rust engine; this
 * package only describes the messages that move ops, scenes and feedback.
 */

/** WebSocket path on the API where editors and agents meet (see apps/api/src/bridge-hub.ts). */
export const BRIDGE_PATH = "/bridge";

export const BridgeRole = { Editor: "editor", Agent: "agent" } as const;
export type BridgeRole = (typeof BridgeRole)[keyof typeof BridgeRole];

/** Hub -> agent: whether the project's editor is open. */
export const HubMessageType = { EditorOpen: "editor_open", EditorClosed: "editor_closed" } as const;
export type HubMessage = { type: (typeof HubMessageType)[keyof typeof HubMessageType] };

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
  /** Scene layer the comment points at (clicked in the preview). */
  layerId?: string;
  slot?: string;
  value?: string | string[] | null;
  createdAt: string;
};

/** Query param marking the agent's headless editor (web page and bridge URL). */
export const HEADLESS_PARAM = "headless";

export const ServerMessageType = {
  ApplyOps: "apply_ops",
  LoadScene: "load_scene",
  /** An agent is connected to this editor's project. */
  Attached: "attached",
  /** The last agent of this project left. */
  Detached: "detached",
  /** Project settings (options, format) changed on the server; reload them. */
  ProjectChanged: "project_changed",
  /** Render still frames so the agent can see the video. */
  RenderFrames: "render_frames",
  /** Self-review: contact sheet of the whole video plus automatic checks. */
  Review: "review",
  /** Where every layer lands on screen at some instants (numbers, no pixels). */
  Layout: "layout",
} as const;
export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

/** Agent -> editor. Each request gets exactly one `result` back. */
export type ServerMessage =
  | { type: typeof ServerMessageType.ApplyOps; requestId: string; projectId: string; ops: Op[] }
  | { type: typeof ServerMessageType.LoadScene; requestId: string; projectId: string; scene: string }
  | { type: typeof ServerMessageType.Attached; projectId: string }
  | { type: typeof ServerMessageType.Detached; projectId: string }
  | { type: typeof ServerMessageType.ProjectChanged; projectId: string }
  | { type: typeof ServerMessageType.RenderFrames; requestId: string; projectId: string; times: number[]; width?: number }
  | { type: typeof ServerMessageType.Review; requestId: string; projectId: string; frames: number }
  | { type: typeof ServerMessageType.Layout; requestId: string; projectId: string; times: number[] };

/** One layer as it lands on screen (engine `Scene::layout`). */
export type LayoutRow = {
  id: string;
  group?: string;
  /** [x0, y0, x1, y1] in scene px on screen (glyph ink for text when `ink`). */
  screen: [number, number, number, number];
  /** Screen scale from depth and perspective (1 = its own size). */
  k: number;
  z: number;
  visible: boolean;
  /** Tilted layer projecting it. */
  plane?: string;
  ink?: boolean;
};

/** Where the layers land on screen at one instant. */
export type FrameLayout = {
  t: number;
  camera: { look: [number, number]; dolly: number; focal: number } | null;
  layers: LayoutRow[];
  /** Active layers the camera has passed (not drawn). */
  behind: string[];
};

/** What the editor found when reviewing the whole video. */
export type ReviewReport = {
  duration: number;
  /** Seconds of each frame in the contact sheet, left to right, top to bottom. */
  times: number[];
  /** One JPEG data URL with every sampled frame in a grid. */
  sheet: string;
  issues: string[];
  /** Motion feedback: easing, abrupt starts/stops, stillness, crowded entrances, camera. */
  motion: string[];
  /** Short strips of consecutive frames (12 fps) around the moments that change most. */
  strips: { from: number; to: number; image: string }[];
};

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
      /** JPEG data URLs, for render_frames. */
      images?: string[];
      review?: ReviewReport;
      layouts?: FrameLayout[];
    }
  | { type: typeof EditorMessageType.SceneChanged; projectId: string; scene: string; summary: string };


/** Op names the editor itself sends. The full list lives in docs/agent/manual.md. */
export const OpName = {
  SetStyle: "set_style",
  SetCaptionStyle: "set_caption_style",
  SetPalette: "set_palette",
  SetLibrary: "set_library",
  DefineAnim: "define_anim",
  SetTypography: "set_typography",
  SetCaptions: "set_captions",
  SetDuration: "set_duration",
  SetAudio: "set_audio",
  SetRenderStyle: "set_render_style",
  SetScenario: "set_scenario",
  SetSize: "set_size",
  SetStagePreset: "set_stage_preset",
  SetStage: "set_stage",
  DefinePrefab: "define_prefab",
  PutProp: "put_prop",
  SetProp: "set_prop",
  SetTiming: "set_timing",
  SetText: "set_text",
  RemoveLayer: "remove_layer",
  RemoveGroup: "remove_group",
  SetGroup: "set_group",
  PutSfx: "put_sfx",
  RemoveSfx: "remove_sfx",
  // components
  DefineComponent: "define_component",
  RemoveComponent: "remove_component",
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

export const VideoFormat = {
  Vertical: "vertical_9_16",
  Horizontal: "horizontal_16_9",
  Square: "square_1_1",
  Portrait: "portrait_4_5",
} as const;
export type VideoFormat = (typeof VideoFormat)[keyof typeof VideoFormat];

/** Pixel size of each format (1080 on the short side). */
export const FORMAT_SIZE: Record<VideoFormat, [number, number]> = {
  vertical_9_16: [1080, 1920],
  horizontal_16_9: [1920, 1080],
  square_1_1: [1080, 1080],
  portrait_4_5: [1080, 1350],
};

export type AgentRunUsage = {
  at: string;
  kind: string;
  model: string | null;
  effort: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  durationMs: number;
};

export type Project = {
  id: string;
  name: string;
  brief: string;
  wantsScript: boolean;
  voiceScript: string;
  /** Reference images attached to the idea (media paths). */
  references: string[];
  build: Build;
  format: VideoFormat;
  /** Project (brand kit) the video belongs to. */
  brandId: string | null;
  misfits: string[];
  scene: Record<string, unknown> | null;
  audio: { url: string; name: string; mime: string } | null;
  sceneRevision: number;
  /** Tokens and cost of each agent run on this video (newest last). */
  agentRuns: AgentRunUsage[];
  updatedAt: string;
};

export type ProjectListItem = { _id: string; name: string; build: Build; format?: VideoFormat; brandId?: string; updatedAt: string; generating?: boolean };

export type User = { id: string; email: string; name: string; avatarUrl: string | null; provider: string };
