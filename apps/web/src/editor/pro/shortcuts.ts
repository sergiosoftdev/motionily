import { useEffect, useRef } from "react";
import { commandFor, isTyping, KeyScope } from "../../keys/keymap";

/**
 * Pro mode's actions (After Effects keys by default). Which key runs each one lives in the keymap
 * (keys/keymap.ts, Settings › Keyboard); the timeline binds handlers to the actions.
 */

export const ShortcutAction = {
  RevealPosition: "reveal_position",
  RevealScale: "reveal_scale",
  RevealRotation: "reveal_rotation",
  RevealOpacity: "reveal_opacity",
  RevealAnchor: "reveal_anchor",
  /** U reveals animated properties; UU (twice quickly) the modified ones. */
  RevealAnimated: "reveal_animated",
  PrevItem: "prev_item",
  NextItem: "next_item",
  GoToIn: "go_to_in",
  GoToOut: "go_to_out",
  MoveIn: "move_in",
  MoveOut: "move_out",
  TrimIn: "trim_in",
  TrimOut: "trim_out",
  Duplicate: "duplicate",
  Split: "split",
  SelectAll: "select_all",
  WorkAreaIn: "work_area_in",
  WorkAreaOut: "work_area_out",
  AddMarker: "add_marker",
  CopyKeys: "copy_keys",
  PasteKeys: "paste_keys",
  EasyEase: "easy_ease",
  EasyEaseIn: "easy_ease_in",
  EasyEaseOut: "easy_ease_out",
  Delete: "delete",
  Deselect: "deselect",
  GraphEditor: "graph_editor",
  Help: "help",
} as const;
export type ShortcutAction = (typeof ShortcutAction)[keyof typeof ShortcutAction];

/** Typing in a field (or a contentEditable) keeps every key for itself. */
export { isTyping };

/** The Pro action a key press means, if any (its keys come from the keymap: presets and the user's own). */
export function actionFor(e: KeyboardEvent): ShortcutAction | undefined {
  const c = commandFor(e, KeyScope.Pro);
  return c ? (c.id.slice("pro.".length) as ShortcutAction) : undefined;
}

/** A handler returns false to let the key through (⌘C with no keys selected copies text as usual). */
export type ShortcutHandler = (e: KeyboardEvent) => boolean | void;
export type ShortcutHandlers = Partial<Record<ShortcutAction, ShortcutHandler>>;

/**
 * Bind the table: one capture-phase listener, so these keys win over the canvas selection's
 * Delete. Handlers are read fresh on every press (no re-subscribing while the timeline re-renders).
 */
export function useProShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      const action = actionFor(e);
      if (!action) return;
      const run = ref.current[action];
      if (!run || run(e) === false) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
