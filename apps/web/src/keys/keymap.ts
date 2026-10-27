/**
 * Every keyboard command of the editors in one registry, with presets that match the editors people
 * come from (Premiere Pro, DaVinci Resolve, Final Cut Pro) and the user's own reassignments on top.
 * Playback (transport), the Pro compositor and the Edit timeline each look up the command a key press
 * means here, and Settings › Keyboard edits the same table, so the keys and their help never drift.
 */

/** Modifier state a combo needs: `true`/`false` must match, `Any` ignores it (Shift+P adds to a reveal). */
export const Mod = { Any: "any" } as const;
type ModState = boolean | typeof Mod.Any;

/** A key press: `key` matches KeyboardEvent.key (case-insensitive) and `code` the physical key, either one. `cmd` is ⌘ or Ctrl. */
export type Combo = { key?: string; code?: string; cmd?: ModState; shift?: ModState; alt?: ModState };

/** Where a command works: playback in every editor, or one editor's own keys (which win over playback). */
export const KeyScope = { Transport: "transport", Pro: "pro", Edit: "edit" } as const;
export type KeyScope = (typeof KeyScope)[keyof typeof KeyScope];
export const SCOPE_LABEL: Record<KeyScope, string> = { transport: "Playback (every editor)", pro: "Pro (compositor)", edit: "Edit (timeline)" };

export type Command = { id: string; scope: KeyScope; section: string; help: string; defaults: Combo[] };

const letter = (k: string, shift: ModState = false, cmd: ModState = false): Combo => ({ key: k, code: `Key${k.toUpperCase()}`, shift, cmd });
const key = (k: string, mods: Omit<Combo, "key" | "code"> = {}): Combo => ({ key: k, ...mods });

const T = KeyScope.Transport;
const P = KeyScope.Pro;
const E = KeyScope.Edit;

