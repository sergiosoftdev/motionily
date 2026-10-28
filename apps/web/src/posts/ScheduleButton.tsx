import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, mediaUrl, Platform, PostStatus, type PostCopy, type ScheduledPost } from "../api/client";
import { renderCurrentScene } from "../export/renderScene";
import { href, RouteName } from "../router";
import type { EditorProps } from "../editor/context";
import { CoverImage } from "../components/VideoCard";
import { HashtagField } from "./HashtagField";
import { defaultSlot, formatWhen, fromNow, MAX_CAPTION, PLATFORM_COLOR, PLATFORM_LABEL, platformList, PLATFORMS, postText, quickSlots } from "./posts";
import { useAgentName } from "../agentName";
import { ExperimentMetric } from "@motionily/protocol";

const Stage = { Edit: "edit", Rendering: "rendering", Uploading: "uploading", Done: "done" } as const;
type Stage = (typeof Stage)[keyof typeof Stage];
/** Pause after the last edit before the draft is saved with the video. */
const DRAFT_SAVE_MS = 800;
/** Social videos go out at 1080 on the short side. */
const POST_SHORT_SIDE = 1080;
/** One-click changes to the text (sent to the agent as the instruction). */
const TWEAKS = ["Shorter", "More playful", "More professional", "Add a call to action", "Start with a question", "Fewer hashtags", "No emojis"];

/** The experiment metrics as chips. */
const METRIC_SHORT: Record<ExperimentMetric, string> = { hook: "The hook (3-s skip)", watch: "How much is watched", views: "Views", shares: "Shares", saves: "Saves" };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const emptyCopy = (platform: Platform): PostCopy => ({ platform, caption: "", hashtags: [] });
const pad = (n: number) => String(n).padStart(2, "0");
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Put this video on the posting calendar: where and when is all it takes. The caption and hashtags
 * (the agent writes them on request) and the rendered file are optional and can come later.
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

