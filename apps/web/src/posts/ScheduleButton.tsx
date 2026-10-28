import { useEffect, useRef, useState } from "react";
import {
  api,
  mediaUrl,
  Platform,
  PostStatus,
  type PostCopy,
  type ScheduledPost,
} from "../api/client";
import { renderCurrentScene } from "../export/renderScene";
import { href, RouteName } from "../router";
import type { EditorProps } from "../editor/context";
import { CoverImage } from "../components/VideoCard";
import { Dropdown } from "../components/Dropdown";
import { HashtagField } from "./HashtagField";
import {
  defaultSlot,
  formatWhen,
  fromNow,
  MAX_CAPTION,
  PLATFORM_COLOR,
  PLATFORM_LABEL,
  platformList,
  PLATFORMS,
  postText,
  quickSlots,
} from "./posts";
import { useAgentName } from "../agentName";
import { sceneVariants, variantHook } from "@motionily/protocol";
import { useSceneView } from "../editor/sceneView";

/** Pause after the last edit before the draft is saved with the video. */
const DRAFT_SAVE_MS = 800;
/** Social videos go out at 1080 on the short side. */
const POST_SHORT_SIDE = 1080;
/** The "Improve" menu: each is the instruction the agent rewrites with. */
const TWEAKS = [
  "Rewrite it",
  "Shorter",
  "More playful",
  "More professional",
  "Add a call to action",
  "Start with a question",
  "Fewer hashtags",
  "No emojis",
];
/** The When menu's entry that opens the date and time fields. */
const CUSTOM = "custom";

const Stage = {
  Edit: "edit",
  Saving: "saving",
  Rendering: "rendering",
  Done: "done",
} as const;
type Stage = (typeof Stage)[keyof typeof Stage];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const emptyCopy = (platform: Platform): PostCopy => ({
  platform,
  caption: "",
  hashtags: [],
});
const pad = (n: number) => String(n).padStart(2, "0");
const dateValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameText = (a: PostCopy, b: PostCopy) =>
  a.caption === b.caption && a.hashtags.join(" ") === b.hashtags.join(" ");

/**
 * Put this video on the posting calendar: where, when and (optionally) the text. The file is prepared
 * when it's scheduled, so it's ready to upload when the reminder comes.
 */
