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
  /** Move layers into a new component and put one instance in their place: `{ids, component, id}`. */
  Precompose: "precompose",
  // timeline
  /** Replace the timeline markers: `{markers: Marker[]}` (`[]` clears). */
  SetMarkers: "set_markers",
  /** Preview loop range: `{work_area: [in, out] | null}`. Export ignores it. */
  SetWorkArea: "set_work_area",
  /** Take `{from, to}` seconds out of the whole video and close the gap (voice, captions, layers, clips, sfx, markers). */
  RippleDelete: "ripple_delete",
  /** Cut a layer in two: `{id, at, new_id?}`. */
  SplitLayer: "split_layer",
} as const;
export type OpName = (typeof OpName)[keyof typeof OpName];

/** A named instant on the timeline (scene `markers`, kept sorted by `t`). `color` is `#rrggbb`. */
export type Marker = { t: number; label: string; color?: string };
/** Scene `work_area`: `[in, out]` seconds the preview loops in, or null for the whole video. */
export type WorkArea = [number, number] | null;
export type SetMarkersOp = { op: typeof OpName.SetMarkers; markers: Marker[] };
export type SetWorkAreaOp = { op: typeof OpName.SetWorkArea; work_area: WorkArea };
/** `id` is the new instance layer; it spans the layers' time range at the topmost one's stacking position. */
export type PrecomposeOp = { op: typeof OpName.Precompose; ids: string[]; component: string; id: string };

/** Layer switches set with `patch` fields (false = left out). Solo changes what renders; locked and shy are editor-only. */
export const LayerSwitch = { Solo: "solo", Locked: "locked", Shy: "shy" } as const;
export type LayerSwitch = (typeof LayerSwitch)[keyof typeof LayerSwitch];

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

/** What the agent looks for when it gathers material (mirrors AssetKind in the API). */
export const AssetKind = { Photo: "photo", Footage: "footage", Logo: "logo", Texture: "texture" } as const;
export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

/** Where imported material comes from (mirrors AssetSource in the API). */
export const ImageSource = {
  Commons: "commons",
  Openverse: "openverse",
  Pexels: "pexels",
  Pixabay: "pixabay",
  Iconify: "iconify",
  Archive: "archive",
  Met: "met",
  Europeana: "europeana",
  Web: "web",
  Generated: "generated",
  Library: "library",
} as const;
export type ImageSource = (typeof ImageSource)[keyof typeof ImageSource];

/** How an asset is used: image layer, vector (add_vector, plus a PNG), video layer. */
export const AssetFormat = { Raster: "raster", Svg: "svg", Video: "video" } as const;
export type AssetFormat = (typeof AssetFormat)[keyof typeof AssetFormat];

/** One search result: `id` ("commons:File:…", "pexels:video:123", "iconify:simple-icons:spotify", "library:<id>"…) is what import takes. */
export type ImageHit = {
  id: string;
  kind: AssetKind;
  source: ImageSource;
  format: AssetFormat;
  title: string;
  description: string;
  author: string;
  license: string;
  date: string;
  width: number;
  height: number;
  thumb: string;
  duration?: number;
  /** Web results: license unknown, only for commentary/news-style use. */
  editorial?: boolean;
  /** Already in the user's library. */
  library?: boolean;
};

/** Attribution of material imported into a video (CC BY / BY-SA and icon sets require it). */
export type ImageCredit = {
  src: string;
  /** Small copy the agent looks at (the full image would flood its context). */
  preview?: string;
  /** Vectors: the sanitized SVG (`src` is its PNG rendering). */
  svg?: string;
  /** Footage: contact sheet and facts. */
  poster?: string;
  duration?: number;
  width?: number;
  height?: number;
  kind?: AssetKind;
  format?: AssetFormat;
  source: ImageSource;
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  pageUrl: string;
  editorial?: boolean;
};

/** Genre vocabularies a video's direction picks from (mirrors Genre in the API and docs/agent/motion-2d.md). */
export const Genre = {
  ProductLaunch: "product_launch",
  ArchivalDocumentary: "archival_documentary",
  EditorialCollage: "editorial_collage",
  MapDataStory: "map_data_story",
  KineticType: "kinetic_type",
  RetroPrint: "retro_print",
  ScrapbookHandmade: "scrapbook_handmade",
  FlatIllustration: "flat_illustration",
  SocialNative: "social_native",
  CinematicTrailer: "cinematic_trailer",
  SwissEditorial: "swiss_editorial",
  Glossy3d: "glossy_3d",
  BrutalistZine: "brutalist_zine",
} as const;
export type Genre = (typeof Genre)[keyof typeof Genre];

/** The look the agent declared for a video before building it. */
export type Direction = { genre: Genre; concept: string; techniques: string[]; setAt: string };

/** How an earlier video of the account looked. */
export type Fingerprint = { name: string; favorite: boolean; genre: Genre | null; concept: string | null; techniques: string[]; font: string | null; primary: string | null; background: string | null; constraints: string[] };

/** Asset sources the user can connect with their own key (Settings › Asset sources). */
export const ProviderKey = { Pexels: "pexels", Pixabay: "pixabay", Brave: "brave", OpenAI: "openai", Europeana: "europeana" } as const;
export type ProviderKey = (typeof ProviderKey)[keyof typeof ProviderKey];
export type ProviderStatus = { provider: ProviderKey; connected: boolean; hint: string | null; platform: boolean };

/** A starred video as an agent sees it (its scene comes on request). */
export type FavoriteVideo = { id: string; name: string; format: VideoFormat; brief: string; direction: Direction | null; font: string | null; palette: Record<string, string> | null; duration: number | null; favoritedAt: string };

/** An item of the user's asset library. */
export type LibraryItem = { id: string; kind: AssetKind; format: AssetFormat; title: string; credit: ImageCredit; videos: number };

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
  /**
   * Background music file the user uploaded (the scene's `music` places and levels it). `trimIn` = where in the song
   * the video should start (its loud part on the key moment), from the song's energy (`summary`).
   */
  music: { url: string; name: string; trimIn: number; summary: string | null; duration: number | null } | null;
  /** Claude's prompt for this video's music in Suno, kept until the user asks for another. */
  sunoPrompt: SunoPrompt | null;
  /** Claude's latest caption and hashtags per platform, as the user left them. */
  postCopy: { platform: string; caption: string; hashtags: string[] }[];
  /** The user's own clips to edit, in upload order (c1, c2…). */
  footage: FootageClip[];
  sceneRevision: number;
  /** Tokens and cost of each agent run on this video (newest last). */
  agentRuns: AgentRunUsage[];
  /** Material the agent imported (photos, footage, logos, icon sets, generated images), with what their licenses ask to credit. */
  imageCredits: ImageCredit[];
  /** The look declared with set_direction. */
  direction: Direction | null;
  /** The two creative constraints this video drew. */
  constraints: string[];
  /** Starred by the user: agents study favorites as their taste. */
  favorite: boolean;
  updatedAt: string;
};

export type ProjectListItem = { _id: string; name: string; build: Build; format?: VideoFormat; brandId?: string; favorite?: boolean; updatedAt: string; generating?: boolean };

/** A spoken word and when it is said, in seconds. */
export type VoiceWord = { text: string; start: number; end: number };

/** Suno prompt for a video's music: style and structure fields to paste, and the video second the drop should hit. */
export type SunoPrompt = { title: string; style: string; structure: string; dropAt: number | null; notes: string; createdAt: string };

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

/** Short-form attention curve: devices, measurement and checks (see attention.ts). */
export * from "./attention.js";
