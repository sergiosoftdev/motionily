import { useEffect, useMemo, useRef, useState } from "react";
import { VoiceModel, type Voice } from "@motionily/protocol";
import { api, type ElevenLabsStatus } from "../api/client";

const CHOICE_KEY = "motionily.voice";
/** Show a search box once the account has more voices than this. */
const SEARCH_FROM = 8;

export const MODEL_LABEL: Record<VoiceModel, string> = {
  [VoiceModel.V4]: "Eleven v4 · most expressive",
  [VoiceModel.V3]: "Eleven v3",
  [VoiceModel.MultilingualV2]: "Multilingual v2 · steady",
  [VoiceModel.FlashV25]: "Flash v2.5 · fast, half the credits",
};

type Choice = { voiceId: string | null; model: VoiceModel };

function loadChoice(): Choice {
  try {
    const raw = localStorage.getItem(CHOICE_KEY);
    if (raw) return { voiceId: null, model: VoiceModel.V4, ...(JSON.parse(raw) as Partial<Choice>) };
  } catch {
    // Storage unavailable: defaults.
  }
  return { voiceId: null, model: VoiceModel.V4 };
}

function saveChoice(c: Choice) {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(c));
  } catch {
    // Not critical: the next time starts on the default voice.
  }
}

/** The user's ElevenLabs connection, loaded once. */
export function useElevenLabs() {
  const [status, setStatus] = useState<ElevenLabsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.elevenLabs().then(setStatus, (e: Error) => setError(e.message));
  }, []);
  const run = async (fn: () => Promise<ElevenLabsStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return {
    status,
    error,
    busy,
    connect: (key: string) => run(() => api.connectElevenLabs(key)),
    disconnect: () => run(() => api.disconnectElevenLabs()),
  };
}

export type ElevenLabsConnection = ReturnType<typeof useElevenLabs>;

/** Paste (or remove) the ElevenLabs API key. */
export function ElevenLabsKeyForm({ el }: { el: ElevenLabsConnection }) {
  const [key, setKey] = useState("");
  if (el.status?.connected)
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 text-sm text-neutral-300">
          <span className="size-2 rounded-full bg-emerald-400" /> Connected · key ending in <code className="text-white">{el.status.hint}</code>
        </p>
        <button type="button" disabled={el.busy} onClick={() => void el.disconnect()} className="self-start text-xs text-neutral-500 hover:text-white disabled:opacity-50">
          Remove the key
        </button>
        {el.error && <p className="text-xs text-red-400">{el.error}</p>}
      </div>
    );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) void el.connect(key).then(() => setKey(""));
      }}
    >
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Your ElevenLabs API key (sk_…)"
          autoComplete="off"
          spellCheck={false}
          aria-label="ElevenLabs API key"
          className="min-w-0 flex-1 rounded-lg bg-neutral-900 px-3 py-2 font-mono text-sm placeholder:font-sans placeholder:text-neutral-600 focus:ring-1 focus:ring-white/30 focus:outline-none"
        />
        <button type="submit" disabled={el.busy || !key.trim()} className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-40">
          {el.busy ? "Checking…" : "Connect"}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-neutral-500">
        Create one in ElevenLabs under Developers › API keys, with Text to Speech and Voices access. It is stored encrypted, only ever sent to ElevenLabs, and voices use your
        ElevenLabs credits.
      </p>
      {el.error && <p className="text-xs text-red-400">{el.error}</p>}
    </form>
  );
}

/**
 * Pick one of the user's ElevenLabs voices (with previews) and a model, then generate. Without
 * a key yet, it asks for one first.
 */
