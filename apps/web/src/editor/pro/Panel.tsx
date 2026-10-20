import type { ReactNode } from "react";

/**
 * An After Effects panel: tabs on top, body below; the panel being used gets AE's blue frame.
 * `tabs` are [key, label]; with one tab there is nothing to switch.
 */
export function Panel<T extends string>({
  tabs,
  active,
  onTab,
  children,
  className = "",
  bodyClass = "",
  aside,
}: {
  tabs: [T, string][];
  active?: T;
  onTab?: (t: T) => void;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  /** Right side of the tab bar. */
  aside?: ReactNode;
}) {
  return (
    <section tabIndex={-1} className={`flex min-h-0 min-w-0 flex-col rounded-[3px] bg-[#232323] outline-none ring-1 ring-transparent focus-within:ring-[#2d8ceb]/70 ${className}`}>
      <header className="flex h-7 shrink-0 items-center gap-1 border-b border-[#151515] px-1.5">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onTab?.(key)}
            className={`truncate rounded-sm px-2 py-0.5 text-[12px] ${(active ?? tabs[0]![0]) === key ? "bg-[#2e2e2e] text-[#e6e6e6]" : "text-[#8a8a8a] hover:text-[#c9c9c9]"}`}
          >
            {label}
          </button>
        ))}
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}
