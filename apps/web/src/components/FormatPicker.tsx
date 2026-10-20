import { VideoFormat } from "@motionily/protocol";

export const FORMAT_OPTIONS: { format: VideoFormat; label: string; hint: string; box: string }[] = [
  { format: VideoFormat.Vertical, label: "9:16", hint: "Reels, TikTok", box: "h-4 w-[9px]" },
  { format: VideoFormat.Portrait, label: "4:5", hint: "Feed", box: "h-4 w-[13px]" },
  { format: VideoFormat.Square, label: "1:1", hint: "Square", box: "size-3.5" },
  { format: VideoFormat.Horizontal, label: "16:9", hint: "YouTube, web", box: "h-[9px] w-4" },
];

/** Segmented control for the video's frame shape. */
export function FormatPicker({ value, onChange }: { value: VideoFormat; onChange: (f: VideoFormat) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1 rounded-lg bg-neutral-900 p-1">
      {FORMAT_OPTIONS.map((o) => (
        <button
          key={o.format}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.format)}
          className={`flex flex-col items-center gap-1 rounded-md px-2 py-1.5 text-xs ${value === o.format ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
        >
          <span className="flex h-4 items-center">
            <span className={`rounded-[2px] border border-current ${o.box}`} />
          </span>
          {o.label}
        </button>
      ))}
    </div>
  );
}