/** Defaults: Motionily's own map (After Effects keys in Pro, Resolve-like keys in Edit). */
export const COMMANDS: readonly Command[] = [
  { id: "transport.play_pause", scope: T, section: "Playback", help: "Play / pause", defaults: [key(" ")] },
  { id: "transport.shuttle_back", scope: T, section: "Playback", help: "Shuttle backwards (again = faster)", defaults: [letter("j")] },
  { id: "transport.shuttle_stop", scope: T, section: "Playback", help: "Stop shuttling", defaults: [letter("k")] },
  { id: "transport.shuttle_forward", scope: T, section: "Playback", help: "Shuttle forward (again = faster)", defaults: [letter("l")] },
  { id: "transport.go_start", scope: T, section: "Playback", help: "First frame", defaults: [key("Home")] },
  { id: "transport.go_end", scope: T, section: "Playback", help: "Last frame", defaults: [key("End")] },
  { id: "transport.prev_frame", scope: T, section: "Playback", help: "One frame back", defaults: [key("PageUp"), key("ArrowLeft", { cmd: true })] },
  { id: "transport.next_frame", scope: T, section: "Playback", help: "One frame forward", defaults: [key("PageDown"), key("ArrowRight", { cmd: true })] },

  { id: "pro.reveal_position", scope: P, section: "Reveal properties", help: "Position only (Shift adds)", defaults: [letter("p", Mod.Any)] },
  { id: "pro.reveal_scale", scope: P, section: "Reveal properties", help: "Scale only (Shift adds)", defaults: [letter("s", Mod.Any)] },
  { id: "pro.reveal_rotation", scope: P, section: "Reveal properties", help: "Rotation only (Shift adds)", defaults: [letter("r", Mod.Any)] },
  { id: "pro.reveal_opacity", scope: P, section: "Reveal properties", help: "Opacity only (Shift adds)", defaults: [letter("t", Mod.Any)] },
  { id: "pro.reveal_anchor", scope: P, section: "Reveal properties", help: "Anchor Point only (Shift adds)", defaults: [letter("a", Mod.Any)] },
  { id: "pro.reveal_animated", scope: P, section: "Reveal properties", help: "Animated properties (twice: modified ones)", defaults: [letter("u")] },
  { id: "pro.prev_item", scope: P, section: "Navigation", help: "Previous keyframe or marker", defaults: [letter("j")] },
  { id: "pro.next_item", scope: P, section: "Navigation", help: "Next keyframe or marker", defaults: [letter("k")] },
  { id: "pro.go_to_in", scope: P, section: "Navigation", help: "Layer in point", defaults: [letter("i")] },
  { id: "pro.go_to_out", scope: P, section: "Navigation", help: "Layer out point", defaults: [letter("o")] },
  { id: "pro.move_in", scope: P, section: "Layer timing", help: "Move the layer's in point to the playhead", defaults: [{ key: "[", code: "BracketLeft" }] },
  { id: "pro.move_out", scope: P, section: "Layer timing", help: "Move the layer's out point to the playhead", defaults: [{ key: "]", code: "BracketRight" }] },
  { id: "pro.trim_in", scope: P, section: "Layer timing", help: "Trim the in point at the playhead", defaults: [{ code: "BracketLeft", alt: true }] },
  { id: "pro.trim_out", scope: P, section: "Layer timing", help: "Trim the out point at the playhead", defaults: [{ code: "BracketRight", alt: true }] },
  { id: "pro.duplicate", scope: P, section: "Layers", help: "Duplicate layer", defaults: [letter("d", false, true)] },
  { id: "pro.split", scope: P, section: "Layers", help: "Split layer at the playhead", defaults: [letter("d", true, true)] },
  { id: "pro.select_all", scope: P, section: "Layers", help: "Select all layers", defaults: [letter("a", false, true)] },
  { id: "pro.copy_keys", scope: P, section: "Keyframes", help: "Copy selected keyframes", defaults: [letter("c", false, true)] },
  { id: "pro.paste_keys", scope: P, section: "Keyframes", help: "Paste keyframes at the playhead", defaults: [letter("v", false, true)] },
  { id: "pro.easy_ease", scope: P, section: "Keyframes", help: "Easy Ease", defaults: [key("F9")] },
  { id: "pro.easy_ease_in", scope: P, section: "Keyframes", help: "Easy Ease In", defaults: [key("F9", { shift: true })] },
  { id: "pro.easy_ease_out", scope: P, section: "Keyframes", help: "Easy Ease Out", defaults: [key("F9", { shift: true, cmd: true })] },
  { id: "pro.delete", scope: P, section: "Keyframes", help: "Remove selected keyframes or marker", defaults: [key("Delete"), key("Backspace")] },
  { id: "pro.deselect", scope: P, section: "Keyframes", help: "Deselect keyframes and markers", defaults: [key("Escape")] },
  { id: "pro.add_marker", scope: P, section: "Markers & work area", help: "Add a marker at the playhead", defaults: [letter("m"), { key: "*", code: "NumpadMultiply", shift: Mod.Any }] },
  { id: "pro.work_area_in", scope: P, section: "Markers & work area", help: "Work area starts at the playhead", defaults: [letter("b")] },
  { id: "pro.work_area_out", scope: P, section: "Markers & work area", help: "Work area ends at the playhead", defaults: [letter("n")] },
  { id: "pro.graph_editor", scope: P, section: "View", help: "Graph Editor", defaults: [key("F3", { shift: true })] },
  { id: "pro.help", scope: P, section: "View", help: "Keyboard shortcuts", defaults: [{ key: "?", shift: Mod.Any }] },

  { id: "edit.undo", scope: E, section: "Edit", help: "Undo", defaults: [letter("z", false, true)] },
  { id: "edit.redo", scope: E, section: "Edit", help: "Redo", defaults: [letter("z", true, true)] },
  { id: "edit.blade", scope: E, section: "Edit", help: "Cut at the playhead", defaults: [letter("s"), letter("b", false, true)] },
  { id: "edit.delete", scope: E, section: "Edit", help: "Delete the selection (closing the gap on the main track)", defaults: [key("Delete"), key("Backspace")] },
  { id: "edit.select_tool", scope: E, section: "Tools", help: "Selection tool", defaults: [letter("a")] },
  { id: "edit.trim_tool", scope: E, section: "Tools", help: "Trim tool", defaults: [letter("t")] },
  { id: "edit.mark_in", scope: E, section: "Marks", help: "Mark in", defaults: [letter("i")] },
  { id: "edit.mark_out", scope: E, section: "Marks", help: "Mark out", defaults: [letter("o")] },
  { id: "edit.clear_marks", scope: E, section: "Marks", help: "Clear in and out", defaults: [{ code: "KeyX", alt: true }] },
  { id: "edit.add_marker", scope: E, section: "Marks", help: "Add a marker", defaults: [letter("m")] },
  { id: "edit.insert", scope: E, section: "Three-point editing", help: "Insert the source clip", defaults: [key("F9")] },
  { id: "edit.overwrite", scope: E, section: "Three-point editing", help: "Overwrite with the source clip", defaults: [key("F10")] },
  { id: "edit.replace", scope: E, section: "Three-point editing", help: "Replace with the source clip", defaults: [key("F11")] },
  { id: "edit.copy_grade", scope: E, section: "Color", help: "Copy the clip's grade", defaults: [{ code: "KeyC", cmd: true, alt: true }] },
  { id: "edit.paste_grade", scope: E, section: "Color", help: "Paste the grade on the selected clips", defaults: [{ code: "KeyV", cmd: true, alt: true }] },
];

