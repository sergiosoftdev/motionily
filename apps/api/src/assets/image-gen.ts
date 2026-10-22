import { Orientation } from "./asset-types";

/**
 * Image generation with the user's own OpenAI key: a last resort for what no library has (an
 * illustration in a precise style, a prop that does not exist). Generated images look generated:
 * real material comes first.
 */
const OPENAI_IMAGES = "https://api.openai.com/v1/images/generations";
/** Arbitrary sizes and the best quality for opaque images. */
const MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
/** Transparent backgrounds are stable on 1.5 (preview on 2). */
const TRANSPARENT_MODEL = process.env.OPENAI_IMAGE_TRANSPARENT_MODEL ?? "gpt-image-1.5";
const TIMEOUT_MS = 180_000;

const SIZE: Record<Orientation, string> = {
  [Orientation.Portrait]: "1024x1536",
  [Orientation.Landscape]: "1536x1024",
  [Orientation.Square]: "1024x1024",
};

export type GeneratedImage = { png: Buffer; model: string; revisedPrompt: string | null };

/** OpenAI's answer as a status the web client keeps signed in with (never 401). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function generateImage(apiKey: string, prompt: string, aspect: Orientation, transparent: boolean): Promise<GeneratedImage> {
  const model = transparent ? TRANSPARENT_MODEL : MODEL;
  const res = await fetch(OPENAI_IMAGES, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: SIZE[aspect], quality: "high", output_format: "png", background: transparent ? "transparent" : "opaque", n: 1 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const message = err.error?.message ?? res.statusText;
    // 401/403 = a bad key: report it as a bad request so the user is not signed out.
    throw new ProviderError(`OpenAI: ${message}`, res.status === 429 ? 429 : res.status >= 500 ? 502 : 400);
  }
  const data = (await res.json()) as { data?: { b64_json?: string; revised_prompt?: string }[] };
  const image = data.data?.[0];
  if (!image?.b64_json) throw new ProviderError("OpenAI returned no image", 502);
  return { png: Buffer.from(image.b64_json, "base64"), model, revisedPrompt: image.revised_prompt ?? null };
}
