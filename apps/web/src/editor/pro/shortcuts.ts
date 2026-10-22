import { useEffect, useRef } from "react";

/**
 * Pro mode's After Effects keyboard shortcuts, as one table: the timeline binds handlers to the
 * actions and the help popover lists the same rows, so the two never drift apart.
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
  GoToStart: "go_to_start",
  GoToEnd: "go_to_end",
  PrevFrame: "prev_frame",
  NextFrame: "next_frame",
  PlayPause: "play_pause",
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

export const ShortcutSection = {
  Reveal: "Reveal properties",
  Navigate: "Navigation",
  Timing: "Layer timing",
  Layers: "Layers",
  Keys: "Keyframes",
  Markers: "Markers & work area",
  View: "View",
} as const;
export type ShortcutSection = (typeof ShortcutSection)[keyof typeof ShortcutSection];

/** Modifier state a combo needs: `true`/`false` must match, `Any` ignores it (Shift+P adds to a reveal). */
export const Mod = { Any: "any" } as const;
type ModState = boolean | typeof Mod.Any;

/** A key press: `key` matches KeyboardEvent.key (case-insensitive) and `code` the physical key, either one. `cmd` is ⌘ or Ctrl. */
export type Combo = { key?: string; code?: string; cmd?: ModState; shift?: ModState; alt?: ModState };

export type Shortcut = {
  action: ShortcutAction;
  combos: Combo[];
  /** As the help shows it. */
  label: string;
  help: string;
  section: ShortcutSection;
  /** Handled elsewhere (useTransportKeys); listed so the help is complete. */
  external?: boolean;
};

const letter = (k: string, shift: ModState = false): Combo => ({ key: k, code: `Key${k.toUpperCase()}`, shift });

