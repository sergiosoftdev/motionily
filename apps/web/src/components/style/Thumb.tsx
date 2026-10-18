import type { PalettePayload } from "@motionily/protocol";

/** A tiny frame painted with a palette: what a video in these colors roughly looks like. */
export function Thumb({ palette, className = "" }: { palette: PalettePayload; className?: string }) {
  return (
    <span className={`relative block overflow-hidden rounded-md ${className}`} style={{ background: palette.background }}>
      <span className="absolute top-[18%] left-[12%] h-[46%] w-[56%] rounded-[6px]" style={{ background: palette.surface }} />
      <span className="absolute top-[28%] left-[20%] h-[9%] w-[34%] rounded-full" style={{ background: palette.text }} />
      <span className="absolute top-[44%] left-[20%] h-[14%] w-[24%] rounded-[4px]" style={{ background: palette.primary }} />
      <span className="absolute right-[12%] bottom-[14%] aspect-square w-[22%] rounded-full" style={{ background: palette.accent }} />
    </span>
  );
}