export function VoicePicker({
  cta,
  busy,
  onGenerate,
  compact = false,
}: {
  cta: string;
  busy: boolean;
  onGenerate: (voice: Voice, model: VoiceModel) => void;
  compact?: boolean;
}) {
  const el = useElevenLabs();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>(loadChoice);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const connected = !!el.status?.connected;

  useEffect(() => {
    if (!connected) return;
    setError(null);
    api.voices().then((v) => {
      setVoices(v);
      setChoice((c) => (v.some((x) => x.id === c.voiceId) ? c : { ...c, voiceId: v[0]?.id ?? null }));
    }, (e: Error) => setError(e.message));
  }, [connected]);

  useEffect(() => () => player.current?.pause(), []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (voices ?? []).filter((v) => !q || `${v.name} ${Object.values(v.labels).join(" ")}`.toLowerCase().includes(q));
  }, [voices, query]);

  const choose = (c: Choice) => {
    setChoice(c);
    saveChoice(c);
  };
  const preview = (v: Voice) => {
    player.current?.pause();
    if (playing === v.id || !v.previewUrl) return setPlaying(null);
    const audio = new Audio(v.previewUrl);
    audio.onended = () => setPlaying(null);
    player.current = audio;
    setPlaying(v.id);
    void audio.play().catch(() => setPlaying(null));
  };

  if (!el.status) return <p className="text-sm text-neutral-500">{el.error ?? "Checking ElevenLabs…"}</p>;
  if (!connected)
    return (
      <div className="flex flex-col gap-3">
        <p className={compact ? "text-xs text-neutral-400" : "text-sm text-neutral-300"}>Connect your ElevenLabs account to read the script with any of your voices.</p>
        <ElevenLabsKeyForm el={el} />
      </div>
    );

  const selected = voices?.find((v) => v.id === choice.voiceId) ?? null;
  return (
    <div className="flex flex-col gap-3">
      {(voices?.length ?? 0) > SEARCH_FROM && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search voices"
          aria-label="Search voices"
          className="rounded-lg bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-600 focus:ring-1 focus:ring-white/30 focus:outline-none"
        />
      )}
      {!voices && !error && <p className="text-sm text-neutral-500">Loading your voices…</p>}
      {voices && voices.length === 0 && <p className="text-sm text-neutral-500">Your ElevenLabs account has no voices yet. Add one in ElevenLabs and come back.</p>}
      <div className={`flex flex-col gap-1 overflow-y-auto ${compact ? "max-h-56" : "max-h-72"}`} role="radiogroup" aria-label="Voices">
        {shown.map((v) => {
          const on = v.id === choice.voiceId;
          const tags = [v.labels.accent, v.labels.gender, v.labels.age, v.labels.descriptive ?? v.labels.description].filter(Boolean).join(" · ");
          return (
            <div
              key={v.id}
              role="radio"
              aria-checked={on}
              tabIndex={0}
              onClick={() => choose({ ...choice, voiceId: v.id })}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && choose({ ...choice, voiceId: v.id })}
              className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ${on ? "bg-white/10 ring-1 ring-white/30" : "hover:bg-white/5"}`}
            >
              <button
                type="button"
                disabled={!v.previewUrl}
                onClick={(e) => {
                  e.stopPropagation();
                  preview(v);
                }}
                aria-label={playing === v.id ? `Stop ${v.name}` : `Listen to ${v.name}`}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30"
              >
                <svg viewBox="0 0 16 16" className="size-3 fill-current" aria-hidden>
                  {playing === v.id ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M5 3v10l8-5z" />}
                </svg>
              </button>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{v.name}</span>
                {tags && <span className="truncate text-xs text-neutral-500">{tags}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <div className={`flex gap-2 ${compact ? "flex-col" : "flex-wrap items-center"}`}>
        <select
          value={choice.model}
          onChange={(e) => choose({ ...choice, model: e.target.value as VoiceModel })}
          aria-label="ElevenLabs model"
          className="rounded-lg bg-neutral-900 px-3 py-2 text-sm focus:outline-none"
        >
          {Object.values(VoiceModel).map((m) => (
            <option key={m} value={m}>
              {MODEL_LABEL[m]}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !selected}
          onClick={() => selected && onGenerate(selected, choice.model)}
          className={`rounded-lg bg-white font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-40 ${compact ? "px-3 py-2 text-sm" : "px-5 py-2.5 text-sm"}`}
        >
          {busy ? "Generating the voice…" : cta}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