export const KeyPreset = { Motionily: "motionily", Premiere: "premiere", Resolve: "resolve", FinalCut: "finalcut" } as const;
export type KeyPreset = (typeof KeyPreset)[keyof typeof KeyPreset];

/** Each preset changes only what that editor does differently from Motionily's map. */
export const PRESETS: Record<KeyPreset, { label: string; keys: Record<string, Combo[]> }> = {
  motionily: { label: "Motionily", keys: {} },
  premiere: {
    label: "Adobe Premiere Pro",
    keys: {
      "transport.prev_frame": [key("ArrowLeft")],
      "transport.next_frame": [key("ArrowRight")],
      "edit.blade": [letter("k", false, true)],
      "edit.select_tool": [letter("v")],
      "edit.trim_tool": [letter("b")],
      "edit.clear_marks": [letter("x", true, true)],
      "edit.insert": [{ key: ",", code: "Comma" }],
      "edit.overwrite": [{ key: ".", code: "Period" }],
      "edit.replace": [],
    },
  },
  resolve: {
    label: "DaVinci Resolve",
    keys: {
      "transport.prev_frame": [key("ArrowLeft")],
      "transport.next_frame": [key("ArrowRight")],
      "edit.blade": [letter("b", false, true), { code: "Backslash", cmd: true }],
      "edit.select_tool": [letter("a")],
      "edit.trim_tool": [letter("t")],
      "edit.clear_marks": [{ code: "KeyX", alt: true }],
    },
  },
  finalcut: {
    label: "Final Cut Pro",
    keys: {
      "transport.prev_frame": [key("ArrowLeft")],
      "transport.next_frame": [key("ArrowRight")],
      "edit.blade": [letter("b", false, true)],
      "edit.select_tool": [letter("a")],
      "edit.trim_tool": [letter("t")],
      "edit.clear_marks": [{ code: "KeyX", alt: true }],
      "edit.insert": [letter("w")],
      "edit.overwrite": [letter("d")],
      "edit.replace": [letter("r", true)],
    },
  },
};

const STORAGE_KEY = "motionily.keymap";
type Stored = { preset: KeyPreset; custom: Record<string, Combo[]> };

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Stored>;
      return { preset: s.preset && s.preset in PRESETS ? s.preset : KeyPreset.Motionily, custom: s.custom ?? {} };
    }
  } catch {
    // Storage blocked or corrupted: the defaults.
  }
  return { preset: KeyPreset.Motionily, custom: {} };
}

let state: Stored = typeof localStorage === "undefined" ? { preset: KeyPreset.Motionily, custom: {} } : load();
const listeners = new Set<() => void>();

