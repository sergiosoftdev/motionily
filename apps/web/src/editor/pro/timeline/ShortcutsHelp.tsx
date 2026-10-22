import { useEffect } from "react";
import { SHORTCUTS, ShortcutSection } from "../shortcuts";

/** The "Keyboard shortcuts" popover: the same table the timeline binds, grouped by section. */
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
      <p className="pb-2 text-[13px] text-[#e6e6e6]">Keyboard shortcuts</p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {Object.values(ShortcutSection).map((section) => (
          <div key={section}>
            <p className="pb-1 text-[10px] text-[#8a8a8a]">{section}</p>
            {SHORTCUTS.filter((s) => s.section === section).map((s) => (
              <p key={s.action} className="flex gap-2 py-[2px]">
                <kbd className="w-24 shrink-0 font-sans text-[#4aa3f0]">{s.label}</kbd>
                <span className="min-w-0">{s.help}</span>
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
