/** Bundled CC0 models (Kenney) live in public/models/<pack>/<name>.glb, with an optional shared texture. */
export const modelUrl = (key: string) => `/models/${key}.glb`;
export const packTextureUrl = (pack: string) => `/models/${pack}/Textures/colormap.png`;
export const packOf = (key: string) => key.split("/")[0] ?? key;

export type Pixels = { rgba: Uint8Array; width: number; height: number };

/** Decode an image (PNG/JPEG/WebP) to raw RGBA8 for the engine (no image decoder needed in WASM). */
export async function decodePng(url: string): Promise<Pixels | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  return { rgba: new Uint8Array(data.buffer), width: bmp.width, height: bmp.height };
}
