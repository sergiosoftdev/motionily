import { useEffect, useState } from "react";
import {
  channelDropoffs,
  DROPOFF_WINDOW,
  channelExperiments,
  channelInsights,
  channelLessons,
  type ChannelLesson,
  ExperimentMetric,
  channelSummary,
  EXPERIMENT_METRIC_LABEL,
  EXPERIMENT_STATUS_LABEL,
  ExperimentStatus,
  comparable,
  confidence,
  CONFIDENCE_LABEL,
  type Confidence,
  ageHours,
  isGrowing,
  compactCount,
  engagementRate,
  MIN_INSIGHT_VIDEOS,
  SOCIAL_LABEL,
  SOCIAL_PLATFORMS,
  watchShare,
  type ChannelSummary,
  type ChannelVideo,
  type ProjectListItem,
  type SocialAccount,
  type SocialPlatform,
} from "@motionily/protocol";
import { api } from "../api/client";
import { href, RouteName } from "../router";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { CoverImage, edited } from "../components/VideoCard";
import { PostedInbox } from "../social/Published";
import { SocialAccounts } from "../social/SocialAccounts";
import { Dropdown } from "../components/Dropdown";
import { useAgentName } from "../agentName";

const DAY = 86_400_000;

/** The periods the page compares: the last N days against the N before (null: everything). */
const PERIODS: { label: string; days: number | null }[] = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "All time", days: null },
];

const PLATFORM_COLOR: Record<SocialPlatform, string> = { instagram: "#e1306c", tiktok: "#25f4ee", youtube: "#ff3d3d" };

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const rate = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–");

const Sort = { Date: "date", Views: "views", Watched: "watched", Skip: "skip", Engagement: "engagement", Shares: "shares" } as const;
type Sort = (typeof Sort)[keyof typeof Sort];

const SORT_VALUE: Record<Sort, (r: ChannelVideo) => number | null> = {
  date: (r) => (r.publishedAt ? Date.parse(r.publishedAt) : null),
  views: (r) => r.metrics?.views ?? null,
  watched: watchShare,
  // Fewer skips first.
  skip: (r) => (r.metrics?.skipRate == null ? null : -r.metrics.skipRate),
  engagement: (r) => engagementRate(r.metrics),
  shares: (r) => r.metrics?.shares ?? null,
};

const inPeriod = (r: ChannelVideo, from: number, to: number) => {
  const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
  return t >= from && t < to;
};

/**
 * How the posted videos did across the account: totals against the period before, views per video over
 * time, what the best ones do differently, and every video with its numbers. Connecting the accounts and
 * linking videos posted outside the calendar happen here too.
 */
