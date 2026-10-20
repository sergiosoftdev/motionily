import { useState } from "react";

/** The two editors: Simple (watch, click, ask) and Pro (After Effects-like panels and keyframes). */
export const EditorMode = { Simple: "simple", Pro: "pro" } as const;
export type EditorMode = (typeof EditorMode)[keyof typeof EditorMode];

const MODE_KEY = "motionily.editorMode";

function load(): EditorMode {
  try {
    return localStorage.getItem(MODE_KEY) === EditorMode.Pro ? EditorMode.Pro : EditorMode.Simple;
  } catch {
    return EditorMode.Simple;
  }
}

/** The viewer's editor mode, remembered on this browser. */
export function useEditorMode(): [EditorMode, (m: EditorMode) => void] {
  const [mode, setMode] = useState<EditorMode>(load);
  return [
    mode,
    (m) => {
      setMode(m);
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        // Not critical: the next visit opens Simple.
      }
    },
  ];
}

/** Simple / Pro switch. */
export function ModeSwitch({ mode, onChange, className = "" }: { mode: EditorMode; onChange: (m: EditorMode) => void; className?: string }) {
  return (
    <div className={`flex rounded-lg p-0.5 text-xs ${className}`} role="tablist" aria-label="Editor mode">
      {[
        [EditorMode.Simple, "Simple"],
        [EditorMode.Pro, "Pro"],
      ].map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          onClick={() => onChange(value as EditorMode)}
          className={`rounded-md px-3 py-1 font-medium ${mode === value ? "bg-white text-neutral-900" : "text-neutral-400 hover:text-white"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
