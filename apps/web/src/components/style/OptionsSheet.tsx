import { useState } from "react";
import { BrickSlot, SLOT_CARDINALITY, SlotCardinality, type Brick, type Build } from "@motionily/protocol";
import { OptionRow, OptionTile } from "./OptionCard";
import { fitLevel, slotUi, VISUAL_SLOTS } from "./options";
import { GoogleFontSearch } from "./GoogleFontSearch";

type Props = {
  projectId: string;
  /** A new project-only option was created (e.g. a Google Font); add it to the catalog. */
  onNewBrick: (brick: Brick) => void;
  slot: BrickSlot;
  build: Build;
  bricks: Brick[];
  byKey: Map<string, Brick>;
  onPick: (value: string | string[] | null, applyStyleDefaults?: boolean) => void;
  onClose: () => void;
};

/** Options for one setting. Recommended ones first; nothing is hidden or blocked. */
export function OptionsSheet({ projectId, onNewBrick, slot, build, bricks, byKey, onPick, onClose }: Props) {
  const ui = slotUi(slot);
  const cardinality = SLOT_CARDINALITY[slot];
  const current = build[slot];
  const [applyDefaults, setApplyDefaults] = useState(true);
  const options = bricks
    .filter((b) => b.slot === slot)
    .map((b) => ({ b, fit: fitLevel(b, build.motion_style) }))
    .sort((x, y) => x.fit - y.fit);

  const isSelected = (key: string) => (Array.isArray(current) ? current.includes(key) : current === key);
  const pick = (key: string) => {
    if (cardinality === SlotCardinality.Many) {
      const list = current as string[];
      onPick(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
    } else {
      onPick(key, slot === BrickSlot.MotionStyle ? applyDefaults : undefined);
    }
  };
  const visual = VISUAL_SLOTS.includes(slot);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-neutral-950">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-white" aria-label="Volver">
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <h2 className="text-sm font-semibold">{ui.label}</h2>
      </div>
      <p className="px-5 pb-3 text-xs text-neutral-500">{ui.sheetHint}</p>
      {slot === BrickSlot.MotionStyle && (
        <label className="mx-5 mb-3 flex items-center gap-2 text-xs text-neutral-300">
          <input type="checkbox" checked={applyDefaults} onChange={(e) => setApplyDefaults(e.target.checked)} className="accent-white" />
          Aplicar también sus colores, tipografía y animaciones
        </label>
      )}
      {slot === BrickSlot.Typography && (
        <GoogleFontSearch
          projectId={projectId}
          current={(byKey.get(build.typography)?.payload as { family?: string } | undefined)?.family ?? ""}
          onChosen={(b) => {
            onNewBrick(b);
            onPick(b.key);
          }}
        />
      )}
      <div className={`flex-1 overflow-y-auto px-3 pb-6 ${visual ? "grid auto-rows-min grid-cols-2 gap-1" : "flex flex-col gap-0.5"}`}>
        {cardinality === SlotCardinality.Optional && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className={`rounded-lg px-3 py-2.5 text-left text-sm ${current === null ? "bg-neutral-800" : "text-neutral-400 hover:bg-neutral-900"}`}
          >
            Ninguno
          </button>
        )}
        {options.map(({ b, fit }) =>
          visual ? (
            <OptionTile key={b.key} brick={b} byKey={byKey} fit={fit} selected={isSelected(b.key)} onClick={() => pick(b.key)} />
          ) : (
            <OptionRow key={b.key} brick={b} fit={fit} selected={isSelected(b.key)} onClick={() => pick(b.key)} />
          ),
        )}
      </div>
    </div>
  );
}
