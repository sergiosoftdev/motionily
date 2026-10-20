import { useState } from "react";
import { api } from "../api/client";
import { ActivitySource, logActivity, useEditor } from "../store";
import { Section } from "./Section";

/** What a note is about: the whole video (font, background, pace…) or the moment on screen. */
const Scope = { Video: "video", Moment: "moment" } as const;
type Scope = (typeof Scope)[keyof typeof Scope];

export function FeedbackBox({ projectId }: { projectId: string }) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>(Scope.Video);
  const time = useEditor((s) => s.time);
  const at = scope === Scope.Moment ? time : undefined;

  const send = () => {
    const t = text.trim();
    if (!t) return;
    api.addComment(projectId, t, at).catch((e: Error) => logActivity(ActivitySource.System, e.message));
    logActivity(ActivitySource.User, at === undefined ? `Whole video: ${t}` : `@${at.toFixed(1)}s: ${t}`);
    setText("");
  };

  return (
    <Section title="Feedback" hint="The agent reads it while it works and fixes it.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex gap-1 self-start rounded-lg bg-neutral-900 p-0.5 text-xs">
          {[
            [Scope.Video, "Whole video"],
            [Scope.Moment, `At ${time.toFixed(1)}s`],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value as Scope)}
              className={`rounded-md px-2.5 py-1 ${scope === value ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={3}
          placeholder={at === undefined ? `"use a bolder font everywhere", "darker background", "faster pace"…` : `At ${at.toFixed(1)}s… "the card comes in too slowly"`}
          className="resize-none rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="self-end rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
        >
          Send to the agent
        </button>
      </form>
    </Section>
  );
}
