import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { BadGatewayException, BadRequestException, HttpException, Injectable } from "@nestjs/common";
import type { Types } from "mongoose";
import sharp from "sharp";
import { describeVideo, MAX_VIDEO_BYTES } from "../brands/video-asset";
import { MAX_REFERENCE_BYTES, MEDIA_DIR, MEDIA_PATH, mediaName } from "../media";
import { VideoFormat, type ProjectDocument } from "../projects/project.schema";
import { ProjectsService } from "../projects/projects.service";
import { AssetFormat, AssetKind, AssetSource, Orientation, type AssetCredit, type AssetHit, type ResolvedAsset, type SearchContext, type Searcher, type SourceKeys } from "./asset-types";
import { contactSheet } from "./contact-sheet";
import { cutOut } from "./cutout";
import { download, IMAGE_EXT, SVG_MIME, VIDEO_EXT } from "./http";
import { generateImage, ProviderError } from "./image-gen";
import { LibraryService } from "./library";
import { ProviderKey, ProviderKeysService } from "./provider-keys";
import { resolveArchive, resolveEuropeana, resolveMet, searchArchive, searchEuropeana, searchMet } from "./sources/archives";
import { resolveCommons, searchCommons } from "./sources/commons";
import { iconData, resolveIconify, searchIconifyLogos, searchIcons, needsCredit, setPage } from "./sources/iconify";
import { resolveOpenverse, searchOpenverse } from "./sources/openverse";
import { NO_KEY, resolvePexels, resolvePixabay, searchPexels, searchPixabay } from "./sources/stock";
import { resolveWeb, searchWeb } from "./sources/web";
import { MAX_SVG_BYTES, rasterizeSvg, sanitizeSvg } from "./vector";

const run = promisify(execFile);

/** Sources asked for each kind, in the order their hits are interleaved. */
const SOURCES_BY_KIND: Record<AssetKind, AssetSource[]> = {
  [AssetKind.Photo]: [AssetSource.Commons, AssetSource.Pexels, AssetSource.Europeana, AssetSource.Openverse, AssetSource.Pixabay, AssetSource.Met, AssetSource.Web],
  [AssetKind.Texture]: [AssetSource.Pexels, AssetSource.Pixabay, AssetSource.Openverse, AssetSource.Commons, AssetSource.Europeana, AssetSource.Web],
  [AssetKind.Footage]: [AssetSource.Pexels, AssetSource.Archive, AssetSource.Pixabay, AssetSource.Commons],
  [AssetKind.Logo]: [AssetSource.Iconify, AssetSource.Commons, AssetSource.Web],
};

const SEARCHERS: Partial<Record<AssetSource, Searcher>> = {
  [AssetSource.Commons]: searchCommons,
  [AssetSource.Openverse]: searchOpenverse,
  [AssetSource.Pexels]: searchPexels,
  [AssetSource.Pixabay]: searchPixabay,
  [AssetSource.Iconify]: searchIconifyLogos,
  [AssetSource.Archive]: searchArchive,
  [AssetSource.Met]: searchMet,
  [AssetSource.Europeana]: searchEuropeana,
  [AssetSource.Web]: searchWeb,
};

/** Where a missing key is added, for the agent to tell the user. */
const KEY_OF: Partial<Record<AssetSource, ProviderKey>> = {
  [AssetSource.Pexels]: ProviderKey.Pexels,
  [AssetSource.Pixabay]: ProviderKey.Pixabay,
  [AssetSource.Europeana]: ProviderKey.Europeana,
  [AssetSource.Web]: ProviderKey.Brave,
};

/** Library hits shown first per query (the rest come from the sources). */
const LIBRARY_FIRST = 3;
const PREVIEW_PX = 480;
const VIDEO_TIMEOUT_MS = 180_000;

const ORIENTATION_OF_FORMAT: Record<VideoFormat, Orientation> = {
  [VideoFormat.Vertical]: Orientation.Portrait,
  [VideoFormat.Portrait]: Orientation.Portrait,
  [VideoFormat.Square]: Orientation.Square,
  [VideoFormat.Horizontal]: Orientation.Landscape,
};

export type SearchGroup = { q: string; kind: AssetKind; hits: AssetHit[]; sheet: string | null };
export type ImportResult = { id: string; credit?: AssetCredit; error?: string };

