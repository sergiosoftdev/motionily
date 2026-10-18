import { BrickSlot, type Brick, type Build, type PalettePayload } from "@motionily/protocol";
import { GROUP_LABEL, SLOT_UI, SlotGroup } from "./options";
import { SlotIcon } from "./SlotIcon";

type Props = {
  build: Build;
  byKey: Map<string, Brick>;
  onOpen: (slot: BrickSlot) => void;
};

/** Property panel: every setting of the video in one glance, grouped like a design tool. */
export function StylePanel({ build, byKey, onOpen }: Props) {
  return (
    <div className="flex flex-col gap-5">
      {Object.values(SlotGroup).map((group) => (
        <section key={group} className="flex flex-col">
          <h3 className="px-2 pb-1 text-[11px] font-medium text-neutral-500">{GROUP_LABEL[group]}</h3>
          {SLOT_UI.filter((s) => s.group === group).map(({ slot, label, icon }) => {
            const keys = [build[slot]].flat().filter((k): k is string => typeof k === "string");
            const names = keys.map((k) => byKey.get(k)?.name ?? k);
            const value = names.length === 0 ? "Ninguno" : names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
            const palette = slot === BrickSlot.Palette ? (byKey.get(keys[0] ?? "")?.payload as PalettePayload | undefined) : undefined;
            return (
              <button
                key={slot}
                type="button"
                onClick={() => onOpen(slot)}
                className="group flex items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-neutral-900"
              >
                <SlotIcon path={icon} className="size-4 shrink-0 text-neutral-500" />
                <span className="w-24 shrink-0 text-xs text-neutral-400">{label}</span>
                <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  {palette && (
                    <span className="flex shrink-0 overflow-hidden rounded ring-1 ring-white/10">
                      {Object.values(palette).map((c, i) => (
                        <span key={i} className="size-3" style={{ background: c }} />
                      ))}
                    </span>
                  )}
                  <span className={`truncate ${names.length === 0 ? "text-neutral-500" : ""}`}>{value}</span>
                </span>
                <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-neutral-600 group-hover:text-neutral-300" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <path d="m6 3 5 5-5 5" />
                </svg>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
