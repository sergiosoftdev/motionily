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
  StyleChosen: "style_chosen",
  CaptionStyleChosen: "caption_style_chosen",
} as const;
export type FeedbackKind = (typeof FeedbackKind)[keyof typeof FeedbackKind];

export type Feedback =
  | { kind: typeof FeedbackKind.Comment; at: number; text: string; createdAt: string }
  | { kind: typeof FeedbackKind.StyleChosen; style: StylePreset; createdAt: string }
  | { kind: typeof FeedbackKind.CaptionStyleChosen; captionStyle: CaptionStyle; createdAt: string };

export const ServerMessageType = {
  ApplyOps: "apply_ops",
  LoadScene: "load_scene",
} as const;
export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

/** Agent -> editor. Each request gets exactly one `result` back. */
export type ServerMessage =
  | { type: typeof ServerMessageType.ApplyOps; requestId: string; ops: Op[] }
  | { type: typeof ServerMessageType.LoadScene; requestId: string; scene: string };

export const EditorMessageType = {
  Hello: "hello",
  Result: "result",
  SceneChanged: "scene_changed",
  Feedback: "feedback",
} as const;
export type EditorMessageType = (typeof EditorMessageType)[keyof typeof EditorMessageType];

/** Editor -> agent. `scene` is the full scene JSON, `summary` the token-cheap version. */
export type EditorMessage =
  | { type: typeof EditorMessageType.Hello; scene: string; summary: string }
  | {
      type: typeof EditorMessageType.Result;
      requestId: string;
      ok: boolean;
      error?: string;
      scene?: string;
      summary?: string;
    }
  | { type: typeof EditorMessageType.SceneChanged; scene: string; summary: string }
  | { type: typeof EditorMessageType.Feedback; feedback: Feedback };


/** Op names the editor itself sends. The full list lives in docs/scene-reference.md. */
export const OpName = {
  SetStyle: "set_style",
  SetCaptionStyle: "set_caption_style",
} as const;
export type OpName = (typeof OpName)[keyof typeof OpName];
