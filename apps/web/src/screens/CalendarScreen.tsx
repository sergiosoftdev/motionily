import { useEffect, useMemo, useState } from "react";
import { VideoFormat } from "@motionily/protocol";
import { api, mediaUrl, Platform, PostStatus, type PostCopy, type ScheduledPost } from "../api/client";
import { HashtagField } from "../posts/HashtagField";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { PostNumbers } from "../social/PostNumbers";
import { href, navigate, RouteName } from "../router";
import { formatTime, formatWhen, fromLocalInput, fromNow, PLATFORM_COLOR, PLATFORM_LABEL, postState, postText, STATE_DOT, STATE_LABEL } from "../posts/posts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Six weeks always fit any month. */
const GRID_DAYS = 42;
/** Where to post by hand on the web. */
const UPLOAD_URL: Record<Platform, string> = {
  [Platform.Instagram]: "https://www.instagram.com/",
  [Platform.TikTok]: "https://www.tiktok.com/tiktokstudio/upload",
  [Platform.YouTube]: "https://www.youtube.com/upload",
};
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
      description="Your scheduled posts. When one is due, Motionily reminds you; open it to download the video, copy the text and mark it posted."
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
                    <span className="truncate">
                      {p.projectName ?? "Deleted video"}
                      {p.variant ? ` · hook ${p.variant}` : ""}
                    </span>
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
            <span className="truncate text-sm">
              {p.projectName ?? "Deleted video"}
              {p.variant && <span className="ml-1.5 rounded bg-violet-400/15 px-1.5 py-0.5 text-[10px] text-violet-200">Hook {p.variant}</span>}
            </span>
            <span className="text-xs text-neutral-500">
              {formatWhen(p.scheduledAt)} · {p.platforms.map((x) => PLATFORM_LABEL[x]).join(", ")}
            </span>
          </a>
        ))
      ) : (
        <p className="text-sm text-neutral-500">Nothing scheduled yet. Open a video and press Schedule (top right, next to Export).</p>
      )}
    </section>
  );
}

