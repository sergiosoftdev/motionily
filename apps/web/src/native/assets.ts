import { invoke } from "@tauri-apps/api/core";

/** Asset kinds the desktop app's native engine stores (the `x-kind` header of `engine_add_asset`). */
const AssetKind = { Font: "font", Model: "model", Texture: "texture", Image: "image", Lut: "lut" } as const;
type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

type Pixels = { rgba: Uint8Array; width: number; height: number };

/** Where the editor's loaded assets come from (the engine host). */
export type AssetSource = {
  loadedFontFiles(): Promise<{ family: string; weight: number; bytes: Uint8Array }[]>;
  stageAssets(): Promise<{ models: { key: string; bytes: Uint8Array }[]; textures: ({ pack: string } & Pixels)[] }>;
  imageAssets(): Promise<({ src: string } & Pixels)[]>;
  lutAssets(): Promise<{ src: string; text: string }[]>;
};

/** Sends one asset as a binary IPC body; key and sizes ride in headers. */
function sendAsset(kind: AssetKind, key: string, bytes: Uint8Array, a = 0, b = 0) {
  return invoke("engine_add_asset", bytes, { headers: { "x-kind": kind, "x-key": encodeURIComponent(key), "x-a": String(a), "x-b": String(b) } });
}

async function missing(kind: AssetKind, keys: string[]): Promise<Set<string>> {
  return new Set(keys.length ? await invoke<string[]>("engine_missing_assets", { kind, keys }) : []);
}

/** Gives the native engine every font, model, texture and image the editor's engine has loaded (only new ones cross). */
export async function syncNativeAssets(source: AssetSource) {
  const [fonts, stage, images, luts] = await Promise.all([source.loadedFontFiles(), source.stageAssets(), source.imageAssets(), source.lutAssets()]);
  // Fonts are keyed by family; a family is sent whole the first time any of its weights is.
  const newFamilies = await missing(AssetKind.Font, [...new Set(fonts.map((f) => f.family))]);
  for (const f of fonts) if (newFamilies.has(f.family)) await sendAsset(AssetKind.Font, f.family, f.bytes, f.weight);
  const newModels = await missing(AssetKind.Model, stage.models.map((m) => m.key));
  for (const m of stage.models) if (newModels.has(m.key)) await sendAsset(AssetKind.Model, m.key, m.bytes);
  const newTextures = await missing(AssetKind.Texture, stage.textures.map((t) => t.pack));
  for (const t of stage.textures) if (newTextures.has(t.pack)) await sendAsset(AssetKind.Texture, t.pack, t.rgba, t.width, t.height);
  const newImages = await missing(AssetKind.Image, images.map((i) => i.src));
  for (const i of images) if (newImages.has(i.src)) await sendAsset(AssetKind.Image, i.src, i.rgba, i.width, i.height);
  const newLuts = await missing(AssetKind.Lut, luts.map((l) => l.src));
  for (const l of luts) if (newLuts.has(l.src)) await sendAsset(AssetKind.Lut, l.src, new TextEncoder().encode(l.text));
}
