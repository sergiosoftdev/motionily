import { useState } from "react";
import { BrickSlot, SLOT_CARDINALITY, SlotCardinality, type Brick, type Build } from "@motionily/protocol";
import { OptionRow, OptionTile } from "./OptionCard";
import { fitLevel, slotUi, VISUAL_SLOTS } from "./options";
import { GoogleFontSearch } from "./GoogleFontSearch";
import { Thumb } from "./Thumb";
import { api, type BrandPalette } from "../../api/client";

type Props = {
  projectId: string;
  /** A new project-only option was created (e.g. a Google Font); add it to the catalog. */
  onNewBrick: (brick: Brick) => void;
  /** Palettes of the project's brand kit, offered first under Colors. */
  brandPalettes: BrandPalette[];
  slot: BrickSlot;
  build: Build;
  bricks: Brick[];
  byKey: Map<string, Brick>;
  onPick: (value: string | string[] | null, applyStyleDefaults?: boolean) => void;
  onClose: () => void;
};

/** Options for one setting. Recommended ones first; nothing is hidden or blocked. */
export function OptionsSheet({ projectId, onNewBrick, brandPalettes, slot, build, bricks, byKey, onPick, onClose }: Props) {
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
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-white" aria-label="Back">
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
          Also apply its colors, typography and animations
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
      {slot === BrickSlot.Palette && brandPalettes.length > 0 && (
        <div className="flex flex-col gap-2 px-3 pb-4">
          <span className="px-2 text-[11px] font-medium text-neutral-500">From your brand</span>
          <div className="grid grid-cols-2 gap-1">
            {brandPalettes.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={async () => {
                  const { name, ...colors } = p;
                  const brick = await api.createProjectBrick(projectId, {
                    slot: BrickSlot.Palette,
                    id: `brand_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30) || "palette"}`,
                    name,
                    description: "Brand palette",
                    payload: colors,
                  });
                  onNewBrick(brick);
                  onPick(brick.key);
                }}
                className="flex flex-col gap-2 rounded-xl p-2 text-left hover:bg-neutral-900"
              >
                <Thumb palette={p} className="aspect-[4/3] w-full" />
                <span className="px-0.5 text-sm font-medium">{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {slot !== BrickSlot.Typography && (
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
      )}
    </div>
  );
}
