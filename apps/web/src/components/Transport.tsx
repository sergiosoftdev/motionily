import { engineHost } from "../engine/host";
import { useEditor } from "../store";

export function Transport() {
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.duration);
  const playing = useEditor((s) => s.playing);

  return (
    <div className="flex w-full max-w-md items-center gap-3">
      <button
        type="button"
        onClick={() => (playing ? engineHost.pause() : engineHost.play())}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-neutral-950 hover:bg-neutral-200"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" className="size-3.5 fill-current"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" className="ml-0.5 size-3.5 fill-current"><path d="M4 2.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 4 2.5Z" /></svg>
        )}
      </button>
      <input
        type="range"
        min={0}
        max={duration || 1}
        step={0.001}
        value={time}
        onChange={(e) => {
          engineHost.pause();
          engineHost.seek(Number(e.target.value));
        }}
        className="flex-1 accent-white"
        aria-label="Tiempo"
      />
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-neutral-400">
        {time.toFixed(2)} / {duration.toFixed(1)}s
      </span>
    </div>
  );
}
