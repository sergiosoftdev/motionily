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

/** Effects master volume of a new scene (cue gain × this): 10 %, so effects never drown the voice. Mirrors the engine. */
export const DEFAULT_SFX_VOLUME = 0.1;

/** Why the hub closed a bridge socket (WebSocket close codes). */
export const BridgeClose = {
  BadRole: 4400,
  InvalidToken: 4401,
  WrongProject: 4403,
  NotFound: 4404,
  /** The agent's invisible editor: a real one is open, or just replaced it. It keeps retrying as a fallback. */
  RealEditorOpen: 4409,
  /** Another tab or window opened the same video and took over: this editor stops reconnecting. */
  OpenedElsewhere: 4410,
} as const;
export type BridgeClose = (typeof BridgeClose)[keyof typeof BridgeClose];

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
  /** Particle layers: live particles (`screen` is their extent, or the emitter box when none). */
  particles?: LayoutParticles;
  /** Video layers: file second on screen (`at`), file length once open, or why nothing shows. */
  video?: { src: string; at: number; duration?: number; error?: string };
};

/** A particle layer at one instant: `live === max` means the cap is dropping the oldest. */
export type LayoutParticles = { live: number; on_screen: number; max: number };

/** Where the layers land on screen at one instant. */
export type FrameLayout = {
  t: number;
  /** The palette the frame is drawn with (the style's when the scene has none), as hex. */
  palette?: { background: string; surface: string; primary: string; accent: string; text: string };
  /** `roll`: camera roll in degrees, clockwise (the picture turns counter-clockwise). */
  camera: { look: [number, number]; dolly: number; focal: number; roll?: number } | null;
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
  /** Background music: `{music: {src, start, trim_in, trim_out, gain, duck}}` or `{music: null}`. */
  SetMusic: "set_music",
  SetRenderStyle: "set_render_style",
  SetScenario: "set_scenario",
  SetSize: "set_size",
  SetStagePreset: "set_stage_preset",
  SetStage: "set_stage",
  DefinePrefab: "define_prefab",
  PutProp: "put_prop",
  SetProp: "set_prop",
  /** Any fields of one or more layers (`id`, `ids`, `group` or `all`); `"a.b"` reaches inside. */
  Patch: "patch",
  ReplaceColor: "replace_color",
  SetTiming: "set_timing",
  SetText: "set_text",
  AddLayer: "add_layer",
  RemoveLayer: "remove_layer",
  /** Move a layer in the stack: `{id, index}` (0 = back). */
  Reorder: "reorder",
  RemoveGroup: "remove_group",
  SetGroup: "set_group",
  PutSfx: "put_sfx",
  RemoveSfx: "remove_sfx",
  /** Master volume of the sound effects (the user's slider). */
  SetSfxVolume: "set_sfx_volume",
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

/** Free image libraries the agent searches for real photos (only openly licensed images come back). */
export const ImageSource = { Commons: "commons", Openverse: "openverse" } as const;
export type ImageSource = (typeof ImageSource)[keyof typeof ImageSource];

/** One search result: `id` ("commons:File:…" / "openverse:<uuid>") is what import_image takes. */
export type ImageHit = {
  id: string;
  source: ImageSource;
  title: string;
  description: string;
  author: string;
  license: string;
  date: string;
  width: number;
  height: number;
  thumb: string;
};

/** Attribution of an image imported into a video (CC BY / BY-SA require it). */
export type ImageCredit = {
  src: string;
  /** Small copy the agent looks at (the full image would flood its context). Missing on early imports. */
  preview?: string;
  source: ImageSource;
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  pageUrl: string;
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
  /** The voice-over; `words` is set when it was generated with ElevenLabs (exact timing, no transcription needed). */
  audio: { url: string; name: string; mime: string; words?: VoiceWord[] | null } | null;
  /** Background music file the user uploaded (the scene's `music` places and levels it). */
  music: { url: string; name: string } | null;
  /** The user's own clips to edit, in upload order (c1, c2…). */
  footage: FootageClip[];
  sceneRevision: number;
  /** Tokens and cost of each agent run on this video (newest last). */
  agentRuns: AgentRunUsage[];
  /** Real photos the agent imported from free libraries, with what their licenses ask to credit. */
  imageCredits: ImageCredit[];
  updatedAt: string;
};

export type ProjectListItem = { _id: string; name: string; build: Build; format?: VideoFormat; brandId?: string; updatedAt: string; generating?: boolean };

/** A spoken word and when it is said, in seconds. */
export type VoiceWord = { text: string; start: number; end: number };

/** A clip uploaded to be edited. `words` (file seconds) once the editor transcribed it; `poster` = a 4×3 contact sheet. */
export type FootageClip = {
  id: string;
  name: string;
  url: string;
  mime: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  poster: string | null;
  /** Language spoken (ISO 639-1). */
  language: string;
  words: VoiceWord[] | null;
};

/** ElevenLabs text-to-speech models the user can pick. */
export const VoiceModel = { V4: "eleven_v4", V3: "eleven_v3", MultilingualV2: "eleven_multilingual_v2", FlashV25: "eleven_flash_v2_5" } as const;
export type VoiceModel = (typeof VoiceModel)[keyof typeof VoiceModel];

/** A voice in the user's ElevenLabs account. */
export type Voice = { id: string; name: string; category: string | null; description: string | null; labels: Record<string, string>; previewUrl: string | null };

export type User = { id: string; email: string; name: string; avatarUrl: string | null; provider: string };