/** A numbered step of posting by hand. */
function PostStep({ n, done, title, children }: { n: number; done?: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-emerald-400/15 text-emerald-300" : "bg-white/[0.08] text-neutral-300"}`}>
        {done ? "✓" : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-sm font-medium">{title}</span>
        {children}
      </div>
    </li>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * One post as a short checklist: get the video, copy each platform's text (edited right here), post it
 * and mark it posted. Once posted, its numbers per platform.
 */
function PostDetail({ post, onChange, onDelete }: { post: ScheduledPost; onChange: (p: ScheduledPost) => void; onDelete: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Platform>(post.platforms[0] ?? Platform.Instagram);
  const state = postState(post);
  const vertical = TALL.includes(post.format);
  const posted = post.status === PostStatus.Posted;
  const when = new Date(post.scheduledAt);
  const copyOf = (p: Platform) => post.copy.find((c) => c.platform === p) ?? { platform: p, caption: "", hashtags: [] };
  const active = post.platforms.includes(tab) ? tab : (post.platforms[0] ?? Platform.Instagram);

  const save = async (patch: Parameters<typeof api.updatePost>[1]) => {
    setError(null);
    try {
      onChange(await api.updatePost(post.id, patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const saveCopy = (p: Platform, patch: Partial<PostCopy>) => void save({ copy: post.platforms.map((x) => (x === p ? { ...copyOf(x), ...patch } : copyOf(x))) });
  const saveWhen = (date: string, time: string) => {
    const at = fromLocalInput(`${date}T${time}`);
    if (at && at !== post.scheduledAt) void save({ scheduledAt: at });
  };
  const copyText = async (platform: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(platform);
    setTimeout(() => setCopied((c) => (c === platform ? null : c)), 2000);
  };
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const r = await api.syncPost(post.id);
      onChange(r.post);
      if (r.errors.length) setError(r.errors.join(" · "));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the post of "${post.projectName ?? "this video"}"? The rendered file goes too.`)) return;
    await api.deletePost(post.id);
    onDelete();
  };
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const field = "rounded-lg bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-200 ring-1 ring-white/[0.06] [color-scheme:dark] focus:ring-white/25 focus:outline-none";

  return (
    <section className="flex flex-col gap-5 rounded-2xl bg-neutral-900/50 p-5 ring-1 ring-white/[0.06]">
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-2 text-xs text-neutral-400">
          <span className={`size-2 rounded-full ${STATE_DOT[state]}`} />
          {STATE_LABEL[state]}
          {!posted && <span className="text-neutral-600">· {fromNow(when)}</span>}
        </span>
        <a href={href({ name: RouteName.Editor, id: post.projectId })} className="truncate text-lg font-semibold hover:underline">
          {post.projectName ?? "Deleted video"}
          {post.variant && <span className="ml-2 rounded bg-violet-400/15 px-1.5 py-0.5 align-middle text-xs font-normal text-violet-200">Hook {post.variant}</span>}
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <input key={`d${post.scheduledAt}`} type="date" defaultValue={date} onBlur={(e) => saveWhen(e.target.value, time)} aria-label="Date" className={field} />
          <input key={`t${post.scheduledAt}`} type="time" defaultValue={time} onBlur={(e) => saveWhen(date, e.target.value)} aria-label="Time" className={field} />
          <span className="flex gap-1">
            {post.platforms.map((p) => (
              <span key={p} className="flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-neutral-300">
                <span className="size-1.5 rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
                {PLATFORM_LABEL[p]}
              </span>
            ))}
          </span>
        </div>
      </div>

      <ol className="flex flex-col gap-5">
        <PostStep n={1} done={!!post.video && !post.video.outdated} title="Get the video">
          {post.video ? (
            <>
              <video src={mediaUrl(post.video.url)} controls playsInline className={`rounded-xl bg-black ${vertical ? "max-h-80 self-start" : "w-full"}`} />
              <div className="flex items-center gap-3 text-xs">
                <a
                  href={mediaUrl(post.video.url)}
                  download={`${post.projectName ?? "motionily"}${post.variant ? ` hook ${post.variant}` : ""}.${post.video.mime.split("/")[1]}`}
                  className="rounded-lg bg-white px-3 py-1.5 font-semibold text-neutral-900 hover:bg-neutral-200"
                >
                  Download
                </a>
                <span className="text-neutral-500">{(post.video.size / 1e6).toFixed(1)} MB</span>
              </div>
              {post.video.outdated && (
                <p className="text-xs text-amber-200/90">
                  You edited the video after this file was made.{" "}
                  <a href={href({ name: RouteName.Editor, id: post.projectId })} className="underline">
                    Open it
                  </a>
                  , press Schedule and turn on “Render it again”.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-neutral-400">
              Not rendered yet.{" "}
              <a href={href({ name: RouteName.Editor, id: post.projectId })} className="text-white underline">
                Open the video
              </a>
              , press Schedule and turn on “Render the video now”, or use Export.
            </p>
          )}
        </PostStep>

        <PostStep n={2} title="Copy the text and post it">
          <div className="flex items-center gap-1 border-b border-white/[0.06]">
            {post.platforms.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setTab(p)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs font-medium ${p === active ? "border-white text-white" : "border-transparent text-neutral-500 hover:text-neutral-300"}`}
              >
                <span className="size-1.5 rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
                {PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
          <textarea
            key={`${active}-c-${post.id}`}
            defaultValue={copyOf(active).caption}
            rows={4}
            placeholder="No caption yet: write one, or open the video and press Schedule to have the agent write it."
            onBlur={(e) => e.target.value !== copyOf(active).caption && saveCopy(active, { caption: e.target.value })}
            className="resize-y rounded-lg bg-neutral-950 px-3 py-2 text-sm leading-relaxed text-neutral-100 ring-1 ring-white/[0.06] placeholder:text-neutral-600 focus:ring-white/20 focus:outline-none"
          />
          <HashtagField value={copyOf(active).hashtags} onChange={(hashtags) => saveCopy(active, { hashtags })} />
          <div className="flex items-center gap-2 text-xs">
            <button type="button" onClick={() => void copyText(active, postText(copyOf(active)))} className="rounded-lg bg-white px-3 py-1.5 font-semibold text-neutral-900 hover:bg-neutral-200">
              {copied === active ? "Copied ✓" : "Copy text"}
            </button>
            <a href={UPLOAD_URL[active]} target="_blank" rel="noreferrer" className="rounded-lg bg-neutral-800 px-3 py-1.5 font-semibold text-neutral-200 hover:bg-neutral-700">
              Open {PLATFORM_LABEL[active]} ↗
            </a>
          </div>
          {posted && <PostNumbers post={post} platform={active} onChange={onChange} />}
        </PostStep>

        <PostStep n={3} done={posted} title={posted ? "Posted" : "Mark it as posted"}>
          <p className="text-xs text-neutral-500">
            {posted ? "Its numbers come in from your connected accounts and show up in Stats." : "Once it's up everywhere. With your accounts connected, its views and where viewers leave come back here and in Stats."}
          </p>
          <div className="flex items-center gap-2">
            {posted ? (
              <>
                <button type="button" disabled={refreshing} onClick={() => void refresh()} className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-50">
                  {refreshing ? "Refreshing…" : "Refresh numbers"}
                </button>
                <button type="button" onClick={() => void save({ status: PostStatus.Scheduled })} className="text-xs text-neutral-500 hover:text-white">
                  Not posted yet
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void save({ status: PostStatus.Posted })} className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-emerald-300">
                Mark as posted
              </button>
            )}
          </div>
        </PostStep>
      </ol>

      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="button" onClick={() => void remove()} className="self-start text-xs text-neutral-600 hover:text-red-400">
        Delete this post
      </button>
    </section>
  );
}
