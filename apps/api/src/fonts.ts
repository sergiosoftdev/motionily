import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BadRequestException, Controller, Get, Logger, NotFoundException, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "./auth/auth";
import { MEDIA_DIR } from "./media";

const METADATA_URL = "https://fonts.google.com/metadata/fonts";
const CSS_URL = "https://fonts.googleapis.com/css2";
/** Old browsers get TrueType from Google Fonts, which is what the engine's rasterizer reads. */
const TTF_USER_AGENT = "Mozilla/4.0";
const FONT_DIR = join(MEDIA_DIR, "fonts");
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 60;

export enum FontCategory {
  Sans = "Sans Serif",
  Serif = "Serif",
  Display = "Display",
  Handwriting = "Handwriting",
  Mono = "Monospace",
}

export type FontFamily = { family: string; category: string; weights: number[]; popularity: number };

type Metadata = { familyMetadataList: { family: string; category: string; fonts: Record<string, unknown>; popularity: number }[] };

/** The whole Google Fonts catalog, searchable, with TTF files fetched on demand and cached on disk. */
@Public()
@Controller("fonts")
export class FontsController {
  private readonly logger = new Logger(FontsController.name);
  private list: { at: number; families: FontFamily[] } | null = null;

  constructor() {
    mkdirSync(FONT_DIR, { recursive: true });
  }

  private async families(): Promise<FontFamily[]> {
    if (this.list && Date.now() - this.list.at < LIST_TTL_MS) return this.list.families;
    const raw = await (await fetch(METADATA_URL)).text();
    const meta = JSON.parse(raw.replace(/^\)\]\}'\s*/, "")) as Metadata;
    const families = meta.familyMetadataList
      .map((f) => ({
        family: f.family,
        category: f.category,
        weights: Object.keys(f.fonts).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b),
        popularity: f.popularity,
      }))
      .filter((f) => f.weights.length > 0)
      .sort((a, b) => a.popularity - b.popularity);
    this.list = { at: Date.now(), families };
    this.logger.log(`google fonts catalog: ${families.length} families`);
    return families;
  }

  /** Most popular first; `q` matches the name, `category` filters (Sans Serif, Serif, Display…). */
  @Get()
  async search(@Query("q") q?: string, @Query("category") category?: string) {
    const needle = q?.trim().toLowerCase();
    return (await this.families())
      .filter((f) => (!needle || f.family.toLowerCase().includes(needle)) && (!category || f.category === category))
      .slice(0, MAX_RESULTS);
  }

  /** TTF for a family at the closest available weight. */
  @Get("file")
  async file(@Query("family") family: string, @Query("weight") weightParam: string, @Res() res: Response) {
    const font = (await this.families()).find((f) => f.family === family);
    if (!font) throw new NotFoundException(`no Google font '${family}'`);
    const wanted = Number(weightParam) || 400;
    const weight = font.weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best));
    const name = `${family.replace(/[^A-Za-z0-9]/g, "")}-${weight}.ttf`;
    const path = join(FONT_DIR, name);
    if (!existsSync(path)) {
      const css = await (await fetch(`${CSS_URL}?family=${encodeURIComponent(family)}:wght@${weight}`, { headers: { "User-Agent": TTF_USER_AGENT } })).text();
      const url = css.match(/src: url\((\S+?)\) format\('truetype'\)/)?.[1];
      if (!url) throw new BadRequestException(`Google Fonts has no TrueType file for ${family} ${weight}`);
      const body = (await fetch(url)).body;
      if (!body) throw new BadRequestException("empty font download");
      await pipeline(Readable.fromWeb(body as never), createWriteStream(path));
    }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Font-Weight", String(weight));
    res.sendFile(path);
  }
}