@Injectable()
export class AssetsService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly library: LibraryService,
    private readonly keys: ProviderKeysService,
  ) {}

  /** Every query against every source of its kind at once; one numbered contact sheet per query. */
  async search(userId: Types.ObjectId, project: ProjectDocument, queries: { q: string; kind: AssetKind }[], perQuery: number) {
    const ctx: SearchContext = { keys: await this.keys.sourceKeys(userId), orientation: ORIENTATION_OF_FORMAT[project.format] };
    const unavailable = new Set<string>();
    const missingKeys = new Set<ProviderKey>();
    const seen = new Set<string>();
    let next = 1;
    const groups: SearchGroup[] = [];
    // Sequential groups keep the numbering stable; the sources inside each group run in parallel.
    const answers = await Promise.all(
      queries.map(async ({ q, kind }) => {
        const sources = SOURCES_BY_KIND[kind].filter((s) => s !== AssetSource.Web || ctx.keys.brave);
        const [mine, ...settled] = await Promise.all([
          this.library.search(userId, q, kind, LIBRARY_FIRST).catch(() => [] as AssetHit[]),
          ...sources.map((s) =>
            SEARCHERS[s]!(q, kind, perQuery, ctx).then(
              (hits) => ({ ok: true as const, hits }),
              (e: Error) => ({ ok: false as const, source: s, reason: e.message }),
            ),
          ),
        ]);
        return { q, kind, mine, settled };
      }),
    );
    for (const { q, kind, mine, settled } of answers) {
      const lists: AssetHit[][] = [];
      for (const r of settled) {
        if (r.ok) lists.push(r.hits);
        else if (r.reason === NO_KEY && KEY_OF[r.source]) missingKeys.add(KEY_OF[r.source]!);
        else unavailable.add(`${r.source} (${r.reason})`);
      }
      // Round robin across sources so one library cannot fill the sheet.
      const hits: AssetHit[] = mine.filter((h) => !seen.has(h.id) && seen.add(h.id));
      for (let i = 0; hits.length < perQuery && lists.some((l) => i < l.length); i++)
        for (const l of lists) {
          const h = l[i];
          if (h && hits.length < perQuery && !seen.has(h.id)) {
            seen.add(h.id);
            hits.push(h);
          }
        }
      const sheet = await contactSheet(hits, kind, next).catch(() => null);
      next += hits.length;
      groups.push({ q, kind, hits, sheet: sheet ? sheet.toString("base64") : null });
    }
    return { groups, unavailable: [...unavailable], missingKeys: [...missingKeys] };
  }

  /** Import search hits (or library items) into the video and the library; one failure never sinks the rest. */
  async import(userId: Types.ObjectId, project: ProjectDocument, ids: string[], query = ""): Promise<ImportResult[]> {
    const keys = await this.keys.sourceKeys(userId);
    return Promise.all(
      ids.map((id) =>
        this.importOne(userId, project, id, keys, query).then(
          (credit) => ({ id, credit }),
          (e: Error) => ({ id, error: e.message }),
        ),
      ),
    );
  }

  private async importOne(userId: Types.ObjectId, project: ProjectDocument, id: string, keys: SourceKeys, query: string): Promise<AssetCredit> {
    const at = id.indexOf(":");
    const source = id.slice(0, at) as AssetSource;
    const ref = id.slice(at + 1);
    if (source === AssetSource.Library) {
      const item = await this.library.get(userId, ref);
      await this.library.markUsed(item._id, project.id);
      await this.projects.addImageCredit(project.id, item.credit);
      return item.credit;
    }
    const known = await this.library.bySource(userId, id);
    if (known) {
      await this.library.markUsed(known._id, project.id);
      await this.projects.addImageCredit(project.id, known.credit);
      return known.credit;
    }
    const resolved = await this.resolve(source, ref, keys);
    const credit = await this.fetchInto(resolved, source === AssetSource.Web);
    await this.library.add(userId, project.id, id, credit, query);
    await this.projects.addImageCredit(project.id, credit);
    return credit;
  }

  private async resolve(source: AssetSource, ref: string, keys: SourceKeys): Promise<ResolvedAsset & { svgText?: string }> {
    switch (source) {
      case AssetSource.Commons:
        return resolveCommons(ref);
      case AssetSource.Openverse:
        return resolveOpenverse(ref);
      case AssetSource.Pexels:
        return resolvePexels(ref, keys);
      case AssetSource.Pixabay:
        return resolvePixabay(ref, keys);
      case AssetSource.Iconify:
        return resolveIconify(ref);
      case AssetSource.Archive:
        return resolveArchive(ref);
      case AssetSource.Met:
        return resolveMet(ref);
      case AssetSource.Europeana:
        return resolveEuropeana(ref, keys);
      case AssetSource.Web:
        return resolveWeb(ref);
      default:
        throw new Error(`unknown source in '${source}:${ref}' (${Object.values(AssetSource).join(", ")})`);
    }
  }

  /** Download into /media: rasters with a preview, SVGs sanitized plus their PNG rendering, clips with a contact sheet. */
  private async fetchInto(r: ResolvedAsset & { svgText?: string }, untrusted: boolean): Promise<AssetCredit> {
    if (r.format === AssetFormat.Video) {
      const file = await download(r.download, MAX_VIDEO_BYTES, { ...VIDEO_EXT, ...ARCHIVE_VIDEO_EXT }, { timeoutMs: VIDEO_TIMEOUT_MS, untrusted }).catch(fail);
      // Archives serve webm/ogv/m4v: the editor gets H.264 MP4 every time.
      const src = file.ext === ".mp4" ? await save(file.bytes, file.ext) : await toMp4(file.bytes, file.ext).catch(fail);
      const facts = await describeVideo(join(MEDIA_DIR, src.slice("/media/".length)));
      return { ...r.credit, format: AssetFormat.Video, src, ...(facts ? { duration: facts.duration, width: facts.width, height: facts.height, poster: facts.poster ?? undefined } : {}) };
    }
    const fetched = r.svgText !== undefined ? { bytes: Buffer.from(r.svgText), ext: ".svg", mime: SVG_MIME } : await download(r.download, Math.max(MAX_REFERENCE_BYTES, MAX_SVG_BYTES), { ...IMAGE_EXT, [SVG_MIME]: ".svg" }, { untrusted }).catch(fail);
    if (fetched.mime === SVG_MIME || fetched.ext === ".svg") {
      const svg = sanitizeSvg(fetched.bytes.toString("utf8"));
      const raster = await rasterizeSvg(svg).catch(() => {
        throw new BadRequestException("this SVG could not be rendered");
      });
      const [svgSrc, src, preview] = await Promise.all([save(Buffer.from(svg), ".svg"), save(raster.png, ".png"), save(raster.preview, ".png")]);
      return { ...r.credit, kind: AssetKind.Logo, format: AssetFormat.Svg, src, svg: svgSrc, preview, width: raster.width, height: raster.height };
    }
    const meta = await sharp(fetched.bytes).metadata();
    const small = r.preview ? await download(r.preview, MAX_REFERENCE_BYTES, IMAGE_EXT, { untrusted }).catch(() => null) : null;
    const previewBytes = small?.bytes ?? (await sharp(fetched.bytes).resize(PREVIEW_PX, PREVIEW_PX, { fit: "inside" }).jpeg({ quality: 82 }).toBuffer());
    const [src, preview] = await Promise.all([save(fetched.bytes, fetched.ext), save(previewBytes, small?.ext ?? ".jpg")]);
    return { ...r.credit, format: AssetFormat.Raster, src, preview, width: meta.width, height: meta.height };
  }

  /** Cut the subject out of an image (any /media image: imported, brand, cut before). */
  async cutout(userId: Types.ObjectId, project: ProjectDocument, src: string): Promise<AssetCredit> {
    if (!MEDIA_PATH.test(src)) throw new BadRequestException("src must be a /media/… image");
    const sourceId = `cutout:${src}`;
    const known = await this.library.bySource(userId, sourceId);
    if (known) {
      await this.library.markUsed(known._id, project.id);
      return known.credit;
    }
    const bytes = await readFile(join(MEDIA_DIR, src.slice("/media/".length))).catch(() => {
      throw new BadRequestException(`no file ${src}`);
    });
    const cut = await cutOut(bytes).catch((e: Error) => {
      throw new BadGatewayException(`the cutout failed: ${e.message}`);
    });
    const [out, preview] = await Promise.all([save(cut.png, ".png"), save(cut.preview, ".png")]);
    const original = project.imageCredits?.find((c) => c.src === src);
    const credit: AssetCredit = original
      ? { ...original, src: out, preview, svg: undefined, width: cut.width, height: cut.height, format: AssetFormat.Raster, title: `${original.title} (cut out)` }
      : { src: out, preview, width: cut.width, height: cut.height, format: AssetFormat.Raster, kind: AssetKind.Photo, source: AssetSource.Library, title: "Cutout of your image", author: "you", license: "Your own material", licenseUrl: null, pageUrl: src };
    await this.library.add(userId, project.id, sourceId, credit, original?.title ?? "");
    if (original) await this.projects.addImageCredit(project.id, credit);
    return credit;
  }

  /** Generate an image with the user's OpenAI key (never the platform's). */
  async generate(userId: Types.ObjectId, project: ProjectDocument, prompt: string, transparent: boolean, orientation?: Orientation): Promise<AssetCredit & { revisedPrompt: string | null }> {
    const key = await this.keys.keyFor(userId, ProviderKey.OpenAI);
    if (!key) throw new BadRequestException("image generation uses the user's own OpenAI key: ask them to add it in Settings › Asset sources");
    const image = await generateImage(key, prompt, orientation ?? ORIENTATION_OF_FORMAT[project.format] ?? Orientation.Square, transparent).catch((e: unknown) => {
      if (e instanceof ProviderError) throw new HttpException(e.message, e.status);
      throw e;
    });
    const meta = await sharp(image.png).metadata();
    const small = await sharp(image.png).resize(PREVIEW_PX, PREVIEW_PX, { fit: "inside" }).png().toBuffer();
    const [src, preview] = await Promise.all([save(image.png, ".png"), save(small, ".png")]);
    const sourceId = `${AssetSource.Generated}:${randomUUID()}`;
    const credit: AssetCredit = {
      src,
      preview,
      width: meta.width,
      height: meta.height,
      format: AssetFormat.Raster,
      kind: AssetKind.Photo,
      source: AssetSource.Generated,
      title: prompt.length > 100 ? `${prompt.slice(0, 99)}…` : prompt,
      author: `OpenAI ${image.model}`,
      license: "AI-generated",
      licenseUrl: null,
      pageUrl: sourceId,
    };
    await this.library.add(userId, project.id, sourceId, credit, prompt);
    await this.projects.addImageCredit(project.id, credit);
    return { ...credit, revisedPrompt: image.revisedPrompt };
  }

  /** Icon ids for words across every reusable Iconify set. */
  async icons(q: string, limit: number) {
    const { icons, sets } = await searchIcons(q, limit).catch((e: Error) => {
      throw new BadGatewayException(`icon search failed: ${e.message}`);
    });
    return icons.map((id) => {
      const set = sets[id.split(":")[0]!]!;
      return { id, set: set.name, license: set.license?.title ?? "", category: set.category ?? "", multicolor: !!set.palette };
    });
  }

  /** Icon bodies for ic=; sets whose license asks for credit join the video's credits. */
  async iconData(project: ProjectDocument, ids: string[]) {
    const out = await iconData(ids).catch((e: Error) => {
      throw new BadRequestException(e.message);
    });
    const credited = new Set<string>();
    for (const icon of out.icons) {
      const prefix = icon.id.split(":")[0]!;
      if (credited.has(prefix) || !needsCredit(icon.license)) continue;
      credited.add(prefix);
      await this.projects.addImageCredit(project.id, {
        src: "",
        kind: AssetKind.Logo,
        format: AssetFormat.Svg,
        source: AssetSource.Iconify,
        title: `${icon.set} icons`,
        author: icon.set,
        license: icon.license,
        licenseUrl: icon.licenseUrl,
        pageUrl: setPage(prefix),
      });
    }
    return out;
  }
}

