import { useEffect, useRef, useState } from "react";
import { api, mediaUrl, Platform, PostStatus, type PostCopy, type ScheduledPost } from "../api/client";
import { renderCurrentScene } from "../export/renderScene";
import { href, RouteName } from "../router";
import type { EditorProps } from "../editor/context";
import { defaultSlot, formatWhen, fromLocalInput, hashtagsText, MAX_CAPTION, parseHashtags, PLATFORM_LABEL, platformList, PLATFORMS, postText, toLocalInput } from "./posts";

const Stage = { Edit: "edit", Rendering: "rendering", Uploading: "uploading", Done: "done" } as const;
type Stage = (typeof Stage)[keyof typeof Stage];
/** Pause after the last edit before the draft is saved with the video. */
const DRAFT_SAVE_MS = 800;
/** Social videos go out at 1080 on the short side. */
const POST_SHORT_SIDE = 1080;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const emptyCopy = (platform: Platform): PostCopy => ({ platform, caption: "", hashtags: [] });

/**
 * Put this video on the posting calendar: when and where is enough. The caption and hashtags
 * (Claude writes them on request) and the rendered file are optional and can come later.
 */
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
  /** The caption and hashtags fields are shown (closed until there is text or the user opens them). */
  const [showText, setShowText] = useState(false);
  /** Render the file now as well, so it is ready when it's time to post. */
  const [render, setRender] = useState(false);
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
  const hasText = platforms.some((p) => copyOf(p).caption.trim());

  const write = async (forPlatforms: Platform[], steerText?: string) => {
    setWriting(true);
    setShowText(true);
    setError(null);
    try {
      const res = await api.writeCopy(project.id, forPlatforms, steerText);
      setCopy((all) => [...all.filter((c) => !res.copy.some((n) => n.platform === c.platform)), ...res.copy]);
      setDraft((d) => d + 1);
      setSteer("");
    } catch (e) {
      setError(message(e));
    } finally {
      setWriting(false);
    }
  };

  // One video, one post: an upcoming post of this video opens for editing; otherwise the saved draft.
  // Claude only writes when asked (text is never written or rewritten behind the user's back).
  useEffect(() => {
    api
      .posts({ projectId: project.id })
      .then((list) => {
        const next = list.find((p) => p.status === PostStatus.Scheduled) ?? null;
        setExisting(next);
        const text = next ? next.copy : project.postCopy.filter((c): c is PostCopy => (PLATFORMS as string[]).includes(c.platform));
        if (next) {
          setPlatforms(next.platforms);
          setWhen(toLocalInput(new Date(next.scheduledAt)));
          // A file to make or remake: offer it ticked.
          setRender(!!next.video?.outdated);
        }
        setCopy(text);
        setShowText(text.some((c) => c.caption.trim()));
        setDraft((d) => d + 1);
      })
      .catch((e) => {
        setExisting(null);
        setError(message(e));
      });
    // Once per video: the draft autosave below updates the project, which must not reload this.
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

  const toggle = (p: Platform) => setPlatforms(PLATFORMS.filter((x) => (x === p ? !platforms.includes(p) : platforms.includes(x))));

  const save = async () => {
    const at = fromLocalInput(when);
    if (!at) return setError("Pick a date and time.");
    if (!platforms.length) return setError("Pick at least one platform.");
    // Asked here, on a click, so the browser shows the prompt: the reminder arrives as a notification.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    setError(null);
    const body = { scheduledAt: at, platforms, copy: platforms.map(copyOf) };
    try {
      setStage(Stage.Uploading);
      const post = existing ? await api.updatePost(existing.id, body) : await api.createPost({ projectId: project.id, ...body });
      // On the calendar from here on: a retry updates this post instead of adding another.
      setExisting(post);
      if (!render) {
        setSaved(post);
        return setStage(Stage.Done);
      }
      setStage(Stage.Rendering);
      setProgress(0);
      abort.current = new AbortController();
      const revision = await ed.flushScene();
      const audioUrl = project.audio ? mediaUrl(project.audio.url) : null;
      const file = await renderCurrentScene({ shortSide: POST_SHORT_SIDE, audioUrl, onProgress: setProgress, signal: abort.current.signal });
      setStage(Stage.Uploading);
      setSaved(await api.uploadPostVideo(post.id, file.blob, `${project.name || "motionily"}.${file.extension}`, revision));
      setStage(Stage.Done);
    } catch (e) {
      setStage(Stage.Edit);
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(message(e));
    }
  };

  const fileNote = !existing?.video ? "Render the video now, so the file is ready when it's time" : existing.video.outdated ? "Render it again: you edited the video after the file was made" : "Render the file again";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => !busy && onClose()}>
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-6 overflow-y-auto rounded-2xl bg-neutral-900 p-6" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-bold">{existing ? "Scheduled post" : "Add to calendar"}</h2>
          <p className="mt-1 text-sm text-neutral-400">Pick when and where. Motionily reminds you when it's time to post.</p>
        </div>

        {stage === Stage.Done && saved ? (
          <div className="flex flex-col gap-5">
            <p className="text-sm text-neutral-300">
              On the calendar for <span className="font-semibold text-white">{formatWhen(saved.scheduledAt)}</span> on {platformList(saved.platforms)}.
              {!saved.video && " The file can be rendered later, from here or the calendar."}
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
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-neutral-400">When</span>
                <input
                  type="datetime-local"
                  value={when}
                  disabled={busy}
                  onChange={(e) => setWhen(e.target.value)}
                  className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-white [color-scheme:dark]"
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-neutral-400">Where</span>
                <div className="flex flex-wrap gap-2">
                  {PLATFORMS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={busy}
                      aria-pressed={platforms.includes(p)}
                      onClick={() => toggle(p)}
                      className={`rounded-full px-3.5 py-1.5 text-xs font-medium ${platforms.includes(p) ? "bg-white text-neutral-900" : "bg-neutral-800 text-neutral-400 hover:text-white"}`}
                    >
                      {PLATFORM_LABEL[p]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {existing === undefined ? (
              <p className="text-sm text-neutral-500">Loading…</p>
            ) : !showText ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <button type="button" disabled={busy || !platforms.length} onClick={() => void write(platforms)} className="font-medium text-white hover:underline disabled:opacity-50">
                  Write the caption with Claude
                </button>
                <span className="text-neutral-600">or</span>
                <button type="button" disabled={busy} onClick={() => setShowText(true)} className="text-neutral-400 hover:text-white">
                  write it yourself
                </button>
                <span className="w-full text-xs text-neutral-500">Optional: you can add it later from the calendar.</span>
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                {platforms.map((p) => {
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
                        rows={p === Platform.Instagram ? 5 : 3}
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
                })}
                {platforms.length > 0 && (
                  <div className="flex gap-2">
                    <input
                      value={steer}
                      disabled={busy || writing}
                      onChange={(e) => setSteer(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void write(platforms, steer)}
                      placeholder={hasText ? "Ask Claude for changes: shorter, more playful, no emojis…" : "Tell Claude anything to keep in mind (optional)"}
                      className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-3 py-2 text-sm placeholder:text-neutral-500"
                    />
                    <button
                      type="button"
                      disabled={busy || writing}
                      onClick={() => void write(platforms, steer)}
                      className="shrink-0 rounded-lg bg-neutral-800 px-3 py-2 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-50"
                    >
                      {writing ? "Writing…" : hasText ? "Rewrite" : "Write with Claude"}
                    </button>
                  </div>
                )}
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-3 text-sm text-neutral-400">
              <input type="checkbox" checked={render} disabled={busy} onChange={(e) => setRender(e.target.checked)} className="size-4 accent-white" />
              {fileNote}
            </label>

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
            {error && <p className="text-xs text-red-400">{error}</p>}

            <div className="flex items-center gap-2">
              <button type="button" disabled={busy} onClick={onClose} className="ml-auto rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || writing || existing === undefined || !platforms.length}
                onClick={() => void save()}
                className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
              >
                {existing ? "Save" : "Add to calendar"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
