/** Bundled CC0 models (Kenney) live in public/models/<pack>/<name>.glb, with an optional shared texture. */
export const modelUrl = (key: string) => `/models/${key}.glb`;
export const packTextureUrl = (pack: string) => `/models/${pack}/Textures/colormap.png`;
/** A file next to the models by its engine key ("characters/Textures/colormap.png"). */
export const modelFileUrl = (key: string) => `/models/${key}`;
export const packOf = (key: string) => key.split("/")[0] ?? key;

export type Pixels = { rgba: Uint8Array; width: number; height: number };

/** Decode an image (PNG/JPEG/WebP) to raw RGBA8 for the engine (no image decoder needed in WASM). */
export async function decodePng(url: string): Promise<Pixels | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return decodeBlob(await res.blob());
}

/** Decode encoded image bytes (an image embedded in a GLB). */
export function decodeBytes(bytes: Uint8Array): Promise<Pixels | null> {
  return decodeBlob(new Blob([bytes as BlobPart]));
}

async function decodeBlob(blob: Blob): Promise<Pixels | null> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  return { rgba: new Uint8Array(data.buffer), width: bmp.width, height: bmp.height };
}
