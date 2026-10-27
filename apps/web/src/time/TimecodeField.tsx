import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { engineHost } from "../engine/host";
import { useEditor } from "../store";
import { parseTimecode, timecode } from "./timecode";

/** Fired on window to open the go-to-time field, with the first characters typed (`detail`). */
export const GO_TO_TIME_EVENT = "motionily:go-to-time";
export const openGoToTime = (typed = "") => window.dispatchEvent(new CustomEvent(GO_TO_TIME_EVENT, { detail: typed }));

/**
 * The playhead's time, and the place to type one: click it (or the go-to-time key, or start typing
 * digits, + or - over the timeline) and enter a timecode, `512` for 5 s 12 f, `5.4` seconds or `+10`
 * / `-10` frames. `listens` makes this the field those keys open (one per editor).
 */
export function TimecodeField({
  fps,
  duration,
  listens = false,
  format = (t) => timecode(t, fps),
  className = "",
  inputClassName = "",
}: {
  fps: number;
  duration: number;
  listens?: boolean;
  format?: (t: number) => string;
  className?: string;
  inputClassName?: string;
}) {
  const time = useEditor((s) => s.time);
  const [typing, setTyping] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const open = typing !== null;

  useEffect(() => {
    if (!listens) return;
    // Keys typed before the field has focus arrive here too: they add to what is being typed.
    const open = (e: Event) => setTyping((prev) => (prev ?? "") + ((e as CustomEvent<string>).detail || ""));
    window.addEventListener(GO_TO_TIME_EVENT, open);
    return () => window.removeEventListener(GO_TO_TIME_EVENT, open);
  }, [listens]);

  const go = () => {
    const t = parseTimecode(input.current?.value ?? typing ?? "", fps, useEditor.getState().time);
    setTyping(null);
    if (t === null) return;
    engineHost.pause();
    engineHost.seek(Math.min(duration, Math.max(0, t)));
  };
  const goRef = useRef(go);
  goRef.current = go;

  // Focus as soon as it opens; keys that still reach the window before it has focus edit it too.
  useLayoutEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.target === input.current) return;
      if (e.key === "Enter") goRef.current();
      else if (e.key === "Escape") setTyping(null);
      else if (e.key === "Backspace") setTyping((v) => (v ?? "").slice(0, -1));
      else if (/^[0-9:;.+-]$/.test(e.key) && !e.metaKey && !e.ctrlKey) setTyping((v) => (v ?? "") + e.key);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (typing !== null)
    return (
      <input
        ref={input}
        value={typing}
        placeholder={timecode(time, fps)}
        aria-label="Go to time"
        onChange={(e) => setTyping(e.target.value)}
        onFocus={(e) => e.target.value && e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
        onKeyDown={(e) => {
          if (e.key === "Enter") go();
          if (e.key === "Escape") setTyping(null);
          e.stopPropagation();
        }}
        onBlur={go}
        className={`w-32 rounded-sm px-1 tabular-nums focus:outline-none ${inputClassName}`}
      />
    );
  return (
    <button type="button" onClick={() => setTyping("")} title="Go to time: a timecode, 512 = 5 s 12 f, 5.4 seconds, +10 / -10 frames" className={`tabular-nums hover:underline ${className}`}>
      {format(time)}
    </button>
  );
}