export function ScheduleButton({ ed }: { ed: EditorProps }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 hover:text-white"
      >
        Schedule
      </button>
      {open && ed.project && (
        <ScheduleDialog ed={ed} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium text-neutral-400">{children}</span>
  );
}

function ScheduleDialog({
  ed,
  onClose,
}: {
  ed: EditorProps;
  onClose: () => void;
}) {
  const agent = useAgentName();
  const project = ed.project!;
  /** The video's upcoming post, opened for editing (undefined while loading). */
  const [existing, setExisting] = useState<ScheduledPost | null | undefined>(
    undefined,
  );
  /** Every upcoming post of this video: one per hook when it has several openings. */
  const [upcoming, setUpcoming] = useState<ScheduledPost[]>([]);
  const scene = useSceneView();
  const variants = scene ? sceneVariants(scene) : [];
  const hooked = variants.length > 1;
  /** Which hook each platform gets (videos with several openings). */
  const [hookOf, setHookOf] = useState<Partial<Record<Platform, string>>>({});
  const [platforms, setPlatforms] = useState<Platform[]>([
    Platform.Instagram,
    Platform.TikTok,
  ]);
  const [when, setWhen] = useState<Date>(defaultSlot);
  /** The date and time fields are open instead of a quick slot. */
  const [custom, setCustom] = useState(false);
  const [copy, setCopy] = useState<PostCopy[]>([]);
  /** One text for every platform (the usual case), or one each. */
  const [perPlatform, setPerPlatform] = useState(false);
  const [tab, setTab] = useState<Platform>(Platform.Instagram);
  const [writing, setWriting] = useState(false);
  const [stage, setStage] = useState<Stage>(Stage.Edit);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ScheduledPost | null>(null);
  /** Posts saved: more than one when each hook got its own. */
  const [savedCount, setSavedCount] = useState(1);
  const [renderingHook, setRenderingHook] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = stage === Stage.Saving || stage === Stage.Rendering;
  const slots = quickSlots();

  /** The platform whose text is on screen: the open tab, or the first one when they all share it. */
  const shown =
    perPlatform && platforms.includes(tab)
      ? tab
      : (platforms[0] ?? Platform.Instagram);
  const copyOf = (p: Platform) =>
    copy.find((c) => c.platform === p) ?? emptyCopy(p);
  /** Edits go to the open platform, or to every platform while they share one text. */
  const edit = (patch: Partial<PostCopy>) => {
    const targets = perPlatform ? [shown] : PLATFORMS;
    setCopy((all) => [
      ...all.filter((c) => !targets.includes(c.platform)),
      ...targets.map((p) => ({ ...copyOf(shown), ...patch, platform: p })),
    ]);
  };
  const text = copyOf(shown);
  const hasText = !!(text.caption.trim() || text.hashtags.length);

  const write = async (instruction?: string) => {
    if (!platforms.length) return;
    setWriting(true);
    setError(null);
    try {
      // One text for all: written for the first platform and used on every one.
      const res = await api.writeCopy(
        project.id,
        perPlatform ? platforms : [platforms[0]!],
        instruction,
      );
      if (perPlatform)
        setCopy((all) => [
          ...all.filter(
            (c) => !res.copy.some((n) => n.platform === c.platform),
          ),
          ...res.copy,
        ]);
      else if (res.copy[0])
        setCopy(PLATFORMS.map((p) => ({ ...res.copy[0]!, platform: p })));
    } catch (e) {
      setError(message(e));
    } finally {
      setWriting(false);
    }
  };

  // One video, one post: an upcoming post of this video opens for editing; otherwise the saved draft.
  // The agent only writes when asked (text is never written or rewritten behind the user's back).
  useEffect(() => {
    api
      .posts({ projectId: project.id })
      .then((list) => {
        const scheduled = list.filter(
          (p) => p.status === PostStatus.Scheduled,
        );
        const next = scheduled[0] ?? null;
        setExisting(next);
        setUpcoming(scheduled);
        const hooks: Partial<Record<Platform, string>> = {};
        for (const p of scheduled)
          for (const pl of p.platforms) if (p.variant) hooks[pl] = p.variant;
        setHookOf(hooks);
        const loaded = next
          ? next.copy
          : project.postCopy.filter((c): c is PostCopy =>
              (PLATFORMS as string[]).includes(c.platform),
            );
        if (next) {
          setPlatforms(
            PLATFORMS.filter((pl) =>
              scheduled.some((p) => p.platforms.includes(pl)),
            ),
          );
          setTab(next.platforms[0] ?? Platform.Instagram);
          setWhen(new Date(next.scheduledAt));
          setCustom(
            !quickSlots().some(
              (s) => s.at.getTime() === new Date(next.scheduledAt).getTime(),
            ),
          );
        }
        setCopy(loaded);
        // Texts that differ between platforms open one tab each.
        const written = loaded.filter(
          (c) => c.caption.trim() || c.hashtags.length,
        );
        setPerPlatform(written.some((c) => !sameText(c, written[0]!)));
      })
      .catch((e) => {
        setExisting(null);
        setError(message(e));
      });
    // Once per video: the draft autosave below updates the project, which must not reload this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // The draft follows the user's edits (and the agent's rewrites), so it is there the next time.
  const loaded = existing !== undefined;
  useEffect(() => {
    if (!loaded || existing || !copy.length) return;
    const timer = setTimeout(
      () =>
        void api
          .updateProject(project.id, { postCopy: copy })
          .then(ed.setProject)
          .catch(() => undefined),
      DRAFT_SAVE_MS,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy, loaded, existing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggle = (p: Platform) => {
    const next = PLATFORMS.filter((x) =>
      x === p ? !platforms.includes(p) : platforms.includes(x),
    );
    setPlatforms(next);
    if (next.includes(p)) setTab(p);
  };
  const setDate = (v: string) => {
    const [y, m, d] = v.split("-").map(Number);
    if (!y || !m || !d) return;
    const next = new Date(when);
    next.setFullYear(y, m - 1, d);
    setWhen(next);
  };
  const setTime = (v: string) => {
    const [h, min] = v.split(":").map(Number);
    if (
      h === undefined ||
      min === undefined ||
      Number.isNaN(h) ||
      Number.isNaN(min)
    )
      return;
    const next = new Date(when);
    next.setHours(h, min, 0, 0);
    setWhen(next);
  };
  const splitText = (on: boolean) => {
    // Back to one text: the open platform's is used on all.
    if (!on) setCopy(PLATFORMS.map((p) => ({ ...copyOf(shown), platform: p })));
    setPerPlatform(on);
  };

  const whenValue = custom
    ? CUSTOM
    : (slots.find((s) => s.at.getTime() === when.getTime())?.label ?? CUSTOM);
  const past = when.getTime() < Date.now();

  /** A platform's hook: the one picked, else spread so each platform tests a different opening. */
  const hookFor = (p: Platform) => {
    const picked = hookOf[p];
    if (picked && variants.includes(picked)) return picked;
    return variants[Math.max(0, platforms.indexOf(p)) % variants.length]!;
  };
  /** The posts to save: one per hook used (or one for the video), with their platforms. */
  const groups = (): { variant: string | null; platforms: Platform[] }[] => {
    if (!hooked) return [{ variant: null, platforms }];
    const by = new Map<string, Platform[]>();
    for (const p of platforms) by.set(hookFor(p), [...(by.get(hookFor(p)) ?? []), p]);
    return [...by].map(([variant, ps]) => ({ variant, platforms: ps }));
  };

  const save = async () => {
    if (!platforms.length) return setError("Pick where to post it.");
    // Asked here, on a click, so the browser shows the prompt: the reminder arrives as a notification.
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    )
      void Notification.requestPermission();
    setError(null);
    try {
      setStage(Stage.Saving);
      // Each hook's post reuses the one it had (or the video's single post); the rest are new.
      const free = [...upcoming];
      const take = (variant: string | null) => {
        const i = free.findIndex((p) => p.variant === variant);
        const j = i >= 0 ? i : free.findIndex((p) => !p.variant);
        return j >= 0 ? free.splice(j, 1)[0]! : null;
      };
      const posts: ScheduledPost[] = [];
      for (const g of groups()) {
        const body = {
          scheduledAt: when.toISOString(),
          platforms: g.platforms,
          copy: g.platforms.map(copyOf),
          variant: g.variant,
        };
        const mine = take(g.variant);
        posts.push(
          mine
            ? await api.updatePost(mine.id, body)
            : await api.createPost({ projectId: project.id, ...body }),
        );
      }
      // Hooks no longer used: their posts go.
      for (const stale of free) if (stale.variant) await api.deletePost(stale.id);
      // On the calendar from here on: a retry updates these posts instead of adding others.
      setUpcoming(posts);
      setExisting(posts[0]!);
      setSaved(posts[0]!);
      setSavedCount(posts.length);
      const pending = posts.filter((p) => !p.video || p.video.outdated);
      if (!pending.length) return setStage(Stage.Done);
      // The files, so they're ready to upload when the reminder comes.
      setStage(Stage.Rendering);
      setProgress(0);
      abort.current = new AbortController();
      const revision = await ed.flushScene();
      const audioUrl = project.audio ? mediaUrl(project.audio.url) : null;
      for (const [i, post] of pending.entries()) {
        setRenderingHook(post.variant);
        const file = await renderCurrentScene({
          shortSide: POST_SHORT_SIDE,
          audioUrl,
          variant: post.variant,
          onProgress: (r) => setProgress((i + r) / pending.length),
          signal: abort.current.signal,
        });
        const done = await api.uploadPostVideo(
          post.id,
          file.blob,
          `${project.name || "motionily"}${post.variant ? ` hook ${post.variant}` : ""}.${file.extension}`,
          revision,
        );
        if (post.id === posts[0]!.id) setSaved(done);
      }
      setStage(Stage.Done);
    } catch (e) {
      // Scheduled even if the file failed or was skipped: it can be made later.
      if (e instanceof DOMException && e.name === "AbortError")
        return setStage(Stage.Done);
      setStage(Stage.Edit);
      setError(message(e));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-label="Schedule post"
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-neutral-900 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-4 px-6 pt-5 pb-1">
          <h2 className="flex-1 text-lg font-semibold">
            {existing ? "Scheduled post" : "Schedule post"}
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-neutral-500 hover:bg-white/5 hover:text-white"
          >
            <svg
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              aria-hidden
            >
              <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {stage === Stage.Done && saved ? (
          <Done post={saved} count={savedCount} onClose={onClose} />
        ) : stage === Stage.Rendering ? (
          <div className="flex flex-col gap-4 px-6 py-8">
            <p className="font-medium">
              Scheduled. Preparing the video file
              {renderingHook ? ` with hook ${renderingHook}` : ""}…
            </p>
            <p className="text-sm text-neutral-400">
              So it's ready to upload when the reminder comes. Keep this open a
              moment.
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full bg-white transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-neutral-400">
              <span className="tabular-nums">
                {Math.round(progress * 100)}%
              </span>
              <button
                type="button"
                onClick={() => abort.current?.abort()}
                className="hover:text-white"
              >
                Skip, I'll do it later
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-4">
              <div className="hidden w-44 shrink-0 sm:block">
                <Preview
                  cover={project.cover ?? null}
                  copy={text}
                  handle={project.name}
                />
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <Label>Post on</Label>
                  <div className="flex flex-wrap gap-2">
                    {PLATFORMS.map((p) => {
                      const on = platforms.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggle(p)}
                          className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm ring-1 transition ${on ? "bg-white/[0.08] text-white ring-white/25" : "text-neutral-500 ring-white/[0.08] hover:text-white"}`}
                        >
                          <span
                            className="size-2 rounded-full"
                            style={{
                              background: on ? PLATFORM_COLOR[p] : "#525252",
                            }}
                          />
                          {PLATFORM_LABEL[p]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {hooked && platforms.length > 0 && scene && (
                  <div className="flex flex-col gap-2">
                    <Label>Hook</Label>
                    <div className="flex flex-col gap-1.5">
                      {platforms.map((p) => (
                        <div key={p} className="flex items-center gap-3">
                          <span className="flex w-32 shrink-0 items-center gap-2 text-sm text-neutral-300">
                            <span
                              className="size-2 rounded-full"
                              style={{ background: PLATFORM_COLOR[p] }}
                            />
                            {PLATFORM_LABEL[p]}
                          </span>
                          <Dropdown
                            className="min-w-0 flex-1"
                            label={`Hook on ${PLATFORM_LABEL[p]}`}
                            value={hookFor(p)}
                            onChange={(v) =>
                              setHookOf((h) => ({ ...h, [p]: v }))
                            }
                            options={variants.map((v) => ({
                              value: v,
                              label: `${v} · ${variantHook(scene, v) || "…"}`,
                            }))}
                          />
                        </div>
                      ))}
                    </div>
                    <span className="text-xs text-neutral-500">
                      A different hook on each platform shows which opening
                      works: Stats compares them 3 days after posting.
                    </span>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <Label>When</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Dropdown
                      className="w-56"
                      label="When"
                      value={whenValue}
                      onChange={(v) => {
                        const slot = slots.find((s) => s.label === v);
                        setCustom(!slot);
                        if (slot) setWhen(slot.at);
                      }}
                      options={[
                        ...slots.map((s) => ({
                          value: s.label,
                          label: s.label,
                          hint: fromNow(s.at),
                        })),
                        { value: CUSTOM, label: "Pick a date and time…" },
                      ]}
                    />
                    {whenValue === CUSTOM && (
                      <>
                        <input
                          type="date"
                          value={dateValue(when)}
                          onChange={(e) => setDate(e.target.value)}
                          aria-label="Date"
                          className="rounded-lg bg-neutral-800/80 px-3 py-2 text-sm text-white ring-1 ring-white/[0.06] [color-scheme:dark] focus:ring-white/25 focus:outline-none"
                        />
                        <input
                          type="time"
                          value={timeValue(when)}
                          onChange={(e) => setTime(e.target.value)}
                          aria-label="Time"
                          className="rounded-lg bg-neutral-800/80 px-3 py-2 text-sm text-white ring-1 ring-white/[0.06] [color-scheme:dark] focus:ring-white/25 focus:outline-none"
                        />
                      </>
                    )}
                  </div>
                  {past && (
                    <span className="text-xs text-amber-300">
                      That time has passed: you'll be reminded right away.
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label>Caption</Label>
                    {existing !== undefined &&
                      (hasText ? (
                        <Dropdown
                          size="sm"
                          align="right"
                          className="w-36"
                          label="Improve with the agent"
                          placeholder={writing ? "Writing…" : "✨ Improve"}
                          disabled={writing || !platforms.length}
                          value={null}
                          onChange={(t) =>
                            void write(t === "Rewrite it" ? undefined : t)
                          }
                          options={TWEAKS.map((t) => ({ value: t, label: t }))}
                        />
                      ) : (
                        <button
                          type="button"
                          disabled={writing || !platforms.length}
                          onClick={() => void write()}
                          className="rounded-lg bg-white/[0.08] px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/[0.14] disabled:opacity-50"
                        >
                          {writing ? "Writing…" : `✨ Write it for me`}
                        </button>
                      ))}
                  </div>
                  {perPlatform && platforms.length > 1 && (
                    <div className="flex gap-1">
                      {platforms.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setTab(p)}
                          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${p === shown ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
                        >
                          <span
                            className="size-1.5 rounded-full"
                            style={{ background: PLATFORM_COLOR[p] }}
                          />
                          {PLATFORM_LABEL[p]}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <textarea
                      value={text.caption}
                      disabled={writing}
                      onChange={(e) => edit({ caption: e.target.value })}
                      rows={6}
                      placeholder={
                        writing
                          ? `${agent} is writing…`
                          : `What goes under the video. Write it, or press “Write it for me” and ${agent} writes it from the video.`
                      }
                      className={`w-full resize-y rounded-xl bg-neutral-950 px-3.5 py-3 pb-6 text-sm leading-relaxed text-neutral-100 ring-1 ring-white/[0.06] placeholder:text-neutral-600 focus:ring-white/20 focus:outline-none ${writing ? "animate-pulse" : ""}`}
                    />
                    <span
                      className={`pointer-events-none absolute right-3 bottom-2.5 text-[10px] tabular-nums ${postText(text).length > MAX_CAPTION ? "text-red-400" : "text-neutral-600"}`}
                    >
                      {postText(text).length} / {MAX_CAPTION}
                    </span>
                  </div>
                  <HashtagField
                    value={text.hashtags}
                    disabled={writing}
                    onChange={(hashtags) => edit({ hashtags })}
                  />
                  {platforms.length > 1 && (
                    <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-neutral-500 hover:text-neutral-300">
                      <input
                        type="checkbox"
                        checked={perPlatform}
                        onChange={(e) => splitText(e.target.checked)}
                        className="size-3.5 accent-white"
                      />
                      Different text for each platform
                    </label>
                  )}
                </div>
              </div>
            </div>

            <footer className="flex flex-wrap items-center gap-3 border-t border-white/[0.06] px-6 py-4">
              <p className="min-w-0 flex-1 truncate text-sm text-neutral-400">
                {error ? (
                  <span className="text-red-400">{error}</span>
                ) : (
                  "You'll get a reminder then, with everything ready."
                )}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  busy || writing || existing === undefined || !platforms.length
                }
                onClick={() => void save()}
                className="rounded-lg bg-white px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
              >
                {stage === Stage.Saving
                  ? "Saving…"
                  : existing
                    ? "Save changes"
                    : `Schedule · ${formatWhen(when.toISOString())}`}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function Preview({
  cover,
  copy,
  handle,
}: {
  cover: string | null;
  copy: PostCopy | null;
  handle: string;
}) {
  const caption = copy?.caption.trim() ?? "";
  const tags = copy?.hashtags ?? [];
  return (
    <div className="relative aspect-[9/16] w-full overflow-hidden rounded-2xl bg-neutral-900 ring-1 ring-white/10">
      <CoverImage cover={cover} className="absolute inset-0" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-3 pt-16 text-[11px] leading-snug text-white">
        <span className="font-semibold">{handle || "your account"}</span>
        {caption || tags.length ? (
          <span className="line-clamp-4 whitespace-pre-line text-white/90">
            {caption}
            {tags.length > 0 && (
              <span className="text-sky-300">
                {" "}
                {tags.map((t) => `#${t}`).join(" ")}
              </span>
            )}
          </span>
        ) : (
          <span className="text-white/40">The caption shows here</span>
        )}
      </div>
    </div>
  );
}

/** Scheduled: what happens now, step by step. */
function Done({
  post,
  count,
  onClose,
}: {
  post: ScheduledPost;
  count: number;
  onClose: () => void;
}) {
  const steps = [
    `On ${formatWhen(post.scheduledAt)} Motionily reminds you (keep it open, or check the calendar).`,
    post.video
      ? "Open the post: download the video and copy the text, one click each."
      : "Open the post to copy the text. The file wasn't made: press Schedule again to make it, or use Export.",
    count > 1
      ? "Each hook is its own post on the calendar, with its own file: post each where it says and press “Mark as posted”. Stats then says which hook works."
      : `Post it on ${platformList(post.platforms)} and press “Mark as posted”: with your accounts connected, its numbers show up in Stats.`,
  ];
  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
          <svg
            viewBox="0 0 16 16"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden
          >
            <path
              d="m3.5 8.5 3 3 6-7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <p className="font-semibold">
            Scheduled for {formatWhen(post.scheduledAt)}
          </p>
          <p className="text-sm text-neutral-400">
            {count > 1
              ? `${count} posts, one per hook`
              : platformList(post.platforms)}{" "}
            ·{" "}
            {fromNow(new Date(post.scheduledAt))}
          </p>
        </div>
      </div>
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 text-sm text-neutral-300">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[11px] font-semibold">
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white"
        >
          Done
        </button>
        <a
          href={href({ name: RouteName.Calendar, postId: post.id })}
          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200"
        >
          Open in calendar
        </a>
      </div>
    </div>
  );
}
