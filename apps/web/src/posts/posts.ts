import { Platform, PostStatus, type PostCopy, type ScheduledPost } from "../api/client";

export const PLATFORMS: Platform[] = [Platform.Instagram, Platform.TikTok];
export const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok" };
/** Both platforms cap a caption at 2,200 characters (hashtags included). */
export const MAX_CAPTION = 2200;

/** What gets pasted on the platform: the caption, a blank line, then the hashtags. */
export const postText = (c: PostCopy) => [c.caption.trim(), c.hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n");

/** "#history #WW2, spies" → ["history", "WW2", "spies"] */
export const parseHashtags = (s: string) => [...new Set(s.split(/[\s,]+/).map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean))];
export const hashtagsText = (tags: string[]) => tags.map((t) => `#${t}`).join(" ");

/** "Tue, Oct 22, 6:00 PM" in the viewer's time zone. */
export const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const pad = (n: number) => String(n).padStart(2, "0");
/** Value for <input type="datetime-local">, in local time. */
export const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** <input type="datetime-local"> value (local time) → ISO, or null when empty or invalid. */
export const fromLocalInput = (v: string) => {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** Default slot for a new post: tomorrow at 6 PM, when short videos tend to do well. */
export function defaultSlot() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(18, 0, 0, 0);
  return d;
}

/** Where the post stands, for a label. */
export const PostState = { Scheduled: "scheduled", Due: "due", Posted: "posted" } as const;
export type PostState = (typeof PostState)[keyof typeof PostState];
export const postState = (p: ScheduledPost): PostState => (p.status === PostStatus.Posted ? PostState.Posted : p.due ? PostState.Due : PostState.Scheduled);
export const STATE_LABEL: Record<PostState, string> = { scheduled: "Scheduled", due: "Time to post", posted: "Posted" };
export const STATE_DOT: Record<PostState, string> = { scheduled: "bg-sky-400", due: "bg-amber-400", posted: "bg-emerald-400" };
