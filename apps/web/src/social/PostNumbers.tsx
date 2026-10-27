import { useState } from "react";
import { compactCount, SOCIAL_LABEL, type PostMetrics, type SocialPlatform } from "@motionily/protocol";
import { api, type ScheduledPost } from "../api/client";
import { AttentionCurve } from "../components/AttentionCurve";

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The numbers a posted video got on one platform, or a field to paste its link when it was not matched. */
export function PostNumbers({ post, platform, onChange }: { post: ScheduledPost; platform: SocialPlatform; onChange: (p: ScheduledPost) => void }) {
  const link = post.links.find((l) => l.platform === platform);
  const m = post.metrics.find((x) => x.platform === platform);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<ScheduledPost>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!link)
    return (
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api.linkPost(post.id, platform, url));
        }}
      >
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={`Link to the ${SOCIAL_LABEL[platform]} video`}
            spellCheck={false}
            aria-label={`${SOCIAL_LABEL[platform]} link`}
            className="min-w-0 flex-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs placeholder:text-neutral-600"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="shrink-0 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy ? "Linking…" : "Link"}
          </button>
        </div>
        <p className="text-[11px] text-neutral-600">Found by itself once the account is connected in Settings; paste the link if it was not.</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </form>
    );

  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-neutral-900/60 px-3 py-2">
      {m ? <Numbers m={m} /> : <p className="text-xs text-neutral-500">Linked; the numbers come with the next refresh.</p>}
      <div className="flex items-center gap-3 text-[11px] text-neutral-500">
        {link.url && (
          <a href={link.url} target="_blank" rel="noreferrer" className="hover:text-white">
            Open the post
          </a>
        )}
        {m && (
          <span>
            measured{" "}
            {new Date(m.fetchedAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        )}
        <button type="button" disabled={busy} onClick={() => void act(() => api.unlinkPost(post.id, platform))} className="ml-auto hover:text-white">
          Not this video
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

function Numbers({ m }: { m: PostMetrics }) {
  const stats: [string, number | null][] = [
    ["views", m.views],
    ["likes", m.likes],
    ["comments", m.comments],
    ["shares", m.shares],
    ["saves", m.saves],
  ];
  const watch = [
    m.avgWatch !== null && `average view ${m.avgWatch.toFixed(1)} s${m.duration ? ` of ${Math.round(m.duration)} s` : ""}`,
    m.skipRate !== null && `${pct(m.skipRate)} skipped in the first 3 s`,
  ].filter(Boolean);
  return (
    <>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {stats
          .filter(([, v]) => v !== null)
          .map(([k, v]) => (
            <span key={k} className="text-xs text-neutral-400">
              <span className="text-sm font-semibold text-white tabular-nums">{compactCount(v)}</span> {k}
            </span>
          ))}
      </div>
      {watch.length > 0 && <p className="text-xs text-neutral-400">{watch.join(" · ")}</p>}
      {m.retention && (
        <div className="flex items-center gap-2" title="Share of viewers still watching along the video">
          <span className="text-[11px] text-neutral-500">Retention</span>
          <AttentionCurve values={m.retention.map((v) => Math.min(1, v))} className="h-6 min-w-0 flex-1 text-sky-300" />
          <span className="text-[11px] text-neutral-500 tabular-nums">{pct(m.retention.at(-1)!)}</span>
        </div>
      )}
    </>
  );
}
