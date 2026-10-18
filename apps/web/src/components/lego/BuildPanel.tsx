import { SLOT_CARDINALITY, SlotCardinality, type Brick, type BrickSlot, type Build } from "@motionily/protocol";
import { BrickCard } from "./BrickCard";
import { SLOTS } from "./slots";

type Props = {
  build: Build;
  byKey: Map<string, Brick>;
  misfits: string[];
  kitName: (key: string) => string;
  onOpenSlot: (slot: BrickSlot) => void;
};

/** The baseplate: one row per slot with the bricks snapped into it. */
export function BuildPanel({ build, byKey, misfits, kitName, onOpenSlot }: Props) {
  return (
    <div className="flex flex-col gap-4">
      {SLOTS.map(({ slot, label }) => {
        const keys = [build[slot]].flat().filter((k): k is string => typeof k === "string");
        const many = SLOT_CARDINALITY[slot] === SlotCardinality.Many;
        return (
          <div key={slot} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-neutral-300">{label}</span>
              <button type="button" onClick={() => onOpenSlot(slot)} className="text-xs text-neutral-500 hover:text-white">
                {keys.length === 0 ? "Añadir" : many ? "Editar" : "Cambiar"}
              </button>
            </div>
            {keys.length === 0 ? (
              <button
                type="button"
                onClick={() => onOpenSlot(slot)}
                className="mt-[5px] rounded-lg border border-dashed border-neutral-800 px-3 py-2.5 text-left text-xs text-neutral-500 hover:border-neutral-600"
              >
                Hueco libre
              </button>
            ) : (
              <div className={many ? "grid grid-cols-2 gap-2" : ""}>
                {keys.map((k) => {
                  const brick = byKey.get(k);
                  if (!brick) return null;
                  return (
                    <BrickCard
                      key={k}
                      brick={brick}
                      compact
                      misfitWith={misfits.includes(k) ? kitName(build.motion_style) : null}
                      onClick={() => onOpenSlot(slot)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
