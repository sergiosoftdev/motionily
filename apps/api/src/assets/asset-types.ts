/**
 * Material the agent gathers for a video like a human editor would: real photos, stock footage,
 * logos (as vectors), textures. Every source states each item's license; only what a video may
 * reuse comes back, except web results, which are flagged editorial-only.
 */

/** What the agent is looking for (mirrors AssetKind in @motionily/protocol). */
export enum AssetKind {
  Photo = "photo",
  Footage = "footage",
  Logo = "logo",
  Texture = "texture",
}

/** Where an item comes from (mirrors ImageSource in @motionily/protocol). */
export enum AssetSource {
  Commons = "commons",
  Openverse = "openverse",
  Pexels = "pexels",
  Pixabay = "pixabay",
  Iconify = "iconify",
  Archive = "archive",
  Met = "met",
  Europeana = "europeana",
  Web = "web",
  Generated = "generated",
  Library = "library",
}

/** How the file is used: raster image layer, vector (path layers via add_vector, plus a PNG), video layer. */
export enum AssetFormat {
  Raster = "raster",
  Svg = "svg",
  Video = "video",
}

/** One search result; `id` is what import takes. */
export type AssetHit = {
  id: string;
  kind: AssetKind;
  source: AssetSource;
  format: AssetFormat;
  title: string;
  description: string;
  author: string;
  license: string;
  date: string;
  width: number;
  height: number;
  /** Small image the contact sheet is built from. */
  thumb: string;
  /** Footage only. */
  duration?: number;
  /** Web results: license unknown, only for commentary/news-style use. */
  editorial?: boolean;
  /** Already in the user's library (imported for an earlier video). */
  library?: boolean;
};

/** An imported item, with what its license asks to credit (kept with the video and in the library). */
export type AssetCredit = {
  src: string;
  /** Small copy the agent looks at (the full image would flood its context). */
  preview?: string;
  /** Vectors: the sanitized SVG (`src` is its PNG rendering). */
  svg?: string;
  /** Footage: contact sheet (12 frames) and facts. */
  poster?: string;
  duration?: number;
  width?: number;
  height?: number;
  kind?: AssetKind;
  format?: AssetFormat;
  source: AssetSource;
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  pageUrl: string;
  editorial?: boolean;
};

/** Where to download an item from and how to credit it, straight from its source. */
export type ResolvedAsset = {
  format: AssetFormat;
  download: string;
  /** Raster: a small copy for the agent. */
  preview?: string;
  credit: Omit<AssetCredit, "src" | "preview" | "svg" | "poster" | "duration" | "width" | "height" | "format">;
};

/** Third-party keys a search may use (the user's own, or the platform's for free sources). */
export type SourceKeys = { pexels?: string; pixabay?: string; brave?: string; europeana?: string };

/** The video's frame shape: sources that can filter by it return images that fit. */
export enum Orientation {
  Portrait = "portrait",
  Landscape = "landscape",
  Square = "square",
}

export type SearchContext = { keys: SourceKeys; orientation?: Orientation };

/** A search one source can answer. */
export type Searcher = (q: string, kind: AssetKind, limit: number, ctx: SearchContext) => Promise<AssetHit[]>;