function Step({ n, title, hint, children, optional }: { n: number; title: string; hint?: string; optional?: boolean; children: ReactNode }) {
  return (
    <section className="flex gap-4">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-semibold text-neutral-300">{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {title}
            {optional && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-neutral-400">Optional</span>}
          </h3>
          {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

function ScheduleDialog({ ed, onClose }: { ed: EditorProps; onClose: () => void }) {
  const agent = useAgentName();
  const project = ed.project!;
  /** The video's upcoming post, opened for editing (undefined while loading). */
  const [existing, setExisting] = useState<ScheduledPost | null | undefined>(undefined);
  const [platforms, setPlatforms] = useState<Platform[]>([Platform.Instagram, Platform.TikTok]);
  const [when, setWhen] = useState<Date>(defaultSlot);
  /** The date and time fields are open (a quick slot is enough most of the time). */
  const [custom, setCustom] = useState(false);
  const [copy, setCopy] = useState<PostCopy[]>([]);
  /** The text fields are shown (closed until there is text or the user opens them). */
  const [showText, setShowText] = useState(false);
  const [tab, setTab] = useState<Platform>(Platform.Instagram);
  /** Render the file now as well, so it is ready when it's time to post. */
  const [render, setRender] = useState(false);
  const [writing, setWriting] = useState(false);
  const [steer, setSteer] = useState("");
  const [copied, setCopied] = useState(false);
  const [stage, setStage] = useState<Stage>(Stage.Edit);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ScheduledPost | null>(null);
  /** What the video tests against the channel (its agent may have set it already). */
  const [testChange, setTestChange] = useState(project.experiment?.change ?? "");
  const [testMetric, setTestMetric] = useState<ExperimentMetric>(project.experiment?.metric ?? ExperimentMetric.Hook);
  const abort = useRef<AbortController | null>(null);
  const busy = stage === Stage.Rendering || stage === Stage.Uploading;
  const slots = quickSlots();
  const active = platforms.includes(tab) ? tab : (platforms[0] ?? null);

  const copyOf = (p: Platform) => copy.find((c) => c.platform === p) ?? emptyCopy(p);
  const setCopyOf = (p: Platform, patch: Partial<PostCopy>) => setCopy((all) => [...all.filter((c) => c.platform !== p), { ...copyOf(p), ...patch }]);
  const hasText = platforms.some((p) => copyOf(p).caption.trim() || copyOf(p).hashtags.length);

  const write = async (steerText?: string) => {
    if (!platforms.length) return;
    setWriting(true);
    setShowText(true);
    setError(null);
    try {
      const res = await api.writeCopy(project.id, platforms, steerText);
      setCopy((all) => [...all.filter((c) => !res.copy.some((n) => n.platform === c.platform)), ...res.copy]);
      setSteer("");
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
        const next = list.find((p) => p.status === PostStatus.Scheduled) ?? null;
        setExisting(next);
        const text = next ? next.copy : project.postCopy.filter((c): c is PostCopy => (PLATFORMS as string[]).includes(c.platform));
        if (next) {
          setPlatforms(next.platforms);
          setTab(next.platforms[0] ?? Platform.Instagram);
          setWhen(new Date(next.scheduledAt));
          setCustom(true);
          // A file to make or remake: offer it on.
          setRender(!!next.video?.outdated);
        }
        setCopy(text);
        setShowText(text.some((c) => c.caption.trim() || c.hashtags.length));
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
    const timer = setTimeout(() => void api.updateProject(project.id, { postCopy: copy }).then(ed.setProject).catch(() => undefined), DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy, loaded, existing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggle = (p: Platform) => {
    const next = PLATFORMS.filter((x) => (x === p ? !platforms.includes(p) : platforms.includes(x)));
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
    if (h === undefined || min === undefined || Number.isNaN(h) || Number.isNaN(min)) return;
    const next = new Date(when);
    next.setHours(h, min, 0, 0);
    setWhen(next);
  };
  /** The open platform's text, given to the others too. */
  const applyToAll = (from: Platform) => setCopy((all) => [...all.filter((c) => !platforms.includes(c.platform)), ...platforms.map((p) => ({ ...copyOf(from), platform: p }))]);
  const copyText = async (p: Platform) => {
    await navigator.clipboard.writeText(postText(copyOf(p)));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const past = when.getTime() < Date.now();
  const save = async () => {
    if (!platforms.length) return setError("Pick at least one platform.");
    // Asked here, on a click, so the browser shows the prompt: the reminder arrives as a notification.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    setError(null);
    const body = { scheduledAt: when.toISOString(), platforms, copy: platforms.map(copyOf) };
    try {
      setStage(Stage.Uploading);
      const change = testChange.trim();
      if (change !== (project.experiment?.change ?? "") || (change && testMetric !== project.experiment?.metric)) {
        const { experiment } = await api.setExperiment(project.id, change ? { change, metric: testMetric } : null);
        ed.setProject({ ...project, experiment });
      }
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

  const fileHint = !existing?.video
    ? "The video exported at 1080, ready to upload when it's time. You can also do it later, from the calendar."
    : existing.video.outdated
      ? "You edited the video after its file was made: render it again so you post the latest cut."
      : "The file is ready. Render it again only if you change the video.";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-label="Schedule post"
        className="flex max-h-[92dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-neutral-900 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-4 border-b border-white/[0.06] px-6 py-4">
          <div className="flex-1">
            <h2 className="text-lg font-semibold">{existing ? "Scheduled post" : "Schedule a post"}</h2>
            <p className="text-sm text-neutral-400">You post it yourself; Motionily reminds you at that time with the video and the text ready to paste.</p>
          </div>
          <button type="button" disabled={busy} onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-neutral-500 hover:bg-white/5 hover:text-white">
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {stage === Stage.Done && saved ? (
          <Done post={saved} onClose={onClose} />
        ) : (
          <>
            <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_260px]">
              <div className="flex flex-col gap-7 px-6 py-5">
                <Step n={1} title="Where">
                  <div className="flex flex-wrap gap-2">
                    {PLATFORMS.map((p) => {
                      const on = platforms.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          disabled={busy}
                          aria-pressed={on}
                          onClick={() => toggle(p)}
                          className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium ring-1 transition ${on ? "bg-white/[0.08] text-white ring-white/25" : "text-neutral-400 ring-white/[0.08] hover:text-white hover:ring-white/15"}`}
                        >
                          <span className="size-2.5 rounded-full" style={{ background: on ? PLATFORM_COLOR[p] : "#525252" }} />
                          {PLATFORM_LABEL[p]}
                          {on && (
                            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                              <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </Step>

                <Step n={2} title="When">
                  <div className="flex flex-wrap gap-2">
                    {slots.map((s) => {
                      const on = !custom && s.at.getTime() === when.getTime();
                      return (
                        <button
                          key={s.label}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setWhen(s.at);
                            setCustom(false);
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${on ? "bg-white text-neutral-900 ring-white" : "text-neutral-300 ring-white/[0.08] hover:ring-white/20"}`}
                        >
                          {s.label}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setCustom(true)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${custom ? "bg-white text-neutral-900 ring-white" : "text-neutral-300 ring-white/[0.08] hover:ring-white/20"}`}
                    >
                      Pick a date…
                    </button>
                  </div>
                  {custom && (
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="date"
                        value={dateValue(when)}
                        disabled={busy}
                        onChange={(e) => setDate(e.target.value)}
                        aria-label="Date"
                        className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-white ring-1 ring-white/[0.06] [color-scheme:dark] focus:ring-white/25 focus:outline-none"
                      />
                      <input
                        type="time"
                        value={timeValue(when)}
                        disabled={busy}
                        onChange={(e) => setTime(e.target.value)}
                        aria-label="Time"
                        className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-white ring-1 ring-white/[0.06] [color-scheme:dark] focus:ring-white/25 focus:outline-none"
                      />
                    </div>
                  )}
                  <p className={`text-xs ${past ? "text-amber-300" : "text-neutral-400"}`}>
                    {formatWhen(when.toISOString())} · {past ? "that's in the past: you'll be reminded right away" : fromNow(when)}
                  </p>
                </Step>

                <Step n={3} title="Caption and hashtags" optional hint={showText ? undefined : "What you paste under the video. You can also add it later from the calendar."}>
                  {existing === undefined ? (
                    <p className="text-sm text-neutral-500">Loading…</p>
                  ) : !showText ? (
                    <div className="flex flex-col gap-3 rounded-xl bg-gradient-to-br from-white/[0.06] to-white/[0.02] p-4 ring-1 ring-white/[0.08]">
                      <div className="flex items-start gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#e5484d] text-white">
                          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
                            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
                          </svg>
                        </span>
                        <div>
                          <p className="text-sm font-medium">Let {agent} write them</p>
                          <p className="text-xs text-neutral-400">A caption and hashtags for each platform, from what the video says. Edit anything after.</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={steer}
                          disabled={busy || writing}
                          onChange={(e) => setSteer(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void write(steer)}
                          placeholder="Anything to include? A link, an offer, a tone… (optional)"
                          className="min-w-0 flex-1 rounded-lg bg-neutral-950/70 px-3 py-2 text-sm ring-1 ring-white/[0.06] placeholder:text-neutral-500 focus:ring-white/25 focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={busy || writing || !platforms.length}
                          onClick={() => void write(steer)}
                          className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
                        >
                          Write them
                        </button>
                      </div>
                      <button type="button" disabled={busy} onClick={() => setShowText(true)} className="self-start text-xs text-neutral-400 hover:text-white">
                        or write them yourself
                      </button>
                    </div>
                  ) : !active ? (
                    <p className="text-sm text-neutral-500">Pick a platform first.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-1 border-b border-white/[0.06]">
                        {platforms.map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setTab(p)}
                            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium ${p === active ? "border-white text-white" : "border-transparent text-neutral-500 hover:text-neutral-300"}`}
                          >
                            <span className="size-1.5 rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
                            {PLATFORM_LABEL[p]}
                          </button>
                        ))}
                        <span className="ml-auto flex gap-3 pb-1 text-xs">
                          {platforms.length > 1 && (
                            <button type="button" disabled={writing} onClick={() => applyToAll(active)} className="text-neutral-400 hover:text-white">
                              Use on all
                            </button>
                          )}
                          <button type="button" onClick={() => void copyText(active)} className="font-medium text-neutral-200 hover:text-white">
                            {copied ? "Copied" : "Copy"}
                          </button>
                        </span>
                      </div>
                      {writing ? (
                        <div className="flex flex-col gap-2 py-1" aria-live="polite">
                          <p className="text-xs text-neutral-400">{agent} is writing for {platformList(platforms)}…</p>
                          {[92, 78, 85, 40].map((w, i) => (
                            <span key={i} className="h-3 animate-pulse rounded bg-white/[0.06]" style={{ width: `${w}%` }} />
                          ))}
                        </div>
                      ) : (
                        <>
                          <div className="relative">
                            <textarea
                              value={copyOf(active).caption}
                              disabled={busy}
                              onChange={(e) => setCopyOf(active, { caption: e.target.value })}
                              rows={active === Platform.Instagram ? 6 : 4}
                              placeholder="Write the caption…"
                              className="w-full resize-y rounded-lg bg-neutral-950 px-3 py-2.5 pb-6 text-sm leading-relaxed text-neutral-100 ring-1 ring-white/[0.06] placeholder:text-neutral-600 focus:ring-white/20 focus:outline-none"
                            />
                            <span
                              className={`pointer-events-none absolute right-3 bottom-2.5 text-[10px] tabular-nums ${postText(copyOf(active)).length > MAX_CAPTION ? "text-red-400" : "text-neutral-600"}`}
                            >
                              {postText(copyOf(active)).length} / {MAX_CAPTION}
                            </span>
                          </div>
                          <HashtagField value={copyOf(active).hashtags} disabled={busy} onChange={(hashtags) => setCopyOf(active, { hashtags })} />
                        </>
                      )}
                      <div className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.05]">
                        <span className="text-xs text-neutral-400">{hasText ? `Ask ${agent} to change it (every platform)` : `Have ${agent} write it`}</span>
                        {hasText && (
                          <div className="flex flex-wrap gap-1.5">
                            {TWEAKS.map((t) => (
                              <button
                                key={t}
                                type="button"
                                disabled={busy || writing}
                                onClick={() => void write(t)}
                                className="rounded-full bg-white/[0.05] px-2.5 py-1 text-xs text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-50"
                              >
                                {t}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <input
                            value={steer}
                            disabled={busy || writing}
                            onChange={(e) => setSteer(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && void write(steer)}
                            placeholder={hasText ? "Or say how: mention the sale, sound less salesy…" : "Anything to include? (optional)"}
                            className="min-w-0 flex-1 rounded-lg bg-neutral-950 px-3 py-1.5 text-sm ring-1 ring-white/[0.06] placeholder:text-neutral-600 focus:ring-white/20 focus:outline-none"
                          />
                          <button
                            type="button"
                            disabled={busy || writing || (hasText && !steer.trim())}
                            onClick={() => void write(steer)}
                            className="shrink-0 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-40"
                          >
                            {writing ? "Writing…" : hasText ? "Rewrite" : "Write"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </Step>

                <Step n={4} title="What does this video test?" optional hint={`One thing it does differently from your usual videos, and the number that should show it. Three days after it's posted, Stats says whether it worked and ${agent} builds on it.`}>
                  <input
                    value={testChange}
                    disabled={busy}
                    onChange={(e) => setTestChange(e.target.value)}
                    maxLength={200}
                    placeholder="e.g. Opens with a question instead of a fact"
                    className="rounded-lg bg-neutral-800 px-3 py-2 text-sm ring-1 ring-white/[0.06] placeholder:text-neutral-500 focus:ring-white/25 focus:outline-none"
                  />
                  {testChange.trim() && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-xs text-neutral-500">Should improve</span>
                      {Object.values(ExperimentMetric).map((m) => (
                        <button
                          key={m}
                          type="button"
                          disabled={busy}
                          onClick={() => setTestMetric(m)}
                          className={`rounded-full px-2.5 py-1 text-xs ${m === testMetric ? "bg-white text-neutral-900" : "bg-white/[0.05] text-neutral-300 hover:bg-white/10"}`}
                        >
                          {METRIC_SHORT[m]}
                        </button>
                      ))}
                    </div>
                  )}
                </Step>

                <Step n={5} title="Video file" optional hint={fileHint}>
                  <label className="flex cursor-pointer items-center gap-3 text-sm">
                    <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${render ? "bg-white" : "bg-neutral-700"}`}>
                      <span className={`absolute top-0.5 size-4 rounded-full transition-all ${render ? "left-[18px] bg-neutral-900" : "left-0.5 bg-neutral-300"}`} />
                    </span>
                    <input type="checkbox" checked={render} disabled={busy} onChange={(e) => setRender(e.target.checked)} className="sr-only" />
                    {existing?.video && !existing.video.outdated ? "Render it again" : "Render the video now"}
                  </label>
                </Step>
              </div>

              <aside className="flex flex-col gap-3 border-t border-white/[0.06] bg-neutral-950/40 px-5 py-5 md:border-t-0 md:border-l">
                <div className="flex flex-col gap-3 md:sticky md:top-0">
                  <span className="text-xs text-neutral-500">Preview{active ? ` · ${PLATFORM_LABEL[active]}` : ""}</span>
                  <Preview cover={project.cover ?? null} copy={active ? copyOf(active) : null} handle={project.name} />
                </div>
              </aside>
            </div>

            <footer className="flex flex-wrap items-center gap-3 border-t border-white/[0.06] px-6 py-4">
              {stage === Stage.Rendering ? (
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
                    <div className="h-full bg-white transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                  <span className="text-xs text-neutral-400 tabular-nums">Rendering {Math.round(progress * 100)}%</span>
                  <button type="button" onClick={() => abort.current?.abort()} className="text-xs text-neutral-400 hover:text-white">
                    Cancel
                  </button>
                </div>
              ) : (
                <p className="min-w-0 flex-1 truncate text-sm text-neutral-400">
                  {error ? (
                    <span className="text-red-400">{error}</span>
                  ) : platforms.length ? (
                    <>
                      <span className="text-white">{platformList(platforms)}</span> · {formatWhen(when.toISOString())}
                    </>
                  ) : (
                    "Pick where it goes"
                  )}
                </p>
              )}
              <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || writing || existing === undefined || !platforms.length}
                onClick={() => void save()}
                className="rounded-lg bg-white px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
              >
                {stage === Stage.Uploading ? "Saving…" : existing ? "Save changes" : "Schedule"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/** Roughly how the post looks in the feed: the video's still, the caption cut short, the hashtags. */
function Preview({ cover, copy, handle }: { cover: string | null; copy: PostCopy | null; handle: string }) {
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
            {tags.length > 0 && <span className="text-sky-300"> {tags.map((t) => `#${t}`).join(" ")}</span>}
          </span>
        ) : (
          <span className="text-white/40">The caption shows here</span>
        )}
      </div>
    </div>
  );
}

/** Scheduled: what happens now, step by step. */
function Done({ post, onClose }: { post: ScheduledPost; onClose: () => void }) {
  const steps = [
    `On ${formatWhen(post.scheduledAt)} Motionily reminds you (keep it open, or check the calendar).`,
    post.video ? "Open the post: download the video and copy the text, one click each." : "Open the post to copy the text. For the file, come back here and turn on “Render the video now” (or use Export).",
    `Post it on ${platformList(post.platforms)} and press “Mark as posted”: with your accounts connected, its numbers show up in Stats.`,
  ];
  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
          <svg viewBox="0 0 16 16" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <p className="font-semibold">Scheduled for {formatWhen(post.scheduledAt)}</p>
          <p className="text-sm text-neutral-400">
            {platformList(post.platforms)} · {fromNow(new Date(post.scheduledAt))}
          </p>
        </div>
      </div>
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 text-sm text-neutral-300">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[11px] font-semibold">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-neutral-400 hover:text-white">
          Done
        </button>
        <a href={href({ name: RouteName.Calendar, postId: post.id })} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
          Open in calendar
        </a>
      </div>
    </div>
  );
}

