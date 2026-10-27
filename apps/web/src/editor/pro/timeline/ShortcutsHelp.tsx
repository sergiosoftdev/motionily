import { useEffect } from "react";
import { COMMANDS, commandLabel, KeyScope } from "../../../keys/keymap";
import { href, RouteName } from "../../../router";

/** Pro's keys and playback's, grouped by section. */
const SECTIONS = [...new Set(COMMANDS.filter((c) => c.scope === KeyScope.Pro || c.scope === KeyScope.Transport).map((c) => c.section))];

/** The "Keyboard shortcuts" popover: the keymap the timeline binds (preset and the user's own keys), grouped by section. */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("pointerdown", close), window.removeEventListener("keydown", esc));
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute top-9 right-2 z-[60] max-h-[70vh] w-[560px] overflow-y-auto rounded-[3px] bg-[#2b2b2b] p-3 text-[12px] text-[#d6d6d6] shadow-xl ring-1 ring-black/60"
    >
      <p className="flex items-baseline justify-between pb-2 text-[13px] text-[#e6e6e6]">
        Keyboard shortcuts
        <a href={href({ name: RouteName.Settings })} className="text-[11px] text-[#4aa3f0] hover:underline">
          Change them in Settings
        </a>
      </p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {SECTIONS.map((section) => (
          <div key={section}>
            <p className="pb-1 text-[10px] text-[#8a8a8a]">{section}</p>
            {COMMANDS.filter((c) => c.section === section && (c.scope === KeyScope.Pro || c.scope === KeyScope.Transport)).map((c) => (
              <p key={c.id} className="flex gap-2 py-[2px]">
                <kbd className="w-28 shrink-0 font-sans text-[#4aa3f0]">{commandLabel(c.id)}</kbd>
                <span className="min-w-0">{c.help}</span>
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
