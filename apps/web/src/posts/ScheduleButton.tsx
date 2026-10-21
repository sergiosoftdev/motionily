import { useEffect, useRef, useState } from "react";
import { api, mediaUrl, Platform, PostStatus, type PostCopy, type ScheduledPost } from "../api/client";
import { renderCurrentScene } from "../export/renderScene";
import { href, RouteName } from "../router";
import type { EditorProps } from "../editor/context";
import { defaultSlot, formatWhen, fromLocalInput, hashtagsText, MAX_CAPTION, parseHashtags, PLATFORM_LABEL, PLATFORMS, postText, toLocalInput } from "./posts";

const Stage = { Edit: "edit", Rendering: "rendering", Uploading: "uploading", Done: "done" } as const;
type Stage = (typeof Stage)[keyof typeof Stage];
/** Pause after the last edit before the draft is saved with the video. */
const DRAFT_SAVE_MS = 800;
/** Social videos go out at 1080 on the short side. */
const POST_SHORT_SIDE = 1080;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const emptyCopy = (platform: Platform): PostCopy => ({ platform, caption: "", hashtags: [] });

/** Schedule this video for Instagram and TikTok: Claude writes the text, the editor renders the file. */
export function ScheduleButton({ ed }: { ed: EditorProps }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 hover:text-white">
        Schedule
      </button>
      {open && ed.project && <ScheduleDialog ed={ed} onClose={() => setOpen(false)} />}
    </>
  );
}

