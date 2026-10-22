import { useState } from "react";
import { flushSync } from "react-dom";

/** The editors: Simple (watch, click, ask), Pro (After Effects-like panels and keyframes) and Edit (CapCut-like tracks). */
export const EditorMode = { Simple: "simple", Pro: "pro", Edit: "edit" } as const;
export type EditorMode = (typeof EditorMode)[keyof typeof EditorMode];

const MODE_KEY = "motionily.editorMode";

/** Every mode with its label, in switch order (each editor's header lists them all). */
export const EDITOR_MODES: [EditorMode, string][] = [
  [EditorMode.Simple, "Simple"],
  [EditorMode.Pro, "Pro"],
  [EditorMode.Edit, "Edit"],
];

function load(): EditorMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return (Object.values(EditorMode) as string[]).includes(saved ?? "") ? (saved as EditorMode) : EditorMode.Simple;
  } catch {
    return EditorMode.Simple;
  }
}

/** Remember the mode the next editor opens in (also used to open a new video straight in Edit). */
export function saveEditorMode(m: EditorMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // Not critical: the next visit opens Simple.
  }
}

/** Where the last click landed: a new mode spreads from there. */
let lastPointer = { x: 0, y: 0 };
window.addEventListener("pointerdown", (e) => (lastPointer = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });

/**
 * Change modes inside a view transition: the pieces every mode has (the preview, the timeline,
 * the side panels, the ask box, the header) fly from their place in one layout to their place in
 * the other, and the new layout spreads in a circle from the click (styles in index.css).
 */
function transition(update: () => void) {
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return update();
  const { x, y } = lastPointer;
  const root = document.documentElement.style;
  root.setProperty("--mode-x", `${x}px`);
  root.setProperty("--mode-y", `${y}px`);
  // Far enough to cover the farthest corner.
  root.setProperty("--mode-r", `${Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)))}px`);
  // The pieces get their transition names only while switching: a named element is its own stacking
  // context, which would trap any modal opened inside it (a dialog in the header under the timeline).
  const html = document.documentElement;
  html.dataset.modeSwitch = "";
  const done = () => delete html.dataset.modeSwitch;
  // Synchronous on purpose: rendering is paused while this runs, so waiting for a frame here
  // would hang the switch until the browser gives up.
  document.startViewTransition(() => flushSync(update)).finished.then(done, done);
}

/** The viewer's editor mode, remembered on this browser. */
export function useEditorMode(): [EditorMode, (m: EditorMode) => void] {
  const [mode, setMode] = useState<EditorMode>(load);
  return [
    mode,
    (m) => {
      if (m === mode) return;
      transition(() => setMode(m));
      saveEditorMode(m);
    },
  ];
}

/**
 * Classes of the pieces that fly between modes; index.css names them (`view-transition-name`) only
 * while a switch runs. At most one of each on screen. The preview canvas is `data-mode-piece="preview"`.
 */
export const ModePiece = {
  Header: "mode-piece-header",
  Left: "mode-piece-left",
  Right: "mode-piece-right",
  Timeline: "mode-piece-timeline",
  Ask: "mode-piece-ask",
} as const;

/** Simple / Pro / Edit switch. */
export function ModeSwitch({ mode, onChange, className = "" }: { mode: EditorMode; onChange: (m: EditorMode) => void; className?: string }) {
  return (
    <div className={`flex rounded-lg p-0.5 text-xs ${className}`} role="tablist" aria-label="Editor mode">
      {EDITOR_MODES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          onClick={() => onChange(value)}
          className={`rounded-md px-3 py-1 font-medium ${mode === value ? "bg-white text-neutral-900" : "text-neutral-400 hover:text-white"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
