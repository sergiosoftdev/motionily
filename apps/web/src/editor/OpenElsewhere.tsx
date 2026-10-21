import { useEditor } from "../store";

/** The video was opened in another tab or window: this copy is stale until the user takes it back. */
export function OpenElsewhere() {
  const open = useEditor((s) => s.openElsewhere);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-neutral-900 px-8 py-7 text-center shadow-2xl">
        <h2 className="text-base font-semibold">This video is open in another tab</h2>
        <p className="text-sm text-neutral-400">The agent and your changes go there now. Use it here to pick up the latest version.</p>
        {/* A reload loads the latest saved scene and takes the agent link back from the other tab. */}
        <button type="button" onClick={() => location.reload()} className="rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
          Use here
        </button>
      </div>
    </div>
  );
}