function save(next: Stored) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not critical: the map lasts until the page closes.
  }
  listeners.forEach((fn) => fn());
}

export const keymap = {
  get preset() {
    return state.preset;
  },
  setPreset(preset: KeyPreset) {
    save({ preset, custom: {} });
  },
  /** The user's own combos for a command (null puts the preset's back). */
  setCustom(id: string, combos: Combo[] | null) {
    const custom = { ...state.custom };
    if (combos === null) delete custom[id];
    else custom[id] = combos;
    save({ ...state, custom });
  },
  isCustom: (id: string) => id in state.custom,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** What a command answers to now: the user's combos, else the preset's, else Motionily's. */
export function combosFor(id: string): Combo[] {
  return state.custom[id] ?? PRESETS[state.preset].keys[id] ?? COMMANDS.find((c) => c.id === id)?.defaults ?? [];
}

const modOk = (want: ModState | undefined, on: boolean) => want === Mod.Any || (want ?? false) === on;

export function matches(c: Combo, e: KeyboardEvent): boolean {
  const keyOk = (c.key !== undefined && e.key.toLowerCase() === c.key.toLowerCase()) || (c.code !== undefined && e.code === c.code);
  return keyOk && modOk(c.cmd, e.metaKey || e.ctrlKey) && modOk(c.shift, e.shiftKey) && modOk(c.alt, e.altKey);
}

/** The command of `scope` a key press means, if any. */
export function commandFor(e: KeyboardEvent, scope: KeyScope): Command | undefined {
  return COMMANDS.find((c) => c.scope === scope && combosFor(c.id).some((combo) => matches(combo, e)));
}

/** Typing in a field (or a contentEditable) keeps every key for itself. */
export function isTyping(target: EventTarget | null) {
  const t = target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const KEY_NAMES: Record<string, string> = { " ": "Space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", PageUp: "Page Up", PageDown: "Page Down", Backspace: "⌫", Delete: "Del" };

/** "⌘⇧D", "Ctrl+Shift+D", "Space", "Num *". */
export function comboLabel(c: Combo): string {
  const name = c.key ? (KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key)) : c.code === "NumpadMultiply" ? "Num *" : (c.code ?? "?").replace(/^Key|^Digit/, "");
  const mods = isMac ? [c.cmd === true && "⌘", c.alt === true && "⌥", c.shift === true && "⇧"] : [c.cmd === true && "Ctrl+", c.alt === true && "Alt+", c.shift === true && "Shift+"];
  return `${mods.filter(Boolean).join("")}${name}`;
}

export const commandLabel = (id: string) => combosFor(id).map(comboLabel).join(" · ") || "—";

/** A key press as a combo to assign (the physical key, so layouts keep it; Shift kept as pressed). */
export function comboFromEvent(e: KeyboardEvent): Combo | null {
  if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return null;
  const physical = /^(Key[A-Z]|Digit\d|Bracket(Left|Right)|Comma|Period|Minus|Equal|Backslash|Slash|Semicolon|Quote|Numpad.*)$/.test(e.code);
  return { ...(physical ? { code: e.code } : { key: e.key }), cmd: e.metaKey || e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
}

const same = (a: Combo, b: Combo) =>
  (a.code ?? a.key?.toLowerCase()) === (b.code ?? b.key?.toLowerCase()) && (a.cmd ?? false) === (b.cmd ?? false) && (a.alt ?? false) === (b.alt ?? false) && (a.shift === Mod.Any || b.shift === Mod.Any || (a.shift ?? false) === (b.shift ?? false));

/** Commands of the same scope that answer to the same key (an editor's own keys win over playback's on purpose: Pro's J/K). */
export function conflicts(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of COMMANDS)
    for (const b of COMMANDS) {
      if (a.id >= b.id || a.scope !== b.scope) continue;
      if (combosFor(a.id).some((x) => combosFor(b.id).some((y) => same(x, y)))) {
        out.set(a.id, [...(out.get(a.id) ?? []), b.id]);
        out.set(b.id, [...(out.get(b.id) ?? []), a.id]);
      }
    }
  return out;
}
