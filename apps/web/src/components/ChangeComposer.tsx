import { api } from "../api/client";
import { ActivitySource, logActivity, useEditor } from "../store";
import { scopedInstruction } from "../timeline/SelectionOverlay";
import { ReferenceStrip, useReferences } from "./References";
import type { Generation } from "./useGenerate";
import { useState } from "react";

/**
 * Bottom of the sidebar, always at hand: ask for a change. With an object or group selected on
 * the canvas the request goes only to it (cheap, targeted edits — the point of the editor). While
 * the agent works, the box stays open: the note goes to the running agent as feedback.
 */
export function ChangeComposer({ g, hasScene, projectId }: { g: Generation; hasScene: boolean; projectId: string }) {
  const [text, setText] = useState("");
  const refs = useReferences();
  const layer = useEditor((s) => s.selectedLayerId);
  const group = useEditor((s) => s.selectedGroup);
  const time = useEditor((s) => s.time);
  const target = group ?? layer;
  const disabled = !hasScene && !g.running;

  const send = async () => {
    const t = text.trim();
    if (!t || disabled) return;
    if (g.running) {
      // Whole-video notes carry no time; a selection pins the note to it at the current second.
      api.addComment(projectId, t, target ? time : undefined, layer ?? undefined).catch((e: Error) => logActivity(ActivitySource.System, e.message));
      logActivity(ActivitySource.User, `${target ? `${target} @${time.toFixed(1)}s` : "Whole video"}: ${t}`);
      setText("");
      return;
    }
    if (await g.start(scopedInstruction(t, time, group, layer), refs.refs)) {
      setText("");
      refs.clear();
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      {...refs.handlers}
    >
      <span className="text-xs text-neutral-500">
        {target ? (
          <>
            Change <span className="text-neutral-200">{target}</span> · {time.toFixed(1)} s
          </>
        ) : g.running ? (
          "The agent is working · your note goes straight to it"
        ) : hasScene ? (
          "Ask for a change to the whole video, or select an object"
        ) : (
          "Once there's a video, ask for changes here"
        )}
      </span>
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
          rows={2}
          placeholder={g.running ? "“bolder font everywhere”, “darker background”…" : target ? "“bigger”, “redesign it”, “bounce in”…" : "“faster pace”, “warmer palette”…"}
          className="min-h-0 flex-1 resize-none rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/30 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          aria-label="Send change"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-neutral-900 hover:bg-neutral-200 disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          ↑
        </button>
      </div>
      <ReferenceStrip r={refs} compact />
    </form>
  );
}