function ScheduleDialog({ ed, onClose }: { ed: EditorProps; onClose: () => void }) {
  const project = ed.project!;
  /** The video's upcoming post, opened for editing (undefined while loading). */
  const [existing, setExisting] = useState<ScheduledPost | null | undefined>(undefined);
  const [platforms, setPlatforms] = useState<Platform[]>(PLATFORMS);
  const [when, setWhen] = useState(() => toLocalInput(defaultSlot()));
  const [copy, setCopy] = useState<PostCopy[]>([]);
  /** Bumped when Claude rewrites the text, so the hashtag fields pick it up. */
  const [draft, setDraft] = useState(0);
  const [writing, setWriting] = useState(false);
  const [steer, setSteer] = useState("");
  const [stage, setStage] = useState<Stage>(Stage.Edit);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ScheduledPost | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = stage === Stage.Rendering || stage === Stage.Uploading;

  const copyOf = (p: Platform) => copy.find((c) => c.platform === p) ?? emptyCopy(p);
  const setCopyOf = (p: Platform, patch: Partial<PostCopy>) => setCopy((all) => [...all.filter((c) => c.platform !== p), { ...copyOf(p), ...patch }]);

  const write = async (forPlatforms: Platform[], steerText?: string) => {
    setWriting(true);
    setError(null);
    try {
      const res = await api.writeCopy(project.id, forPlatforms, steerText);
      setCopy((all) => [...all.filter((c) => !res.copy.some((n) => n.platform === c.platform)), ...res.copy]);
      setDraft((d) => d + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setWriting(false);
    }
  };

  // One video, one post: an upcoming post of this video opens for editing; otherwise the saved draft,
  // and only a video without one asks Claude (text is never rewritten behind the user's back).
  const started = useRef(false);
  useEffect(() => {
    // React's dev double mount must not ask Claude twice.
    if (started.current) return;
    started.current = true;
    api
      .posts({ projectId: project.id })
      .then((list) => {
        const next = list.find((p) => p.status === PostStatus.Scheduled) ?? null;
        setExisting(next);
        if (!next) {
          const saved = project.postCopy.filter((c): c is PostCopy => (PLATFORMS as string[]).includes(c.platform));
          if (!saved.length) return void write(PLATFORMS);
          setCopy(saved);
          setDraft((d) => d + 1);
          return;
        }
        setPlatforms(next.platforms);
        setWhen(toLocalInput(new Date(next.scheduledAt)));
        setCopy(next.copy);
        setDraft((d) => d + 1);
      })
      .catch((e) => {
        setExisting(null);
        setError(message(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // The draft follows the user's edits (and Claude's rewrites), so it is there the next time.
  const loaded = existing !== undefined;
  useEffect(() => {
    if (!loaded || existing || !copy.length) return;
    const timer = setTimeout(() => void api.updateProject(project.id, { postCopy: copy }).then(ed.setProject).catch(() => undefined), DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy, loaded, existing]);

  const toggle = (p: Platform) => {
    const next = PLATFORMS.filter((x) => (x === p ? !platforms.includes(p) : platforms.includes(x)));
    setPlatforms(next);
    if (next.includes(p) && !copyOf(p).caption) void write([p]);
  };

  /** A new post or a changed video needs a new file; otherwise only the text and time are saved. */
  const needsRender = !existing || !existing.video || existing.video.outdated;

  const save = async () => {
    const at = fromLocalInput(when);
    if (!at) return setError("Pick a date and time.");
    if (!platforms.length) return setError("Pick at least one platform.");
    // Asked here, on a click, so the browser shows the prompt: the reminder arrives as a notification.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    setError(null);
    const body = { scheduledAt: at, platforms, copy: platforms.map(copyOf) };
    try {
      if (!needsRender) {
        setStage(Stage.Uploading);
        setSaved(await api.updatePost(existing!.id, body));
        return setStage(Stage.Done);
      }
      setStage(Stage.Rendering);
      setProgress(0);
      abort.current = new AbortController();
      const revision = await ed.flushScene();
      const audioUrl = project.audio ? mediaUrl(project.audio.url) : null;
      const file = await renderCurrentScene({ shortSide: POST_SHORT_SIDE, audioUrl, onProgress: setProgress, signal: abort.current.signal });
      setStage(Stage.Uploading);
      const post = existing ? await api.updatePost(existing.id, body) : await api.createPost({ projectId: project.id, ...body });
      try {
        setSaved(await api.uploadPostVideo(post.id, file.blob, `${project.name || "motionily"}.${file.extension}`, revision));
      } catch (e) {
        // A new post without its file is no use on the calendar.
        if (!existing) await api.deletePost(post.id).catch(() => undefined);
        throw e;
      }
      setStage(Stage.Done);
    } catch (e) {
      setStage(Stage.Edit);
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(message(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => !busy && onClose()}>
      <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col gap-6 overflow-y-auto rounded-2xl bg-neutral-900 p-6" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-bold">{existing ? "Scheduled post" : "Schedule this video"}</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Claude writes the caption and hashtags for each platform. When it's time, Motionily reminds you with the video and the text ready to paste.
          </p>
        </div>

        {stage === Stage.Done && saved ? (
          <div className="flex flex-col gap-5">
            <p className="text-sm text-neutral-300">
              Scheduled for <span className="font-semibold text-white">{formatWhen(saved.scheduledAt)}</span> on {saved.platforms.map((p) => PLATFORM_LABEL[p]).join(" and ")}.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white">
                Close
              </button>
              <a href={href({ name: RouteName.Calendar, postId: saved.id })} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
                Open calendar
              </a>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              {PLATFORMS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(p)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-medium ${platforms.includes(p) ? "bg-white text-neutral-900" : "bg-neutral-800 text-neutral-400 hover:text-white"}`}
                >
                  {PLATFORM_LABEL[p]}
                </button>
              ))}
              <input
                type="datetime-local"
                value={when}
                disabled={busy}
                onChange={(e) => setWhen(e.target.value)}
                className="ml-auto rounded-lg bg-neutral-800 px-3 py-1.5 text-sm text-white [color-scheme:dark]"
              />
            </div>

            {existing === undefined ? (
              <p className="text-sm text-neutral-500">Loading…</p>
            ) : (
              platforms.map((p) => {
                const c = copyOf(p);
                const length = postText(c).length;
                return (
                  <section key={p} className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between">
                      <h3 className="text-sm font-semibold">{PLATFORM_LABEL[p]}</h3>
                      <span className={`text-xs tabular-nums ${length > MAX_CAPTION ? "text-red-400" : "text-neutral-500"}`}>
                        {length} / {MAX_CAPTION}
                      </span>
                    </div>
                    <textarea
                      value={c.caption}
                      disabled={busy || writing}
                      onChange={(e) => setCopyOf(p, { caption: e.target.value })}
                      rows={p === Platform.Instagram ? 6 : 3}
                      placeholder={writing ? "Claude is writing…" : "Caption"}
                      className="resize-y rounded-lg bg-neutral-950 px-3 py-2 text-sm leading-relaxed text-neutral-100 placeholder:text-neutral-600"
                    />
                    <input
                      key={`${p}-${draft}`}
                      defaultValue={hashtagsText(c.hashtags)}
                      disabled={busy || writing}
                      onBlur={(e) => setCopyOf(p, { hashtags: parseHashtags(e.target.value) })}
                      placeholder="#hashtags"
                      className="rounded-lg bg-neutral-950 px-3 py-2 text-sm text-sky-300 placeholder:text-neutral-600"
                    />
                  </section>
                );
              })
            )}

            {platforms.length > 0 && (
              <div className="flex gap-2">
                <input
                  value={steer}
                  disabled={busy || writing}
                  onChange={(e) => setSteer(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void write(platforms, steer)}
                  placeholder="Ask for changes: shorter, more playful, no emojis…"
                  className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-3 py-2 text-sm placeholder:text-neutral-500"
                />
                <button
                  type="button"
                  disabled={busy || writing}
                  onClick={() => void write(platforms, steer)}
                  className="shrink-0 rounded-lg bg-neutral-800 px-3 py-2 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-50"
                >
                  {writing ? "Writing…" : "Rewrite"}
                </button>
              </div>
            )}

            {stage === Stage.Rendering && (
              <div className="flex flex-col gap-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
                  <div className="h-full bg-white transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-neutral-400">
                  <span>Rendering the video… {Math.round(progress * 100)}%</span>
                  <button type="button" onClick={() => abort.current?.abort()} className="hover:text-white">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {stage === Stage.Uploading && <p className="text-xs text-neutral-400">Saving…</p>}
            {existing?.video?.outdated && stage === Stage.Edit && (
              <p className="text-xs text-amber-200/90">You edited the video after scheduling it: saving renders the new version.</p>
            )}
            {error && <p className="text-xs text-red-400">{error}</p>}

            <div className="flex items-center gap-2">
              {existing && (
                <button type="button" disabled={busy} onClick={() => setExisting(null)} className="mr-auto text-xs text-neutral-500 hover:text-white">
                  Schedule it again as a new post
                </button>
              )}
              <button type="button" disabled={busy} onClick={onClose} className="ml-auto rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || writing || existing === undefined || !platforms.length}
                onClick={() => void save()}
                className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
              >
                {existing ? (needsRender ? "Render again and save" : "Save") : "Render and schedule"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