/** Containers archives use besides the ones the editor reads directly. */
const ARCHIVE_VIDEO_EXT: Record<string, string> = { "video/ogg": ".ogv", "application/ogg": ".ogv", "video/x-m4v": ".m4v", "video/mpeg": ".mpg" };
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
/** Long side of converted clips (archive films are SD; stock is already ≤ 1080). */
const CLIP_LONG_SIDE = 1280;
const TRANSCODE_TIMEOUT_MS = 300_000;

/** Convert any clip to H.264/AAC MP4 (fast start), at most 1280 px on its long side. */
async function toMp4(bytes: Buffer, ext: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clip-"));
  try {
    const input = join(dir, `in${ext}`);
    await writeFile(input, bytes);
    const name = mediaName("clip.mp4");
    const scale = `scale='if(gt(iw,ih),min(${CLIP_LONG_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${CLIP_LONG_SIDE},ih))'`;
    await run(FFMPEG, ["-v", "error", "-y", "-i", input, "-vf", `${scale},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(MEDIA_DIR, name)], {
      timeout: TRANSCODE_TIMEOUT_MS,
    });
    return `/media/${name}`;
  } catch (e) {
    throw new Error(`the clip could not be converted to MP4: ${(e as Error).message.slice(0, 200)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function save(bytes: Buffer, ext: string) {
  const name = mediaName(`asset${ext}`);
  await writeFile(join(MEDIA_DIR, name), bytes);
  return `/media/${name}`;
}

function fail(e: Error): never {
  throw new BadGatewayException(e.message);
}
