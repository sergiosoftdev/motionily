import { useState } from "react";
import { api } from "../api/client";
import { ActivitySource, logActivity, useEditor } from "../store";
import { scopedInstruction } from "../timeline/SelectionOverlay";
import { ReferenceStrip, useReferences } from "./References";
import type { Generation } from "./useGenerate";

export const AskVariant = { Simple: "simple", Pro: "pro" } as const;
export type AskVariant = (typeof AskVariant)[keyof typeof AskVariant];

const STYLE: Record<AskVariant, { box: string; input: string; send: string; chip: string; chipOn: string }> = {
  [AskVariant.Simple]: {
    box: "rounded-2xl bg-neutral-900 p-2 ring-1 ring-white/10 focus-within:ring-white/25",
    input: "px-2 py-1.5 text-[15px]",
    send: "size-9 rounded-full bg-white text-neutral-900 hover:bg-neutral-200",
    chip: "rounded-full px-2.5 py-1 text-xs text-neutral-400 ring-1 ring-white/10 hover:text-white",
    chipOn: "rounded-full bg-white/10 px-2.5 py-1 text-xs text-white ring-1 ring-white/20",
  },
  [AskVariant.Pro]: {
    box: "rounded bg-[#1b1b1b] p-1.5 ring-1 ring-black focus-within:ring-[#2d8ceb]",
    input: "px-1.5 py-1 text-xs",
    send: "size-7 rounded bg-[#2d8ceb] text-white hover:bg-[#4a9ff0]",
    chip: "rounded px-1.5 py-0.5 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:text-white",
    chipOn: "rounded bg-[#2d8ceb]/25 px-1.5 py-0.5 text-[11px] text-[#9cc9f5] ring-1 ring-[#2d8ceb]/50",
  },
};

/**
 * The one place to ask for a change. It goes to the selected object or group, to the moment on
 * screen, or to the whole video. While the agent works, the note reaches it as feedback.
 */
export function AskBox({ g, hasScene, projectId, variant }: { g: Generation; hasScene: boolean; projectId: string; variant: AskVariant }) {
  const [text, setText] = useState("");
  const refs = useReferences();
  const layer = useEditor((s) => s.selectedLayerId);
  const group = useEditor((s) => s.selectedGroup);
  const moment = useEditor((s) => s.pinnedMoment);
  const time = useEditor((s) => s.time);
  const target = group ?? layer;
  const disabled = !hasScene && !g.running;
  const st = STYLE[variant];

  const send = async () => {
    const t = text.trim();
    if (!t || disabled) return;
    if (g.running) {
      const at = target || moment ? time : undefined;
      const note = group ? `[group ${group}] ${t}` : t;
      api.addComment(projectId, note, at, layer ?? undefined).catch((e: Error) => logActivity(ActivitySource.System, e.message));
      logActivity(ActivitySource.User, `${target ?? (at === undefined ? "Whole video" : `@${at.toFixed(1)}s`)}: ${t}`);
      setText("");
      return;
    }
    if (await g.start(scopedInstruction(t, time, group, layer, moment), refs.refs)) {
      logActivity(ActivitySource.User, `${target ?? (moment ? `@${time.toFixed(1)}s` : "Whole video")}: ${t}`);
      setText("");
      refs.clear();
    }
  };

  const placeholder = disabled
    ? "Once there's a video, ask for changes here"
    : g.running
      ? "The agent is working · your note goes straight to it"
      : target
        ? `What should change in ${target}? “bigger”, “bounce in”, “redesign it”…`
        : moment
          ? `What should change at ${time.toFixed(1)}s?`
          : "Ask for any change: “warmer colors”, “faster pace”, “bolder font everywhere”…";

  return (
    <form
      className={`flex flex-col gap-1.5 ${st.box}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      {...refs.handlers}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {target ? (
          <span className={st.chipOn}>
            {group ? `▣ ${group}` : layer} · {time.toFixed(1)}s
            <button
              type="button"
              aria-label="Clear the selection"
              onClick={() => useEditor.setState({ selectedLayerId: null, selectedGroup: null })}
              className="ml-1.5 opacity-60 hover:opacity-100"
            >
              ×
            </button>
          </span>
        ) : null}
        {target && group && variant === AskVariant.Simple && <span className="px-1 text-xs text-neutral-600">click it again to pick one piece inside · ⌘-click picks it directly</span>}
        {target ? null : (
          <>
            <button type="button" onClick={() => useEditor.setState({ pinnedMoment: false })} className={moment ? st.chip : st.chipOn}>
              Whole video
            </button>
            <button type="button" onClick={() => useEditor.setState({ pinnedMoment: true })} className={moment ? st.chipOn : st.chip}>
              At {time.toFixed(1)}s
            </button>
            {variant === AskVariant.Simple && <span className="px-1 text-xs text-neutral-600">or click something in the video</span>}
          </>
        )}
        <div className="ml-auto">
          <ReferenceStrip r={refs} compact />
        </div>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={disabled}
          rows={variant === AskVariant.Simple ? 2 : 3}
          placeholder={placeholder}
          className={`min-h-0 flex-1 resize-none bg-transparent placeholder:text-neutral-600 focus:outline-none disabled:opacity-50 ${st.input}`}
        />
        <button type="submit" disabled={disabled || !text.trim()} aria-label="Send" className={`flex shrink-0 items-center justify-center disabled:opacity-30 ${st.send}`}>
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
          </svg>
        </button>
      </div>
    </form>
  );
}
