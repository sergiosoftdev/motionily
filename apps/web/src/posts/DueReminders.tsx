import { useEffect, useRef, useState } from "react";
import { api, type ScheduledPost } from "../api/client";
import { href, navigate, RouteName, useRoute } from "../router";
import { platformList } from "./posts";

const POLL_MS = 60_000;
/** Posts already announced with a browser notification (once each). */
const NOTIFIED_KEY = "motionily.notifiedPosts";
/** Posts whose reminder the user closed. */
const DISMISSED_KEY = "motionily.dismissedPosts";
/** Ids kept in each list; older ones are long posted. */
const KEEP_IDS = 200;
const SHOWN = 3;

function loadIds(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function saveIds(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids.slice(-KEEP_IDS)));
  } catch {
    // Storage blocked: reminders may repeat after a reload.
  }
}

const where = (p: ScheduledPost) => platformList(p.platforms);

/**
 * Posts whose time has come: a browser notification once (when allowed) and a reminder in the
 * corner until the user opens it, closes it or marks the post as posted. Checked every minute.
 */
export function DueReminders() {
  const route = useRoute();
  const [due, setDue] = useState<ScheduledPost[]>([]);
  const [dismissed, setDismissed] = useState(() => loadIds(DISMISSED_KEY));

  const check = useRef<() => Promise<void>>(async () => undefined);
  check.current = async () => {
    const list = await api.posts({ due: true }).catch(() => null);
    if (!list) return;
    setDue(list);
    const notified = loadIds(NOTIFIED_KEY);
    const fresh = list.filter((p) => !notified.includes(p.id));
    if (!fresh.length) return;
    saveIds(NOTIFIED_KEY, [...notified, ...fresh.map((p) => p.id)]);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const p of fresh) {
      const n = new Notification(`Time to post "${p.projectName ?? "your video"}"`, { body: `On ${where(p)}. The video and the text are ready in Motionily.`, tag: p.id });
      n.onclick = () => {
        window.focus();
        navigate({ name: RouteName.Calendar, postId: p.id });
      };
    }
  };
  useEffect(() => {
    const timer = setInterval(() => void check.current(), POLL_MS);
    return () => clearInterval(timer);
  }, []);
  // Also on every page change: a post scheduled for "now" shows up as soon as you leave the editor.
  useEffect(() => void check.current(), [route.name]);

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    saveIds(DISMISSED_KEY, next);
  };
  // The open post needs no reminder; the editor is left alone (its corners hold tools).
  const shown = due.filter((p) => !dismissed.includes(p.id) && !(route.name === RouteName.Calendar && route.postId === p.id));
  if (route.name === RouteName.Editor || !shown.length) return null;

  return (
    <div className="fixed right-4 bottom-4 z-40 flex w-80 flex-col gap-2">
      {shown.slice(0, SHOWN).map((p) => (
        <div key={p.id} className="flex items-start gap-3 rounded-xl bg-neutral-800 px-4 py-3 shadow-2xl shadow-black/50">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-400" />
          <a href={href({ name: RouteName.Calendar, postId: p.id })} className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Time to post</span>
            <span className="block truncate text-xs text-neutral-300">
              {p.projectName ?? "Your video"} on {where(p)}
            </span>
          </a>
          <button type="button" onClick={() => dismiss(p.id)} aria-label="Dismiss" className="text-neutral-500 hover:text-white">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
