import { useState } from "react";
import { FeedbackKind } from "@motionily/protocol";
import { agentBridge } from "../bridge";
import { ActivitySource, logActivity, useEditor } from "../store";
import { Section } from "./Section";

export function FeedbackBox() {
  const [text, setText] = useState("");
  const time = useEditor((s) => s.time);
  const connected = useEditor((s) => s.agentConnected);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    agentBridge.feedback({ kind: FeedbackKind.Comment, at: time, text: t, createdAt: new Date().toISOString() });
    logActivity(ActivitySource.User, `@${time.toFixed(1)}s: ${t}`);
    setText("");
  };

  return (
    <Section title="Feedback" hint="Se ancla al segundo actual. El agente lo lee y corrige.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex flex-col gap-2"
      >
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
          placeholder={`En ${time.toFixed(1)}s… "la tarjeta entra muy lenta"`}
          className="resize-none rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        <button
          type="submit"
          disabled={!connected || !text.trim()}
          className="self-end rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
        >
          Enviar al agente
        </button>
      </form>
    </Section>
  );
}
