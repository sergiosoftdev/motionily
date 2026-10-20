import { BrickSlot, BrickVisibility, type Brick } from "@motionily/protocol";
import { Thumb } from "./Thumb";
import { FitLevel, previewPalette } from "./options";

type Props = {
  brick: Brick;
  byKey: Map<string, Brick>;
  selected: boolean;
  fit: FitLevel;
  onClick: () => void;
};

const check = (
  <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

/** Big visual card: styles, palettes and typefaces are chosen by how they look. */
export function OptionTile({ brick, byKey, selected, fit, onClick }: Props) {
  const palette = previewPalette(brick, byKey);
  const family = brick.slot === BrickSlot.Typography ? (brick.payload as { family?: string }).family : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      title={brick.description}
      className={`group flex flex-col gap-2 rounded-xl p-2 text-left transition ${selected ? "bg-neutral-800 ring-2 ring-white" : "hover:bg-neutral-900"}`}
    >
      {palette ? (
        <Thumb palette={palette} className="aspect-[4/3] w-full" />
      ) : (
        <span className="flex aspect-[4/3] w-full items-center justify-center rounded-md bg-neutral-800 text-3xl" style={{ fontFamily: family }}>
          Aa
        </span>
      )}
      <span className="flex items-center justify-between gap-2 px-0.5">
        <span className="truncate text-sm font-medium" style={family ? { fontFamily: family } : undefined}>
          {brick.name}
        </span>
        {selected && <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-white text-neutral-900">{check}</span>}
      </span>
      {fit === FitLevel.Recommended && <span className="px-0.5 text-[11px] text-emerald-400">Recomendado</span>}
    </button>
  );
}

/** Row for options that read better as words (animations, transitions, captions…). */
export function OptionRow({ brick, selected, fit, onClick }: Omit<Props, "byKey">) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition ${selected ? "bg-neutral-800" : "hover:bg-neutral-900"}`}
    >
      <span
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-white bg-white text-neutral-900" : "border-neutral-600"}`}
      >
        {selected && check}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {brick.name}
          {fit === FitLevel.Recommended && <span className="text-[11px] font-normal text-emerald-400">Recomendado</span>}
          {brick.visibility === BrickVisibility.Private && <span className="text-[11px] font-normal text-sky-400">Made by the agent</span>}
        </span>
        <span className="text-xs leading-snug text-neutral-400">{brick.description}</span>
      </span>
    </button>
  );
}
