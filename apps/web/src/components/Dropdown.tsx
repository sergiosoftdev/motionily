import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** Lists longer than this get a search box. */
const SEARCH_FROM = 8;
/** Tallest the list gets (px); it opens upwards when there is no room below. */
const LIST_MAX = 320;
const GAP = 6;

export type DropdownOption<T extends string> = {
  value: T;
  label: string;
  /** A second line under the label (a count, a hint). */
  hint?: string;
  /** Drawn before the label: a swatch, an icon, a thumbnail. */
  lead?: ReactNode;
};

/**
 * The app's select: a button showing the choice, and a list under it (searchable when long) driven by
 * the mouse or the keys (arrows, Enter, Escape, typing to search). Replaces the browser's native select,
 * which can't show swatches or hints and looks different on every system.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = "Choose…",
  disabled,
  size = "md",
  align = "left",
  className = "",
}: {
  value: T | null;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  /** Accessible name (and the label above the list). */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const id = useId();
  const current = options.find((o) => o.value === value) ?? null;
  const searchable = options.length >= SEARCH_FROM;
  const shown = query
    ? options.filter((o) =>
        `${o.label} ${o.hint ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : options;

  useEffect(() => {
    if (!open) return;
    const outside = (t: EventTarget | null) =>
      !root.current?.contains(t as Node) && !popup.current?.contains(t as Node);
    const close = (e: Event) => outside(e.target) && setOpen(false);
    // The list is fixed on screen: scrolling what holds the button closes it instead of leaving it behind.
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Drawn in a layer of its own (panels that scroll would clip it), under the button or above it.
  useLayoutEffect(() => {
    if (!open || !root.current) return setPlace(null);
    const r = root.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP;
    const up = below < Math.min(LIST_MAX, 200) && r.top > below;
    const side: CSSProperties =
      align === "right"
        ? { right: window.innerWidth - r.right }
        : { left: r.left };
    setPlace({
      ...side,
      minWidth: r.width,
      ...(up
        ? {
            bottom: window.innerHeight - r.top + GAP,
            maxHeight: Math.min(LIST_MAX, r.top - GAP * 2),
          }
        : { top: r.bottom + GAP, maxHeight: Math.min(LIST_MAX, below - GAP) }),
    });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (o: DropdownOption<T>) => {
    onChange(o.value);
    setOpen(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o);
    } else if (e.key === "Tab") setOpen(false);
  };

  const pad = size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm";
  return (
    <div ref={root} className={`relative ${className}`} onKeyDown={onKey}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-2.5 rounded-lg bg-neutral-800/80 text-left ring-1 ring-white/[0.06] transition hover:bg-neutral-800 hover:ring-white/15 focus-visible:ring-white/40 focus-visible:outline-none disabled:opacity-50 ${pad} ${open ? "ring-white/25" : ""}`}
      >
        {current?.lead}
        <span
          className={`min-w-0 flex-1 truncate ${current ? "text-neutral-100" : "text-neutral-500"}`}
        >
          {current?.label ?? placeholder}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={`size-3.5 shrink-0 text-neutral-500 transition ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden
        >
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={popup}
            style={place}
            className="fixed z-[100] flex w-max max-w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-neutral-900 p-1 shadow-2xl ring-1 shadow-black/60 ring-white/10"
          >
            {searchable && (
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder="Search…"
                aria-label={`Search ${label.toLowerCase()}`}
                className="mb-1 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm placeholder:text-neutral-500 focus:outline-none"
              />
            )}
            <ul
              ref={list}
              id={id}
              role="listbox"
              aria-label={label}
              className="min-h-0 overflow-y-auto"
            >
              {shown.map((o, i) => {
                const selected = o.value === value;
                return (
                  <li
                    key={o.value}
                    role="option"
                    aria-selected={selected}
                    data-index={i}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${i === active ? "bg-white/[0.07]" : ""}`}
                  >
                    {o.lead}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={`truncate ${selected ? "font-medium text-white" : "text-neutral-200"}`}
                      >
                        {o.label}
                      </span>
                      {o.hint && (
                        <span className="truncate text-xs text-neutral-500">
                          {o.hint}
                        </span>
                      )}
                    </span>
                    {selected && (
                      <svg
                        viewBox="0 0 16 16"
                        className="size-3.5 shrink-0 text-white"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden
                      >
                        <path
                          d="m3.5 8.5 3 3 6-7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </li>
                );
              })}
              {!shown.length && (
                <li className="px-2.5 py-2 text-sm text-neutral-500">
                  Nothing matches
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** A project's palette as overlapping dots, for a Dropdown's `lead`. */
export function PaletteDots({ colors }: { colors: string[] }) {
  if (!colors.length)
    return <span className="size-4 shrink-0 rounded-full bg-neutral-700" />;
  return (
    <span className="flex shrink-0 -space-x-1.5">
      {colors.slice(0, 3).map((c, i) => (
        <span
          key={i}
          className="size-4 rounded-full ring-2 ring-neutral-900"
          style={{ background: c }}
        />
      ))}
    </span>
  );
}
