import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { InferenceSession as Session } from "onnxruntime-node";
import sharp from "sharp";

/**
 * Background removal (a subject cut out of its photo, transparent around it) with BiRefNet lite
 * (MIT) on the CPU. The model (~220 MB) downloads once on first use.
 */
const MODEL_URL = process.env.CUTOUT_MODEL_URL ?? "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx";
const MODELS_DIR = process.env.MODELS_DIR ?? join(homedir(), ".motionily", "models");
const MODEL_FILE = join(MODELS_DIR, "birefnet-lite.onnx");
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** Mask values (0..255) at or below this count as background when trimming the empty margin. */
const TRIM_THRESHOLD = 128;
/** Margin kept around the subject after trimming (fraction of its size). */
const TRIM_MARGIN = 0.02;
const MAX_INPUT_PX = 4096;

let session: Promise<Session> | null = null;

async function ensureModel() {
  const ok = await stat(MODEL_FILE).then((s) => s.size > 1e6, () => false);
  if (ok) return;
  await mkdir(MODELS_DIR, { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`the cutout model could not be downloaded (${res.status})`);
  const tmp = `${MODEL_FILE}.part`;
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(tmp));
  await rename(tmp, MODEL_FILE);
}

function load(): Promise<Session> {
  session ??= (async () => {
    await ensureModel();
    const ort = await import("onnxruntime-node");
    return ort.InferenceSession.create(MODEL_FILE, { graphOptimizationLevel: "all" });
  })().catch((e: unknown) => {
    session = null;
    throw e;
  });
  return session;
}

/** Start loading the model in the background (first cutouts would otherwise wait for the download). */
export function preloadCutout() {
  void load().catch(() => undefined);
}

/** The subject of an image on a transparent background, trimmed to it (PNG). */
export async function cutOut(input: Buffer): Promise<{ png: Buffer; width: number; height: number; preview: Buffer }> {
  const s = await load();
  const ort = await import("onnxruntime-node");
  // Always 3 sRGB channels: grayscale photos (most archive ones) would otherwise feed the model one channel.
  const oriented = await sharp(input)
    .rotate()
    .resize(MAX_INPUT_PX, MAX_INPUT_PX, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .toColourspace("srgb")
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = oriented.info;
  const rgb = await sharp(oriented.data).resize(SIZE, SIZE, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  if (rgb.length !== SIZE * SIZE * 3) throw new Error("unexpected pixel layout");
  const plane = SIZE * SIZE;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) tensor[c * plane + i] = (rgb[i * 3 + c]! / 255 - MEAN[c]!) / STD[c]!;
  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor("float32", tensor, [1, 3, SIZE, SIZE]) });
  const raw = out[s.outputNames[0]!]!.data as Float32Array;
  // The model answers logits; some exports already apply the sigmoid.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < plane; i++) {
    lo = Math.min(lo, raw[i]!);
    hi = Math.max(hi, raw[i]!);
  }
  const logits = lo < 0 || hi > 1;
  const mask = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) mask[i] = Math.round(255 * (logits ? 1 / (1 + Math.exp(-raw[i]!)) : raw[i]!));
  // extractChannel keeps one band: sharp would otherwise hand back the resized mask as 3 sRGB bands.
  const alpha = await sharp(mask, { raw: { width: SIZE, height: SIZE, channels: 1 } }).resize(width, height, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  if (alpha.length !== width * height) throw new Error("unexpected mask layout");
  // Trim to the subject so the layer box is the subject, not the old photo.
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (alpha[y * width + x]! > TRIM_THRESHOLD) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error("no subject found in this image");
  const mx = Math.round((x1 - x0) * TRIM_MARGIN);
  const my = Math.round((y1 - y0) * TRIM_MARGIN);
  const box = { left: Math.max(0, x0 - mx), top: Math.max(0, y0 - my), width: 0, height: 0 };
  box.width = Math.min(width, x1 + mx + 1) - box.left;
  box.height = Math.min(height, y1 + my + 1) - box.top;
  // Separate pipelines: sharp applies extract before joinChannel inside one.
  const rgba = await sharp(oriented.data).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const png = await sharp(rgba).extract(box).png().toBuffer();
  const preview = await sharp(png).resize(480, 480, { fit: "inside" }).png().toBuffer();
  return { png, width: box.width, height: box.height, preview };
}
