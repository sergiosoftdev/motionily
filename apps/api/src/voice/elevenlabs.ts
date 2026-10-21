/**
 * ElevenLabs over plain HTTP with the user's own API key (each user pays their own account):
 * list their voices, and read a script aloud with the timing of every character.
 */

/** Overridable so tests can stand in for ElevenLabs. */
const apiUrl = () => process.env.ELEVENLABS_API_URL ?? "https://api.elevenlabs.io";
/** A long script takes a while to synthesize. */
const TIMEOUT_MS = 180_000;
const OUTPUT_FORMAT = "mp3_44100_128";
const PAGE_SIZE = 100;

export const VoiceModel = {
  /** Most expressive; reads the script's audio tags ([excited], [whispers]…). */
  V4: "eleven_v4",
  V3: "eleven_v3",
  MultilingualV2: "eleven_multilingual_v2",
  /** Fast and half the price per character. */
  FlashV25: "eleven_flash_v2_5",
} as const;
export type VoiceModel = (typeof VoiceModel)[keyof typeof VoiceModel];

/** Characters one request may carry, per model. */
export const MODEL_CHAR_LIMIT: Record<VoiceModel, number> = {
  [VoiceModel.V4]: 10_000,
  [VoiceModel.V3]: 5_000,
  [VoiceModel.MultilingualV2]: 10_000,
  [VoiceModel.FlashV25]: 40_000,
};

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Voice = { id: string; name: string; category: string | null; description: string | null; labels: Record<string, string>; previewUrl: string | null };
export type VoiceWord = { text: string; start: number; end: number };
type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

async function call(apiKey: string, path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, {
      ...init,
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ElevenLabsError(`could not reach ElevenLabs: ${(e as Error).message}`, 502);
  }
  if (!res.ok) throw new ElevenLabsError(await reason(res), res.status);
  return res;
}

/** ElevenLabs' own explanation, never the key. */
async function reason(res: Response) {
  const body = (await res.json().catch(() => null)) as { detail?: { message?: string } | string } | null;
  const detail = typeof body?.detail === "string" ? body.detail : body?.detail?.message;
  if (res.status === 401) return `ElevenLabs rejected the API key${detail ? `: ${detail}` : ""}. It needs Text to Speech and Voices access.`;
  return `ElevenLabs: ${detail ?? res.statusText} (${res.status})`;
}

/** The voices in the user's ElevenLabs account (premade, cloned, designed and saved ones). */
export async function listVoices(apiKey: string): Promise<Voice[]> {
  const res = await call(apiKey, `/v2/voices?page_size=${PAGE_SIZE}`);
  const body = (await res.json()) as {
    voices: { voice_id: string; name?: string; category?: string; description?: string | null; labels?: Record<string, string>; preview_url?: string | null }[];
  };
  return body.voices.map((v) => ({
    id: v.voice_id,
    name: v.name ?? v.voice_id,
    category: v.category ?? null,
    description: v.description ?? null,
    labels: v.labels ?? {},
    previewUrl: v.preview_url ?? null,
  }));
}

/** Read `text` with a voice: the mp3 and when each word is said. */
export async function speak(apiKey: string, voiceId: string, text: string, model: VoiceModel): Promise<{ audio: Buffer; words: VoiceWord[] }> {
  const res = await call(apiKey, `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`, {
    method: "POST",
    body: JSON.stringify({ text, model_id: model }),
  });
  const body = (await res.json()) as { audio_base64: string; alignment?: Alignment | null; normalized_alignment?: Alignment | null };
  const alignment = body.alignment ?? body.normalized_alignment;
  return { audio: Buffer.from(body.audio_base64, "base64"), words: alignment ? alignmentToWords(alignment) : [] };
}

const seconds = (t: number | undefined) => Math.round((t ?? 0) * 1000) / 1000;

/**
 * Character timings → spoken words, as captions show them. Audio tags ("[excited]") are
 * directions to the voice, not words, so they are left out; punctuation stays on its word.
 */
export function alignmentToWords(a: Alignment): VoiceWord[] {
  const words: VoiceWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  let inTag = false;
  const flush = () => {
    const t = text.trim();
    if (/[\p{L}\p{N}]/u.test(t)) words.push({ text: t, start: seconds(start), end: seconds(end) });
    text = "";
  };
  a.characters.forEach((c, i) => {
    if (c === "[") {
      flush();
      inTag = true;
      return;
    }
    if (inTag) {
      if (c === "]") inTag = false;
      return;
    }
    if (/\s/.test(c)) return flush();
    if (!text) start = a.character_start_times_seconds[i] ?? end;
    text += c;
    end = a.character_end_times_seconds[i] ?? start;
  });
  flush();
  return words;
}