export function StatsScreen() {
  const agent = useAgentName();
  const [rows, setRows] = useState<ChannelVideo[] | null>(null);
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [videos, setVideos] = useState<ProjectListItem[]>([]);
  const [platform, setPlatform] = useState<SocialPlatform | null>(null);
  const [days, setDays] = useState<number | null>(30);
  const [sort, setSort] = useState<Sort>(Sort.Views);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      api.channel().then(setRows, (e: Error) => (setError(e.message), setRows([]))),
      api.socialAccounts().then((r) => setAccounts(r.accounts), () => setAccounts([])),
    ]);
  useEffect(() => {
    void load();
    api.projects().then(setVideos, () => undefined);
  }, []);

  const refresh = async () => {
    setSyncing(true);
    setError(null);
    try {
      const r = await api.syncSocial();
      if (r.errors.length) setError(r.errors.join(" · "));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const connected = (accounts ?? []).filter((a) => a.connected);
  const all = rows ?? [];
  const mine = platform ? all.filter((r) => r.platform === platform) : all;
  const now = Date.now();
  const current = days === null ? mine : mine.filter((r) => inPeriod(r, now - days * DAY, now + DAY));
  const previous = days === null ? null : mine.filter((r) => inPeriod(r, now - 2 * days * DAY, now - days * DAY));
  const summary = channelSummary(current);
  const before = previous?.length ? channelSummary(previous) : null;
  const updated = all.reduce<string | null>((a, r) => (r.metrics && (!a || r.metrics.fetchedAt > a) ? r.metrics.fetchedAt : a), null);
  const platforms = SOCIAL_PLATFORMS.filter((p) => all.some((r) => r.platform === p));

  return (
    <MotionilyLayout
      title="Stats"
      description="How your posted videos do on Instagram, TikTok and YouTube Shorts, and what the best ones have in common."
      actions={
        connected.length > 0 && (
          <div className="flex items-center gap-3">
            {updated && <span className="text-xs text-neutral-500">Updated {edited(updated)}</span>}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={syncing}
              className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-60"
            >
              {syncing ? "Refreshing…" : "Refresh numbers"}
            </button>
          </div>
        )
      }
    >
      {error && <p className="text-sm text-red-400">{error}</p>}
      {rows === null || accounts === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : !connected.length && !all.length ? (
        <section className="flex max-w-xl flex-col gap-3 rounded-2xl bg-neutral-900/60 p-5 ring-1 ring-white/[0.06]">
          <div>
            <h2 className="font-semibold">Connect your accounts</h2>
            <p className="text-sm text-neutral-500">
              Connect Instagram, TikTok or YouTube and every video you post is measured here: views, how much is watched, where viewers leave. {agent} reads it too, to plan the next one.
            </p>
          </div>
          <SocialAccounts />
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              options={[{ label: "All platforms", value: null }, ...platforms.map((p) => ({ label: SOCIAL_LABEL[p], value: p }))]}
              value={platform}
              onChange={setPlatform}
            />
            <Segmented options={PERIODS.map((p) => ({ label: p.label, value: p.days }))} value={days} onChange={setDays} />
          </div>
          <Kpis now={summary} before={before} />
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <ViewsChart rows={current} />
            <Insights rows={mine} agent={agent} />
          </section>
          <Dropoffs rows={mine} agent={agent} />
          <Lessons rows={mine} onChange={() => void load()} />
          <Experiments rows={mine} agent={agent} />
          <VideoTable rows={current} sort={sort} onSort={setSort} />
          {!all.length && <p className="text-sm text-neutral-500">No posted video is linked yet. Post from the calendar, or link the ones already on your accounts below.</p>}
        </>
      )}
      <PostedInbox videos={videos} />
    </MotionilyLayout>
  );
}

function Segmented<T extends string | number | null>({ options, value, onChange }: { options: { label: string; value: T }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg bg-neutral-900 p-0.5 ring-1 ring-white/[0.06]">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${o.value === value ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The headline numbers, each against the period before (green when it got better). */
function Kpis({ now, before }: { now: ChannelSummary; before: ChannelSummary | null }) {
  const cards: { label: string; value: string; delta: number | null; hint: string; lowerIsBetter?: boolean }[] = [
    { label: "Views", value: compactCount(now.views), delta: before ? change(now.views, before.views) : null, hint: `${now.videos} ${now.videos === 1 ? "video" : "videos"}` },
    { label: "Typical video", value: compactCount(now.medianViews), delta: before ? change(now.medianViews, before.medianViews) : null, hint: "median views" },
    { label: "Watched", value: pct(now.watch), delta: before ? diff(now.watch, before.watch) : null, hint: "of each video, on average" },
    { label: "Skip in 3 s", value: pct(now.skip), delta: before ? diff(now.skip, before.skip) : null, hint: "swiped before 3 s", lowerIsBetter: true },
    { label: "Engagement", value: rate(now.engagement), delta: before ? diff(now.engagement, before.engagement) : null, hint: `${compactCount(now.shares)} shares · ${compactCount(now.saves)} saves` },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((c) => (
        <div key={c.label} className="flex flex-col gap-1 rounded-2xl bg-neutral-900/60 p-4 ring-1 ring-white/[0.06]">
          <span className="text-xs text-neutral-500">{c.label}</span>
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">{c.value}</span>
            {c.delta !== null && Math.abs(c.delta) >= 0.005 && <Delta value={c.delta} good={c.lowerIsBetter ? c.delta < 0 : c.delta > 0} />}
          </span>
          <span className="truncate text-[11px] text-neutral-600">{c.hint}</span>
        </div>
      ))}
    </section>
  );
}

/** Relative change of a count; null when either side is missing or the base is 0. */
const change = (a: number | null, b: number | null) => (a === null || !b ? null : (a - b) / b);
/** Change of a share, in points. */
const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

function Delta({ value, good }: { value: number; good: boolean }) {
  return (
    <span className={`text-xs font-medium tabular-nums ${good ? "text-emerald-400" : "text-rose-400"}`} title="Against the period before">
      {value > 0 ? "▲" : "▼"} {value >= 1 ? `${+(1 + value).toFixed(1)}×` : `${Math.round(Math.abs(value) * 100)}%`}
    </span>
  );
}

/** Each video's views as a bar, in the order they were posted, colored by platform. */
function ViewsChart({ rows }: { rows: ChannelVideo[] }) {
  const bars = rows.filter((r) => r.metrics?.views != null).sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
  const max = Math.max(1, ...bars.map((r) => r.metrics!.views!));
  return (
    <div className="flex min-h-64 flex-col gap-3 rounded-2xl bg-neutral-900/60 p-4 ring-1 ring-white/[0.06]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Views per video</h2>
        <span className="flex gap-3 text-[11px] text-neutral-500">
          {SOCIAL_PLATFORMS.filter((p) => bars.some((r) => r.platform === p)).map((p) => (
            <span key={p} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
              {SOCIAL_LABEL[p]}
            </span>
          ))}
        </span>
      </div>
      {bars.length ? (
        <div className="flex flex-1 items-stretch justify-center gap-2 pt-2">
          {bars.map((r) => (
            <a
              key={`${r.postId}:${r.platform}`}
              href={href({ name: RouteName.Editor, id: r.projectId })}
              title={`${r.name} · ${SOCIAL_LABEL[r.platform]} · ${when(r.publishedAt)} · ${compactCount(r.metrics!.views)} views`}
              className="group flex max-w-16 min-w-2 flex-1 flex-col items-center gap-1.5"
            >
              <span className="flex w-full flex-1 flex-col items-center justify-end gap-1 border-b border-white/10">
                <span className="text-[10px] text-neutral-500 tabular-nums group-hover:text-white">{compactCount(r.metrics!.views)}</span>
                <span className={`w-full rounded-t transition group-hover:opacity-100 ${isGrowing(r) ? "opacity-35" : "opacity-80"}`} style={{ height: `${Math.max(1, (r.metrics!.views! / max) * 85)}%`, background: PLATFORM_COLOR[r.platform] }} />
              </span>
              <span className="text-[10px] whitespace-nowrap text-neutral-600">{when(r.publishedAt)}</span>
            </a>
          ))}
        </div>
      ) : (
        <p className="m-auto text-sm text-neutral-500">No measured video in this period.</p>
      )}
    </div>
  );
}

const CONFIDENCE_STYLE: Record<Confidence, string> = { early: "bg-amber-400/10 text-amber-300", fair: "bg-sky-400/10 text-sky-300", solid: "bg-emerald-400/10 text-emerald-300" };

/** What the best videos do differently, how sure that is, and the video to learn from. */
const STATUS_STYLE: Record<ExperimentStatus, string> = {
  waiting: "bg-amber-400/10 text-amber-300",
  worked: "bg-emerald-400/10 text-emerald-300",
  failed: "bg-rose-400/10 text-rose-300",
  unclear: "bg-white/[0.06] text-neutral-300",
};
const STATUS_ICON: Record<ExperimentStatus, string> = { waiting: "◷", worked: "✓", failed: "✕", unclear: "≈" };

/** What each video already posted teaches, and a way to say what it was testing (judged right away). */
function Lessons({ rows, onChange }: { rows: ChannelVideo[]; onChange: () => void }) {
  const lessons = channelLessons(rows).filter((l) => !l.tested);
  const [open, setOpen] = useState<string | null>(null);
  const [change, setChange] = useState("");
  const [metric, setMetric] = useState<ExperimentMetric>(ExperimentMetric.Watch);
  const [busy, setBusy] = useState(false);
  if (!lessons.length) return null;
  const start = (l: ChannelLesson) => {
    setOpen(l.projectId);
    setChange("");
    setMetric(l.better[0]?.metric ?? l.worse[0]?.metric ?? ExperimentMetric.Watch);
  };
  const save = async (projectId: string) => {
    if (change.trim().length < 3) return;
    setBusy(true);
    try {
      await api.setExperiment(projectId, { change: change.trim(), metric });
      setOpen(null);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">What your videos teach</h2>
        <p className="text-sm text-neutral-500">Videos already posted, against your usual numbers. Say what one was trying and it becomes an experiment, judged right away.</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {lessons.map((l) => (
          <div key={l.projectId} className="flex flex-col gap-2 rounded-2xl bg-neutral-900/60 p-4 ring-1 ring-white/[0.06]">
            <a href={href({ name: RouteName.Editor, id: l.projectId })} className="text-sm font-medium hover:underline">
              {l.name}
            </a>
            <div className="flex flex-wrap gap-1.5">
              {l.better.map((b) => (
                <span key={b.metric} className="rounded-md bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300">
                  ▲ {b.text}
                </span>
              ))}
              {l.worse.map((w) => (
                <span key={w.metric} className="rounded-md bg-rose-400/10 px-2 py-0.5 text-[11px] text-rose-300">
                  ▼ {w.text}
                </span>
              ))}
            </div>
            {(l.hook || l.traits.length > 0) && (
              <ul className="flex flex-col gap-0.5 text-xs text-neutral-400">
                {l.hook && <li>Opens with “{l.hook}”</li>}
                {l.traits.map((t) => (
                  <li key={t}>{t[0]!.toUpperCase() + t.slice(1)}</li>
                ))}
              </ul>
            )}
            {open === l.projectId ? (
              <div className="mt-1 flex flex-col gap-2">
                <input
                  autoFocus
                  value={change}
                  onChange={(e) => setChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void save(l.projectId)}
                  maxLength={200}
                  placeholder="What was it trying? e.g. A 4-word claim as the hook"
                  className="rounded-lg bg-neutral-800 px-3 py-2 text-sm ring-1 ring-white/[0.06] placeholder:text-neutral-500 focus:ring-white/25 focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <Dropdown
                    size="sm"
                    className="w-56"
                    label="Measured by"
                    value={metric}
                    onChange={setMetric}
                    options={Object.values(ExperimentMetric).map((m) => ({ value: m, label: EXPERIMENT_METRIC_LABEL[m] }))}
                  />
                  <button type="button" disabled={busy || change.trim().length < 3} onClick={() => void save(l.projectId)} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50">
                    Save
                  </button>
                  <button type="button" onClick={() => setOpen(null)} className="text-xs text-neutral-500 hover:text-white">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => start(l)} className="mt-1 self-start text-xs font-medium text-neutral-300 hover:text-white">
                + What was it testing?
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** What each video tested and how it turned out against the channel's usual. */
/** Where viewers leave across the channel, with what was on screen then (YouTube retention curves). */
function Dropoffs({ rows, agent }: { rows: ChannelVideo[]; agent: string }) {
  const d = channelDropoffs(rows);
  const top = Math.max(0.01, ...d.patterns.map((p) => Math.max(p.leave, p.normal)));
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Where viewers leave</h2>
        <p className="text-sm text-neutral-500">
          What was on screen each time people left, across all your videos, against how many usually leave at that point. {agent} avoids what loses them and repeats what holds them.
        </p>
      </div>
      {!d.videos ? (
        <p className="rounded-2xl bg-neutral-900/40 p-4 text-sm text-neutral-500 ring-1 ring-white/[0.06]">
          Only YouTube says second by second when viewers leave. Post on YouTube Shorts (and connect it in Settings): a day or two after, the moments that lose people show up here.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex flex-col gap-3 rounded-2xl bg-neutral-900/60 p-4 ring-1 ring-white/[0.06]">
            {d.patterns.length ? (
              <ul className="flex flex-col gap-4">
                {d.patterns.map((p) => {
                  const bad = p.leave > p.normal;
                  return (
                    <li key={p.kind} className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-sm font-medium">
                          {p.kind === "still" ? `After ${p.label}` : `When ${p.label} appears`}
                          <span className={`ml-2 rounded-md px-1.5 py-0.5 text-[10px] ${bad ? "bg-rose-400/15 text-rose-200" : "bg-emerald-400/15 text-emerald-200"}`}>{bad ? "Loses viewers" : "Holds them"}</span>
                        </span>
                        <span className="text-[11px] text-neutral-500">
                          {p.moments} times in {p.videos} videos
                        </span>
                      </div>
                      <Bar label={`${pct(p.leave)} leave in the next ${DROPOFF_WINDOW} s`} value={p.leave / top} tone={bad ? "bg-rose-400/70" : "bg-emerald-400/70"} />
                      <Bar label={`${pct(p.normal)} usually leave there`} value={p.normal / top} tone="bg-white/20" />
                      {p.examples.length > 0 && <span className="text-[11px] leading-relaxed text-neutral-500">e.g. {p.examples.join(" · ")}</span>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm leading-relaxed text-neutral-500">
                {d.videos} {d.videos === 1 ? "video has" : "videos have"} a retention curve. A pattern shows once the same kind of moment (a chart, a clip, a pause) comes up 3 times in 2 videos and clearly changes how many leave.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 rounded-2xl bg-neutral-900/60 p-4 ring-1 ring-white/[0.06]">
            <h3 className="text-sm font-semibold">Steepest falls</h3>
            {d.moments.length ? (
              d.moments.map((m) => (
                <a key={`${m.projectId}-${m.platform}-${m.t}`} href={href({ name: RouteName.Editor, id: m.projectId })} className="flex flex-col gap-0.5 rounded-xl p-2 -mx-2 hover:bg-white/[0.04]">
                  <span className="text-sm">
                    <span className="text-rose-200">{pct(m.share)} left</span> · {m.name} at {Math.round(m.t)} s
                  </span>
                  <span className="text-[11px] leading-snug text-neutral-500">{m.onScreen.length ? `On screen: ${m.onScreen.join(", ")}` : "Nothing new on screen"}</span>
                </a>
              ))
            ) : (
              <p className="text-xs text-neutral-500">No sharp fall: viewers leave at a steady pace.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Bar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
      </div>
      <span className="w-32 shrink-0 text-[11px] text-neutral-400 sm:w-44">{label}</span>
    </div>
  );
}

function Experiments({ rows, agent }: { rows: ChannelVideo[]; agent: string }) {
  const results = channelExperiments(rows);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Experiments</h2>
        <p className="text-sm text-neutral-500">
          Each video changes one thing (the hook, the length, the pace…). Three days after it's posted it's judged against your usual numbers, and {agent} builds the next video on what worked.
        </p>
      </div>
      {results.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {results.map((x) => (
            <a
              key={x.projectId}
              href={href({ name: RouteName.Editor, id: x.projectId })}
              className="flex flex-col gap-2 rounded-2xl bg-neutral-900/60 p-4 ring-1 ring-white/[0.06] transition hover:ring-white/15"
            >
              <span className={`flex items-center gap-1.5 self-start rounded-md px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[x.status]}`}>
                <span aria-hidden>{STATUS_ICON[x.status]}</span>
                {EXPERIMENT_STATUS_LABEL[x.status]}
              </span>
              <span className="text-sm leading-snug font-medium">{x.experiment.change}</span>
              <span className="text-xs text-neutral-500">
                {x.name} · {EXPERIMENT_METRIC_LABEL[x.experiment.metric]}
              </span>
              <span className="mt-auto text-xs text-neutral-300">
                {x.status === ExperimentStatus.Waiting
                  ? x.readyAt
                    ? `Judged on ${new Date(x.readyAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
                    : "Judged 3 days after it's posted"
                  : x.value && x.usual
                    ? `${x.value} · usually ${x.usual}`
                    : "Not enough other videos to compare yet"}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p className="rounded-2xl bg-neutral-900/40 p-4 text-sm text-neutral-500 ring-1 ring-white/[0.06]">
          No experiments yet. {agent} records what a video tests when it builds it, or set it yourself when you schedule a video (“What does this video test?”).
        </p>
      )}
    </section>
  );
}

function Insights({ rows, agent }: { rows: ChannelVideo[]; agent: string }) {
  const ranked = comparable(rows);
  const insights = channelInsights(rows);
  const level = confidence(ranked.length);
  const best = ranked[0];
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-neutral-900/60 p-4 ring-1 ring-white/[0.06]">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-sm font-semibold">What your best videos do</h2>
        <span className={`self-start rounded-md px-2 py-0.5 text-[10px] leading-snug font-medium ${CONFIDENCE_STYLE[level]}`}>
          {ranked.length} {ranked.length === 1 ? "video" : "videos"} older than 3 days · {CONFIDENCE_LABEL[level]}
        </span>
      </div>
      {best?.features?.hook && (
        <div className="rounded-xl bg-white/[0.04] p-3">
          <span className="text-[11px] text-neutral-500">Learn from “{best.name}”, which opens with</span>
          <p className="mt-0.5 text-sm leading-snug">“{best.features.hook}”</p>
        </div>
      )}
      {insights.length ? (
        <ul className="flex flex-col gap-3">
          {insights.map((i) => (
            <li key={i.title} className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{i.title}</span>
              <span className="text-xs leading-relaxed text-neutral-400">{i.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs leading-relaxed text-neutral-500">
          {ranked.length < MIN_INSIGHT_VIDEOS
            ? `Once ${MIN_INSIGHT_VIDEOS} videos are 3 days old (${ranked.length} so far), this compares your best ones with the rest: hook, pace, length, voice, platform.`
            : "Your best videos and the rest hook, hold and run alike: no difference big enough to act on yet."}
        </p>
      )}
      <p className="mt-auto border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed text-neutral-500">
        {agent} gets this every time it opens a video, and plans from your best one. Videos under 3 days are still collecting views: they show here but aren't compared.
      </p>
    </div>
  );
}

const COLUMNS: { sort: Sort; label: string }[] = [
  { sort: Sort.Views, label: "Views" },
  { sort: Sort.Watched, label: "Watched" },
  { sort: Sort.Skip, label: "Skip 3 s" },
  { sort: Sort.Engagement, label: "Engagement" },
  { sort: Sort.Shares, label: "Shares" },
];

/** Every posted copy with its numbers; a row opens the video in the editor. */
function VideoTable({ rows, sort, onSort }: { rows: ChannelVideo[]; sort: Sort; onSort: (s: Sort) => void }) {
  const key = SORT_VALUE[sort];
  const sorted = [...rows].sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity));
  const top = Math.max(1, ...rows.map((r) => r.metrics?.views ?? 0));
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Videos</h2>
      <div className="overflow-x-auto rounded-2xl ring-1 ring-white/[0.06]">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-neutral-900/80 text-left text-xs text-neutral-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">
                <SortButton active={sort === Sort.Date} onClick={() => onSort(Sort.Date)}>
                  Video
                </SortButton>
              </th>
              {COLUMNS.map((c) => (
                <th key={c.sort} className="px-3 py-2.5 text-right font-medium">
                  <SortButton active={sort === c.sort} onClick={() => onSort(c.sort)}>
                    {c.label}
                  </SortButton>
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {sorted.map((r) => {
              const m = r.metrics;
              const w = watchShare(r);
              return (
                <tr key={`${r.postId}:${r.platform}`} className="group hover:bg-neutral-900/60">
                  <td className="px-4 py-2">
                    <a href={href({ name: RouteName.Editor, id: r.projectId })} className="flex items-center gap-3">
                      <span className="block h-12 w-9 shrink-0 overflow-hidden rounded-md ring-1 ring-white/10">
                        <CoverImage cover={r.cover} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium group-hover:underline">{r.name}</span>
                        <span className="flex items-center gap-1.5 text-xs text-neutral-500">
                          <span className="size-1.5 rounded-full" style={{ background: PLATFORM_COLOR[r.platform] }} />
                          {SOCIAL_LABEL[r.platform]} · {when(r.publishedAt)}
                          {isGrowing(r) && (
                            <span className="rounded-full bg-amber-400/10 px-1.5 py-px text-[10px] font-medium text-amber-300" title="Under 3 days old: still collecting views, not compared yet">
                              Growing · {Math.max(1, Math.round(ageHours(r)))} h
                            </span>
                          )}
                        </span>
                      </span>
                    </a>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="flex items-center justify-end gap-2">
                      <span className="hidden h-1 w-16 overflow-hidden rounded-full bg-white/5 md:block">
                        <span className="block h-full rounded-full bg-white/50" style={{ width: `${((m?.views ?? 0) / top) * 100}%` }} />
                      </span>
                      {m ? compactCount(m.views) : <span className="text-neutral-600">pending</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(w)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(m?.skipRate ?? null)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{rate(engagementRate(m))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{compactCount(m?.shares ?? null)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer" title={`Open on ${SOCIAL_LABEL[r.platform]}`} className="text-neutral-500 hover:text-white">
                        ↗
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SortButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`whitespace-nowrap ${active ? "text-white" : "hover:text-neutral-300"}`}>
      {children}
      {active && " ↓"}
    </button>
  );
}
