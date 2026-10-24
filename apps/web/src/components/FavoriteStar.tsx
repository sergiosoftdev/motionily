import { useState } from "react";
import { api } from "../api/client";
import { useAgentName } from "../agentName";

/** Lucide "star" (ISC), drawn inline. */
const STAR = "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z";

/**
 * Star a video as a favorite: agents study favorites as the user's taste when they make the next videos.
 * Optimistic; a failed save puts the star back.
 */
export function FavoriteStar({ projectId, initial, className = "", revealOnHover = false }: { projectId: string; initial: boolean; className?: string; revealOnHover?: boolean }) {
  const agent = useAgentName();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      await api.setFavorite(projectId, next);
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void toggle();
      }}
      disabled={busy}
      aria-pressed={on}
      aria-label={on ? "Remove from favorites" : "Add to favorites"}
      title={on ? `Favorite: ${agent} learns your taste from it` : `Add to favorites: ${agent} learns your taste from it`}
      className={`shrink-0 rounded-md p-1 transition-colors ${on ? "text-amber-300" : "text-neutral-500 hover:text-white"} ${!on && revealOnHover ? "opacity-0 group-hover:opacity-100 focus:opacity-100" : ""} ${className}`}
    >
      <svg viewBox="0 0 24 24" className="size-4" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={STAR} />
      </svg>
    </button>
  );
}
