import { useState, type ReactNode } from "react";
import { ScrubNumber } from "../ScrubNumber";

/** Palette slots: a color written by name follows the palette. */
export const SLOTS = ["background", "surface", "primary", "accent", "text", "on_background", "on_surface", "on_primary", "on_accent"];
const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Longer strings get a text area (formulas, shader code, paths). */
const LONG_TEXT = 40;

export type Change = (value: unknown, done: boolean) => void;

export const selectClass = "rounded-sm bg-[#1b1b1b] px-1 py-0.5 text-[#c9c9c9] focus:outline-none";

/** AE's twirl-down group. */
export function Twirl({ title, children, aside, defaultOpen = true }: { title: ReactNode; children: ReactNode; aside?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col">
      <div className="flex items-center hover:bg-[#2a2a2a]">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left font-medium text-[#e6e6e6]">
          <span className="w-2.5 text-[9px] text-[#8a8a8a]">{open ? "▼" : "▶"}</span>
          {title}
        </button>
        {aside && <span className="flex shrink-0 items-center gap-1 pr-2">{aside}</span>}
      </div>
      {open && <div className="flex flex-col pb-1">{children}</div>}
    </div>
  );
}

export function Line({ label, children, depth = 0 }: { label: ReactNode; children: ReactNode; depth?: number }) {
  return (
    <div className="flex min-h-6 items-center gap-2 pr-3" style={{ paddingLeft: 22 + depth * 12 }}>
      <span className="min-w-0 flex-1 truncate text-[#c9c9c9]">{label}</span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </div>
  );
}

/** `[r, g, b, a]` 0..1 (a raw engine color) as `#rrggbb[aa]`. */
export function rgbaHex(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 3 || !v.every((n) => typeof n === "number")) return null;
  const h = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
  const [r, g, b, a = 1] = v as number[];
  return `#${h(r!)}${h(g!)}${h(b!)}${a < 1 ? h(a) : ""}`;
}

const isKeyList = (v: unknown): v is { t: number }[] => Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && "t" in v[0];
export const isColor = (v: unknown): v is string => typeof v === "string" && (HEX.test(v) || SLOTS.includes(v));

/** Any value of a layer, edited by its shape: number, color, text, flag, list or object. */
export function Field({ name, value, onChange, depth = 0 }: { name: string; value: unknown; onChange: Change; depth?: number }) {
  const [open, setOpen] = useState(false);
  if (typeof value === "number")
    return (
      <Line label={name} depth={depth}>
        <ScrubNumber value={value} step={Math.abs(value) >= 10 ? 1 : 0.01} decimals={Number.isInteger(value) && Math.abs(value) >= 10 ? 0 : 2} onChange={onChange} />
      </Line>
    );
  if (typeof value === "boolean")
    return (
      <Line label={name} depth={depth}>
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked, true)} className="accent-[#2d8ceb]" />
      </Line>
    );
  if (isColor(value) || rgbaHex(value)) return <ColorField name={name} value={isColor(value) ? value : rgbaHex(value)!} onChange={onChange} depth={depth} />;
  if (typeof value === "string")
    return value.length > LONG_TEXT ? (
      <div className="flex flex-col gap-1 py-1 pr-3" style={{ paddingLeft: 22 + depth * 12 }}>
        <span>{name}</span>
        <textarea
          key={value}
          defaultValue={value}
          rows={3}
          spellCheck={false}
          onBlur={(e) => e.target.value !== value && onChange(e.target.value, true)}
          className="resize-y rounded-sm bg-[#1b1b1b] px-1.5 py-1 font-mono text-[11px] text-[#e6e6e6] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
        />
      </div>
    ) : (
      <Line label={name} depth={depth}>
        <input
          key={value}
          defaultValue={value}
          onBlur={(e) => e.target.value !== value && onChange(e.target.value, true)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-32 rounded-sm bg-[#1b1b1b] px-1.5 py-0.5 text-right text-[#4aa3f0] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none"
        />
      </Line>
    );
  if (isKeyList(value))
    return (
      <Line label={name} depth={depth}>
        <span className="text-[#8a8a8a]" title="Animated: edit it with keyframes or ask the agent">
          ◆ {value.length} keyframes
        </span>
      </Line>
    );
  if (value === null || value === undefined)
    return (
      <Line label={name} depth={depth}>
        <span className="text-[#8a8a8a]">—</span>
      </Line>
    );
  // Lists and objects twirl open; a change inside sends the whole value back up.
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value as Record<string, unknown>);
  const childChange =
    (i: number, key: string): Change =>
    (v, done) => {
      if (Array.isArray(value)) onChange(value.map((x, j) => (j === i ? v : x)), done);
      else onChange({ ...(value as Record<string, unknown>), [key]: v }, done);
    };
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex h-6 items-center gap-1.5 pr-3 text-left hover:bg-[#2a2a2a]" style={{ paddingLeft: 10 + depth * 12 }}>
        <span className="w-2.5 text-[9px] text-[#8a8a8a]">{open ? "▼" : "▶"}</span>
        <span className="flex-1 truncate">{name}</span>
        <span className="text-[#8a8a8a]">{Array.isArray(value) ? `${value.length}` : ""}</span>
      </button>
      {open && entries.map(([k, v], i) => <Field key={k} name={k} value={v} depth={depth + 1} onChange={childChange(i, k)} />)}
    </div>
  );
}

/** A color: a palette slot (follows the palette) or a hex value; alpha is kept when picking. `auto` = may be left out. */
export function ColorField({ name, value, onChange, depth = 0, auto }: { name: ReactNode; value: string | undefined; onChange: Change; depth?: number; auto?: string }) {
  const slot = value !== undefined && SLOTS.includes(value);
  const hex = value === undefined || slot ? "#808080" : value.slice(0, 7);
  const alpha = value && !slot ? value.slice(7) : "";
  return (
    <Line label={name} depth={depth}>
      <select
        value={value === undefined ? "" : slot ? value : "custom"}
        onChange={(e) => e.target.value !== "custom" && onChange(e.target.value || null, true)}
        className={selectClass}
      >
        {auto && <option value="">{auto}</option>}
        {SLOTS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value="custom">custom</option>
      </select>
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value + alpha, false)}
        onBlur={(e) => e.target.value !== hex && onChange(e.target.value + alpha, true)}
        className="h-5 w-7 cursor-pointer rounded-sm bg-transparent"
        title={slot || value === undefined ? "Pick a color instead of the palette's" : value}
      />
    </Line>
  );
}
