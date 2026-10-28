import { Platform, PostStatus, type PostCopy, type ScheduledPost } from "../api/client";

export const PLATFORMS: Platform[] = [Platform.Instagram, Platform.TikTok, Platform.YouTube];
export const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube Shorts" };
/** "Instagram, TikTok and YouTube Shorts" */
export const platformList = (ps: Platform[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(ps.map((p) => PLATFORM_LABEL[p]));
/** Instagram and TikTok cap a caption at 2,200 characters, hashtags included (one limit for all). */
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

/** A one-click time for a new post. */
export type QuickSlot = { label: string; at: Date };

/** Times short videos tend to do well, from now: tonight (if there's time), tomorrow at noon and at 6 PM, the weekend morning. */
export function quickSlots(now = new Date()): QuickSlot[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const out: QuickSlot[] = [];
  if (now.getHours() < 18) out.push({ label: "Tonight, 7 PM", at: at(0, 19) });
  out.push({ label: "Tomorrow, 12 PM", at: at(1, 12) }, { label: "Tomorrow, 6 PM", at: at(1, 18) });
  const toSaturday = (6 - now.getDay() + 7) % 7 || 7;
  if (toSaturday > 1) out.push({ label: "Saturday, 11 AM", at: at(toSaturday, 11) });
  return out;
}

/** "in 3 hours", "tomorrow", "in 5 days", "2 days ago". */
export function fromNow(d: Date, now = new Date()): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000);
  if (Math.abs(mins) < 60) return rtf.format(mins, "minute");
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return rtf.format(Math.round((day(d) - day(now)) / 86_400_000), "day");
}

/** Brand color of each platform, for its chip. */
export const PLATFORM_COLOR: Record<Platform, string> = { instagram: "#e1306c", tiktok: "#25f4ee", youtube: "#ff3d3d" };
