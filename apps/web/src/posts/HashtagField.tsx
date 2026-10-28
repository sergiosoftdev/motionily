import { useState } from "react";
import { parseHashtags } from "./posts";

/**
 * Hashtags as chips: type and press Enter, space or comma to add one (pasting a list adds them all),
 * × or Backspace on an empty field to remove. Stored without "#".
 */
export function HashtagField({ value, onChange, disabled }: { value: string[]; onChange: (tags: string[]) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const tags = parseHashtags(raw).filter((t) => !value.some((v) => v.toLowerCase() === t.toLowerCase()));
    if (tags.length) onChange([...value, ...tags]);
    setText("");
  };
  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 rounded-lg bg-neutral-950 px-2 py-1.5 ring-1 ring-white/[0.06] focus-within:ring-white/20 ${disabled ? "opacity-60" : ""}`}
      onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
    >
      {value.map((t) => (
        <span key={t} className="flex items-center gap-1 rounded-md bg-sky-400/10 py-0.5 pr-1 pl-2 text-xs text-sky-300">
          #{t}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(value.filter((v) => v !== t))}
            aria-label={`Remove #${t}`}
            className="rounded px-0.5 text-sky-300/60 hover:text-white"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        disabled={disabled}
        onChange={(e) => (/[\s,]$/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
        onPaste={(e) => {
          e.preventDefault();
          add(text + e.clipboardData.getData("text"));
        }}
        onBlur={() => text && add(text)}
        placeholder={value.length ? "Add a hashtag" : "#hashtags: type one and press Enter"}
        aria-label="Hashtags"
        className="min-w-28 flex-1 bg-transparent py-0.5 text-xs text-sky-300 placeholder:text-neutral-600 focus:outline-none"
      />
    </div>
  );
}
