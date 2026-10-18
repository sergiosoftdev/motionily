import { useState } from "react";
import { BrickSlot, SLOT_CARDINALITY, SlotCardinality, type Brick, type Build } from "@motionily/protocol";
import { BrickCard } from "./BrickCard";
import { slotMeta } from "./slots";

type Props = {
  slot: BrickSlot;
  build: Build;
  bricks: Brick[];
  kitName: (key: string) => string;
  onPick: (value: string | string[] | null, applyKitDefaults?: boolean) => void;
  onClose: () => void;
};

/** Drawer with every brick that fits one slot. Bricks that don't fit the box are dimmed, never hidden. */
export function BrickPicker({ slot, build, bricks, kitName, onPick, onClose }: Props) {
  const meta = slotMeta(slot);
  const cardinality = SLOT_CARDINALITY[slot];
  const current = build[slot];
  const [rebox, setRebox] = useState(true);
  const style = build.motion_style;
  const options = bricks.filter((b) => b.slot === slot);

  const isSelected = (key: string) => (Array.isArray(current) ? current.includes(key) : current === key);
  const pick = (key: string) => {
    if (cardinality === SlotCardinality.Many) {
      const list = current as string[];
      onPick(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
    } else if (slot === BrickSlot.MotionStyle) {
      onPick(key, rebox);
    } else {
      onPick(key);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-neutral-950">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="size-2.5 rounded-sm" style={{ background: meta.color }} />
            {meta.label}
          </h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            {cardinality === SlotCardinality.Many ? "Elige todas las que quieras." : meta.hint}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-white">
          Listo
        </button>
      </div>
      {slot === BrickSlot.MotionStyle && (
        <label className="mx-5 mb-2 flex items-center gap-2 text-xs text-neutral-300">
          <input type="checkbox" checked={rebox} onChange={(e) => setRebox(e.target.checked)} className="accent-white" />
          Traer también las piezas de la caja nueva
        </label>
      )}
      <div className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto px-5 pb-6">
        {cardinality === SlotCardinality.Optional && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className={`mt-[5px] rounded-lg border border-dashed px-3 py-3 text-left text-xs ${current === null ? "border-white text-white" : "border-neutral-700 text-neutral-400 hover:border-neutral-500"}`}
          >
            Sin {meta.label.toLowerCase()}
          </button>
        )}
        {options.map((b) => {
          const misfit = slot !== BrickSlot.MotionStyle && b.fits.length > 0 && !b.fits.includes(style);
          return (
            <BrickCard key={b.key} brick={b} compact selected={isSelected(b.key)} misfitWith={misfit ? kitName(style) : null} onClick={() => pick(b.key)} />
          );
        })}
      </div>
    </div>
  );
}