export const SHORTCUTS: readonly Shortcut[] = [
  { action: ShortcutAction.RevealPosition, combos: [letter("p", Mod.Any)], label: "P", help: "Position only (Shift adds)", section: ShortcutSection.Reveal },
  { action: ShortcutAction.RevealScale, combos: [letter("s", Mod.Any)], label: "S", help: "Scale only (Shift adds)", section: ShortcutSection.Reveal },
  { action: ShortcutAction.RevealRotation, combos: [letter("r", Mod.Any)], label: "R", help: "Rotation only (Shift adds)", section: ShortcutSection.Reveal },
  { action: ShortcutAction.RevealOpacity, combos: [letter("t", Mod.Any)], label: "T", help: "Opacity only (Shift adds)", section: ShortcutSection.Reveal },
  { action: ShortcutAction.RevealAnchor, combos: [letter("a", Mod.Any)], label: "A", help: "Anchor Point only (Shift adds)", section: ShortcutSection.Reveal },
  { action: ShortcutAction.RevealAnimated, combos: [letter("u")], label: "U · UU", help: "Animated properties · modified properties", section: ShortcutSection.Reveal },

  { action: ShortcutAction.PrevItem, combos: [letter("j")], label: "J", help: "Previous keyframe or marker", section: ShortcutSection.Navigate },
  { action: ShortcutAction.NextItem, combos: [letter("k")], label: "K", help: "Next keyframe or marker", section: ShortcutSection.Navigate },
  { action: ShortcutAction.GoToIn, combos: [letter("i")], label: "I", help: "Layer in point", section: ShortcutSection.Navigate },
  { action: ShortcutAction.GoToOut, combos: [letter("o")], label: "O", help: "Layer out point", section: ShortcutSection.Navigate },
  { action: ShortcutAction.GoToStart, combos: [{ key: "Home" }], label: "Home", help: "First frame", section: ShortcutSection.Navigate, external: true },
  { action: ShortcutAction.GoToEnd, combos: [{ key: "End" }], label: "End", help: "Last frame", section: ShortcutSection.Navigate, external: true },
  { action: ShortcutAction.PrevFrame, combos: [{ key: "PageUp" }, { key: "ArrowLeft", cmd: true }], label: "Page Up · ⌘←", help: "One frame back", section: ShortcutSection.Navigate, external: true },
  { action: ShortcutAction.NextFrame, combos: [{ key: "PageDown" }, { key: "ArrowRight", cmd: true }], label: "Page Down · ⌘→", help: "One frame forward", section: ShortcutSection.Navigate, external: true },
  { action: ShortcutAction.PlayPause, combos: [{ key: " " }], label: "Space", help: "Play / pause", section: ShortcutSection.Navigate, external: true },

  { action: ShortcutAction.MoveIn, combos: [{ key: "[", code: "BracketLeft" }], label: "[", help: "Move the layer's in point to the playhead", section: ShortcutSection.Timing },
  { action: ShortcutAction.MoveOut, combos: [{ key: "]", code: "BracketRight" }], label: "]", help: "Move the layer's out point to the playhead", section: ShortcutSection.Timing },
  { action: ShortcutAction.TrimIn, combos: [{ code: "BracketLeft", alt: true }], label: "⌥[", help: "Trim the in point at the playhead", section: ShortcutSection.Timing },
  { action: ShortcutAction.TrimOut, combos: [{ code: "BracketRight", alt: true }], label: "⌥]", help: "Trim the out point at the playhead", section: ShortcutSection.Timing },

  { action: ShortcutAction.Duplicate, combos: [{ ...letter("d"), cmd: true }], label: "⌘D", help: "Duplicate layer", section: ShortcutSection.Layers },
  { action: ShortcutAction.Split, combos: [{ ...letter("d", true), cmd: true }], label: "⌘⇧D", help: "Split layer at the playhead", section: ShortcutSection.Layers },
  { action: ShortcutAction.SelectAll, combos: [{ ...letter("a"), cmd: true }], label: "⌘A", help: "Select all layers", section: ShortcutSection.Layers },

  { action: ShortcutAction.CopyKeys, combos: [{ ...letter("c"), cmd: true }], label: "⌘C", help: "Copy selected keyframes", section: ShortcutSection.Keys },
  { action: ShortcutAction.PasteKeys, combos: [{ ...letter("v"), cmd: true }], label: "⌘V", help: "Paste keyframes at the playhead", section: ShortcutSection.Keys },
  { action: ShortcutAction.EasyEase, combos: [{ key: "F9" }], label: "F9", help: "Easy Ease", section: ShortcutSection.Keys },
  { action: ShortcutAction.EasyEaseIn, combos: [{ key: "F9", shift: true }], label: "⇧F9", help: "Easy Ease In", section: ShortcutSection.Keys },
  { action: ShortcutAction.EasyEaseOut, combos: [{ key: "F9", shift: true, cmd: true }], label: "⌘⇧F9", help: "Easy Ease Out", section: ShortcutSection.Keys },
  { action: ShortcutAction.Delete, combos: [{ key: "Delete" }, { key: "Backspace" }], label: "Delete", help: "Remove selected keyframes or marker", section: ShortcutSection.Keys },
  { action: ShortcutAction.Deselect, combos: [{ key: "Escape" }], label: "Esc", help: "Deselect keyframes and markers", section: ShortcutSection.Keys },

  { action: ShortcutAction.AddMarker, combos: [letter("m"), { key: "*", code: "NumpadMultiply", shift: Mod.Any }], label: "M · Num *", help: "Add a marker at the playhead", section: ShortcutSection.Markers },
  { action: ShortcutAction.WorkAreaIn, combos: [letter("b")], label: "B", help: "Work area starts at the playhead", section: ShortcutSection.Markers },
  { action: ShortcutAction.WorkAreaOut, combos: [letter("n")], label: "N", help: "Work area ends at the playhead", section: ShortcutSection.Markers },

  { action: ShortcutAction.GraphEditor, combos: [{ key: "F3", shift: true }], label: "⇧F3", help: "Graph Editor", section: ShortcutSection.View },
  { action: ShortcutAction.Help, combos: [{ key: "?", shift: Mod.Any }], label: "?", help: "This list", section: ShortcutSection.View },
];

const modOk = (want: ModState | undefined, on: boolean) => want === Mod.Any || (want ?? false) === on;

export function matches(c: Combo, e: KeyboardEvent): boolean {
  const keyOk = (c.key !== undefined && e.key.toLowerCase() === c.key.toLowerCase()) || (c.code !== undefined && e.code === c.code);
  return keyOk && modOk(c.cmd, e.metaKey || e.ctrlKey) && modOk(c.shift, e.shiftKey) && modOk(c.alt, e.altKey);
}

/** The shortcut a key press means, if any. */
export function shortcutFor(e: KeyboardEvent): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.combos.some((c) => matches(c, e)));
}

/** Typing in a field (or a contentEditable) keeps every key for itself. */
export function isTyping(target: EventTarget | null) {
  const t = target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
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
      const s = shortcutFor(e);
      if (!s || s.external) return;
      const run = ref.current[s.action];
      if (!run || run(e) === false) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
