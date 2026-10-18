import { BrickSlot, BrickVisibility, EngineSupport, type Brick, type PalettePayload } from "@motionily/protocol";
import { Studs } from "./Studs";
import { slotMeta } from "./slots";

type Props = {
  brick: Brick;
  selected?: boolean;
  /** Name of the motion style this brick does not fit, if any. */
  misfitWith?: string | null;
  onClick?: () => void;
  compact?: boolean;
};

export function BrickCard({ brick, selected, misfitWith, onClick, compact }: Props) {
  const { color } = slotMeta(brick.slot);
  const isPalette = brick.slot === BrickSlot.Palette;
  const colors = isPalette ? Object.values(brick.payload as PalettePayload) : [];

  return (
    <button
      type="button"
      onClick={onClick}
      title={brick.description}
      className={`brick group relative mt-[5px] flex w-full flex-col gap-1.5 rounded-lg text-left transition ${
        compact ? "px-2.5 pt-2 pb-2.5" : "px-3 pt-3 pb-3.5"
      } ${selected ? "brick-selected" : "hover:-translate-y-0.5"} ${misfitWith ? "opacity-45 saturate-50" : ""}`}
      style={{ background: color, boxShadow: `inset 0 -4px 0 rgba(0,0,0,.22), 0 ${selected ? 0 : 2}px 0 rgba(0,0,0,.35)` }}
    >
      <Studs count={compact ? 2 : 4} color={color} />
      <span className={`font-semibold leading-tight text-white ${compact ? "text-xs" : "text-sm"}`}>{brick.name}</span>
      {isPalette && (
        <span className="flex h-4 overflow-hidden rounded ring-1 ring-black/15">
          {colors.map((c, i) => (
            <span key={i} className="flex-1" style={{ background: c }} />
          ))}
        </span>
      )}
      {!compact && !isPalette && <span className="line-clamp-2 text-xs leading-snug text-white/80">{brick.description}</span>}
      <span className="flex flex-wrap gap-1 text-[10px] font-medium text-white/85">
        {!compact && brick.slot !== BrickSlot.MotionStyle && brick.engine === EngineSupport.Planned && (
          <span className="rounded bg-black/20 px-1.5 py-0.5">Pronto en el motor</span>
        )}
        {misfitWith && <span className="rounded bg-black/30 px-1.5 py-0.5">No encaja con {misfitWith}</span>}
        {brick.visibility === BrickVisibility.Private && <span className="rounded bg-black/20 px-1.5 py-0.5">Creada por el agente</span>}
      </span>
      {selected && (
        <span className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-white text-[11px] text-neutral-900">✓</span>
      )}
    </button>
  );
}
