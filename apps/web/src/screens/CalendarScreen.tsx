import { useEffect, useMemo, useState } from "react";
import { VideoFormat } from "@motionily/protocol";
import { api, mediaUrl, Platform, PostStatus, type ScheduledPost } from "../api/client";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { href, navigate, RouteName } from "../router";
import {
  formatTime,
  formatWhen,
  fromLocalInput,
  hashtagsText,
  parseHashtags,
  PLATFORM_LABEL,
  postState,
  postText,
  STATE_DOT,
  STATE_LABEL,
  toLocalInput,
} from "../posts/posts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Six weeks always fit any month. */
const GRID_DAYS = 42;
/** Where to post by hand on the web. */
const UPLOAD_URL: Record<Platform, string> = { [Platform.Instagram]: "https://www.instagram.com/", [Platform.TikTok]: "https://www.tiktok.com/tiktokstudio/upload" };
/** Formats taller than wide: the preview keeps its height in check. */
const TALL: (string | null)[] = [VideoFormat.Vertical, VideoFormat.Portrait];

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const firstOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

/** The month's grid, from the Sunday before the 1st. */
function gridDays(month: Date) {
  const start = new Date(month);
  start.setDate(1 - start.getDay());
  return Array.from({ length: GRID_DAYS }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** The posting calendar: every scheduled video by day, and the one you open with its file and text ready to post. */
export function CalendarScreen({ postId }: { postId?: string }) {
  const [posts, setPosts] = useState<ScheduledPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(() => firstOfMonth(new Date()));

  const load = () =>
    api
      .posts()
      .then(setPosts)
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const selected = posts?.find((p) => p.id === postId) ?? null;
  // Opened from a reminder or a link: show that post's month.
  useEffect(() => {
    if (selected) setMonth(firstOfMonth(new Date(selected.scheduledAt)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const days = useMemo(() => gridDays(month), [month]);
  const upcoming = (posts ?? []).filter((p) => p.status === PostStatus.Scheduled).slice(0, 6);
  const replace = (p: ScheduledPost) => setPosts((all) => (all ?? []).map((x) => (x.id === p.id ? p : x)));
  const shift = (months: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + months, 1));

  return (
    <MotionilyLayout
      title="Calendar"
      description="Videos scheduled for Instagram and TikTok. When one is due, Motionily reminds you with the file and the text ready to paste."
      actions={
        <>
          <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="rounded-lg px-2.5 py-1.5 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-white">
            ‹
          </button>
          <span className="w-36 text-center text-sm font-semibold">{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
          <button type="button" onClick={() => shift(1)} aria-label="Next month" className="rounded-lg px-2.5 py-1.5 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-white">
            ›
          </button>
          <button type="button" onClick={() => setMonth(firstOfMonth(new Date()))} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-700">
            Today
          </button>
        </>
      }
    >
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-col gap-8 xl:flex-row">
        <div className="grid min-w-0 flex-1 grid-cols-7 gap-1 self-start">
          {WEEKDAYS.map((d) => (
            <span key={d} className="px-2 pb-1 text-xs text-neutral-500">
              {d}
            </span>
          ))}
          {days.map((day) => {
            const inMonth = day.getMonth() === month.getMonth();
            const today = sameDay(day, new Date());
            const onDay = (posts ?? []).filter((p) => sameDay(new Date(p.scheduledAt), day));
            return (
              <div key={day.toISOString()} className={`flex min-h-24 min-w-0 flex-col gap-1 rounded-lg p-1.5 ${inMonth ? "bg-neutral-900/60" : "bg-neutral-900/20"}`}>
                <span className={`self-start rounded-md px-1.5 text-xs tabular-nums ${today ? "bg-white font-semibold text-neutral-900" : inMonth ? "text-neutral-400" : "text-neutral-700"}`}>
                  {day.getDate()}
                </span>
                {onDay.map((p) => (
                  <a
                    key={p.id}
                    href={href({ name: RouteName.Calendar, postId: p.id })}
                    className={`flex min-w-0 flex-col rounded-md px-1.5 py-1 text-[11px] leading-tight ${p.id === postId ? "bg-neutral-700 text-white" : "text-neutral-300 hover:bg-neutral-800"}`}
                  >
                    <span className="flex items-center gap-1.5 tabular-nums text-neutral-500">
                      <span className={`size-1.5 shrink-0 rounded-full ${STATE_DOT[postState(p)]}`} />
                      {formatTime(p.scheduledAt)}
                    </span>
                    <span className="truncate">{p.projectName ?? "Deleted video"}</span>
                  </a>
                ))}
              </div>
            );
          })}
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-6 xl:w-96">
          {selected ? (
            <PostDetail
              key={selected.id}
              post={selected}
              onChange={replace}
              onDelete={() => {
                setPosts((all) => (all ?? []).filter((x) => x.id !== selected.id));
                navigate({ name: RouteName.Calendar });
              }}
            />
          ) : (
            <Upcoming posts={upcoming} loaded={posts !== null} />
          )}
        </aside>
      </div>
    </MotionilyLayout>
  );
}

function Upcoming({ posts, loaded }: { posts: ScheduledPost[]; loaded: boolean }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Coming up</h2>
      {!loaded ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : posts.length ? (
        posts.map((p) => (
          <a key={p.id} href={href({ name: RouteName.Calendar, postId: p.id })} className="flex flex-col gap-0.5 rounded-lg px-3 py-2 hover:bg-neutral-900">
            <span className="truncate text-sm">{p.projectName ?? "Deleted video"}</span>
            <span className="text-xs text-neutral-500">
              {formatWhen(p.scheduledAt)} · {p.platforms.map((x) => PLATFORM_LABEL[x]).join(", ")}
            </span>
          </a>
        ))
      ) : (
        <p className="text-sm text-neutral-500">Nothing scheduled yet. Open a video and press Schedule, next to Export.</p>
      )}
    </section>
  );
}

/** One post: its file, its text per platform (copy and paste), and what to do with it. */
function PostDetail({ post, onChange, onDelete }: { post: ScheduledPost; onChange: (p: ScheduledPost) => void; onDelete: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = postState(post);
  const vertical = TALL.includes(post.format);

  const save = async (patch: Parameters<typeof api.updatePost>[1]) => {
    setError(null);
    try {
      onChange(await api.updatePost(post.id, patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const copyText = async (platform: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(platform);
    setTimeout(() => setCopied((c) => (c === platform ? null : c)), 2000);
  };
  const remove = async () => {
    if (!window.confirm(`Delete the post of "${post.projectName ?? "this video"}"? The rendered file goes too.`)) return;
    await api.deletePost(post.id);
    onDelete();
  };

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-xs text-neutral-400">
          <span className={`size-2 rounded-full ${STATE_DOT[state]}`} />
          {STATE_LABEL[state]}
        </span>
        <a href={href({ name: RouteName.Editor, id: post.projectId })} className="truncate text-lg font-semibold hover:underline">
          {post.projectName ?? "Deleted video"}
        </a>
        <input
          type="datetime-local"
          defaultValue={toLocalInput(new Date(post.scheduledAt))}
          onBlur={(e) => {
            const at = fromLocalInput(e.target.value);
            if (at && at !== post.scheduledAt) void save({ scheduledAt: at });
          }}
          className="self-start rounded-lg bg-neutral-900 px-2.5 py-1 text-sm text-neutral-200 [color-scheme:dark]"
        />
      </div>

      {post.video ? (
        <div className="flex flex-col gap-2">
          <video src={mediaUrl(post.video.url)} controls playsInline className={`rounded-xl bg-black ${vertical ? "max-h-96 self-start" : "w-full"}`} />
          <div className="flex items-center gap-3 text-xs">
            <a href={mediaUrl(post.video.url)} download={`${post.projectName ?? "motionily"}.${post.video.mime.split("/")[1]}`} className="font-semibold text-white hover:underline">
              Download video
            </a>
            <span className="text-neutral-500">{(post.video.size / 1e6).toFixed(1)} MB</span>
          </div>
          {post.video.outdated && (
            <p className="text-xs text-amber-200/90">
              You edited the video after this file was rendered.{" "}
              <a href={href({ name: RouteName.Editor, id: post.projectId })} className="underline">
                Open it
              </a>{" "}
              and press Schedule to render the new version.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-neutral-500">No file yet: open the video and press Schedule to render it.</p>
      )}

      {post.copy.map((c, i) => (
        <div key={c.platform} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">{PLATFORM_LABEL[c.platform]}</h3>
            <div className="flex gap-3 text-xs">
              <a href={UPLOAD_URL[c.platform]} target="_blank" rel="noreferrer" className="text-neutral-400 hover:text-white">
                Open {PLATFORM_LABEL[c.platform]}
              </a>
              <button type="button" onClick={() => void copyText(c.platform, postText(c))} className="font-semibold text-white hover:underline">
                {copied === c.platform ? "Copied" : "Copy text"}
              </button>
            </div>
          </div>
          <textarea
            defaultValue={c.caption}
            rows={4}
            onBlur={(e) => e.target.value !== c.caption && void save({ copy: post.copy.map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)) })}
            className="resize-y rounded-lg bg-neutral-900 px-3 py-2 text-sm leading-relaxed text-neutral-100"
          />
          <input
            defaultValue={hashtagsText(c.hashtags)}
            onBlur={(e) => {
              const hashtags = parseHashtags(e.target.value);
              if (hashtags.join(" ") !== c.hashtags.join(" ")) void save({ copy: post.copy.map((x, j) => (j === i ? { ...x, hashtags } : x)) });
            }}
            placeholder="#hashtags"
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-sky-300 placeholder:text-neutral-600"
          />
        </div>
      ))}

      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        {post.status === PostStatus.Posted ? (
          <button type="button" onClick={() => void save({ status: PostStatus.Scheduled })} className="rounded-lg bg-neutral-800 px-3 py-2 text-xs font-semibold hover:bg-neutral-700">
            Not posted yet
          </button>
        ) : (
          <button type="button" onClick={() => void save({ status: PostStatus.Posted })} className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-neutral-900 hover:bg-neutral-200">
            Mark as posted
          </button>
        )}
        <button type="button" onClick={() => void remove()} className="ml-auto text-xs text-neutral-500 hover:text-red-400">
          Delete
        </button>
      </div>
    </section>
  );
}
