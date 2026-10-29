import { useEffect, useState } from "react";
import { SOCIAL_LABEL, type AutoLinkResult, type LikelySource, type ProjectListItem, type PublishedVideo } from "@motionily/protocol";
import { api } from "../api/client";
import { Dropdown } from "../components/Dropdown";
import { CoverImage, edited } from "../components/VideoCard";

/** Videos the inbox shows before "show all". */
const INBOX_SHOWN = 8;

const firstLine = (caption: string) => caption.split("\n").find((l) => l.trim())?.trim() || "No caption";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/** The connected accounts' latest videos, or why there are none (no account yet, or the platform said no). */
function usePublished() {
  const [videos, setVideos] = useState<PublishedVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.published().then(setVideos, (e: Error) => (setError(e.message), setVideos([])));
  useEffect(() => {
    void load();
  }, []);
  return { videos, error, reload: load };
}

function Thumbnail({ v, className = "" }: { v: PublishedVideo; className?: string }) {
  return (
    <span className={`relative block overflow-hidden rounded-lg bg-neutral-900 ${className}`}>
      {v.thumbnail ? (
        <img src={v.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[11px] text-neutral-600">{SOCIAL_LABEL[v.platform]}</span>
      )}
      <span className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">{SOCIAL_LABEL[v.platform]}</span>
    </span>
  );
}

/**
 * Home's "Posted on your accounts": videos on Instagram, TikTok or YouTube that are not linked to a video
 * made here yet (posted outside the calendar), each with a picker to link it. Hidden with nothing to link.
 */
export function PostedInbox({ videos: mine, onLinked }: { videos: ProjectListItem[]; onLinked?: () => void }) {
  const { videos, reload } = usePublished();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState<AutoLinkResult | null>(null);
  const loose = (videos ?? []).filter((v) => !v.linked);
  if ((!loose.length && !auto?.linked.length) || !mine.length) return null;
  const likely = new Map((auto?.unsure ?? []).map((u) => [`${u.platform}:${u.videoId}`, u.likely] as const));

  const linkAll = async () => {
    setBusy("auto");
    setError(null);
    try {
      const r = await api.autoLinkPublished();
      setAuto(r);
      if (r.errors.length) setError(r.errors.join(" · "));
      await reload();
      if (r.linked.length) onLinked?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const link = async (v: PublishedVideo, projectId: string) => {
    setBusy(v.id);
    setError(null);
    try {
      const r = await api.linkPublished(projectId, v.platform, v.id);
      if (r.errors.length) setError(r.errors.join(" · "));
      await reload();
      onLinked?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Posted on your accounts</h2>
          <p className="text-sm text-neutral-500">
            {loose.length
              ? "Not linked to a video here yet. Link each to the video it came from: its numbers show in the editor and the agent learns from them."
              : "Everything posted is linked to the video it came from."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {loose.length > INBOX_SHOWN && (
            <button type="button" onClick={() => setAll((a) => !a)} className="text-sm text-neutral-400 hover:text-white">
              {all ? "Show fewer" : `Show all ${loose.length}`}
            </button>
          )}
          {loose.length > 0 && (
            <button
              type="button"
              onClick={() => void linkAll()}
              disabled={busy !== null}
              title="Finds the video each one came from by its length, the words in its caption and when it went out"
              className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-60"
            >
              {busy === "auto" ? "Linking…" : "Link automatically"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {auto && <AutoLinkSummary result={auto} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(all ? loose : loose.slice(0, INBOX_SHOWN)).map((v) => (
          <div key={`${v.platform}:${v.id}`} className="flex gap-3 rounded-xl bg-neutral-900/60 p-2.5 ring-1 ring-white/[0.06]">
            <Thumbnail v={v} className="aspect-[9/16] w-16 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <a href={v.url ?? undefined} target="_blank" rel="noreferrer" className="line-clamp-2 text-sm leading-snug font-medium hover:underline">
                {firstLine(v.caption)}
              </a>
              <span className="text-[11px] text-neutral-500">{when(v.publishedAt)}</span>
              <Dropdown
                size="sm"
                className="mt-auto"
                label="Link to a video"
                placeholder={busy === v.id ? "Linking…" : "Link to a video…"}
                disabled={busy === v.id}
                value={null}
                onChange={(id) => void link(v, id)}
                options={byLikely(mine, likely.get(`${v.platform}:${v.id}`)).map(({ p, guess }) => ({
                  value: p._id,
                  label: p.name,
                  hint: guess ? `Likely: ${guess.why.join(", ") || "closest match"}` : `Edited ${edited(p.updatedAt)}`,
                  lead: (
                    <span className="block h-8 w-6 shrink-0 overflow-hidden rounded ring-1 ring-white/10">
                      <CoverImage cover={p.cover} />
                    </span>
                  ),
                }))}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The user's videos with the likeliest sources of a posted one first. */
function byLikely(mine: ProjectListItem[], likely: LikelySource[] | undefined) {
  const guess = new Map((likely ?? []).map((l, i) => [l.projectId, { ...l, i }]));
  return mine.map((p) => ({ p, guess: guess.get(p._id) })).sort((a, b) => (a.guess?.i ?? Infinity) - (b.guess?.i ?? Infinity));
}

/** What "Link automatically" did: each link and why, and how many were too unclear to link. */
function AutoLinkSummary({ result }: { result: AutoLinkResult }) {
  const { linked, unsure } = result;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-emerald-400/[0.06] p-3 text-sm ring-1 ring-emerald-400/20">
      <span className="font-medium">
        {linked.length ? `Linked ${linked.length} ${linked.length === 1 ? "video" : "videos"}` : "Nothing was clear enough to link"}
        {unsure.length > 0 && <span className="font-normal text-neutral-400"> · {unsure.length} unclear: pick them below (the likeliest come first)</span>}
      </span>
      {linked.map((l) => (
        <span key={`${l.platform}:${l.videoId}`} className="text-xs text-neutral-400">
          {SOCIAL_LABEL[l.platform]} “{firstLine(l.caption)}” → <span className="text-neutral-200">{l.name}</span>
          {l.why.length > 0 && ` (${l.why.join(", ")})`}
        </span>
      ))}
    </div>
  );
}

/** The editor's picker: one of the accounts' videos to link to this video (it was posted outside the calendar). */
export function LinkPublishedDialog({ projectId, onClose, onLinked }: { projectId: string; onClose: () => void; onLinked: () => void }) {
  const { videos, error: loadError } = usePublished();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const link = async (v: PublishedVideo) => {
    setBusy(v.id);
    setError(null);
    try {
      const r = await api.linkPublished(projectId, v.platform, v.id);
      if (r.errors.length) setError(r.errors.join(" · "));
      else onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div role="dialog" aria-label="Link a posted video" className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-4 rounded-2xl bg-neutral-900 p-5 ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <h2 className="font-semibold">Link a posted video</h2>
            <p className="text-sm text-neutral-500">Posted this video yourself? Pick it: its views and where viewers leave show under the timeline, and the agent reads them.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white">
            ✕
          </button>
        </div>
        {(error || loadError) && <p className="text-sm text-red-400">{error ?? loadError}</p>}
        {videos === null ? (
          <p className="text-sm text-neutral-500">Loading your accounts…</p>
        ) : !videos.length ? (
          <p className="text-sm text-neutral-500">
            No videos found. Connect Instagram, TikTok or YouTube in{" "}
            <a href="#/settings" className="text-white underline">
              Settings › Social accounts
            </a>
            .
          </p>
        ) : (
          <div className="grid min-h-0 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
            {videos.map((v) => {
              const here = v.linked?.projectId === projectId;
              return (
                <button
                  key={`${v.platform}:${v.id}`}
                  type="button"
                  disabled={busy !== null || here}
                  onClick={() => void link(v)}
                  title={v.linked && !here ? `Linked to ${v.linked.name}: picking it moves it here` : undefined}
                  className="flex flex-col gap-1.5 rounded-xl p-1.5 text-left hover:bg-white/5 disabled:opacity-60"
                >
                  <Thumbnail v={v} className="aspect-[9/16] w-full" />
                  <span className="line-clamp-2 text-xs leading-snug">{firstLine(v.caption)}</span>
                  <span className="text-[10px] text-neutral-500">{busy === v.id ? "Linking…" : here ? "Linked to this video" : v.linked ? `Linked to ${v.linked.name}` : when(v.publishedAt)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
