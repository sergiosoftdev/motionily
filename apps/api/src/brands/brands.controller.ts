import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { join } from "node:path";
import { MEDIA_DIR, mediaName, removeMedia } from "../media";
import { describeVideo, MAX_VIDEO_BYTES, VIDEO_TYPES } from "./video-asset";
import { ProjectsService } from "../projects/projects.service";
import { BrandsService } from "./brands.service";
import { ConceptsRequestDto, ConceptsService } from "./concepts";
import { AgentSettingsService } from "../users/agent-settings";
import { GenerateService } from "../projects/generate.service";
import { AssetMetaDto, CreateBrandDto, UpdateBrandDto } from "./brands.dto";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Projects (brand kits) of the signed-in user. Videos live inside them. */
@Controller("brands")
export class BrandsController {
  constructor(
    private readonly brands: BrandsService,
    private readonly projects: ProjectsService,
    private readonly concepts: ConceptsService,
    private readonly agentSettings: AgentSettingsService,
    private readonly generator: GenerateService,
  ) {}

  /** Different ways to make a video from an idea, pitched by the agent before anything is built. */
  @Post(":brandId/concepts")
  @HttpCode(200)
  async pitch(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Body() dto: ConceptsRequestDto) {
    const kit = await this.full(user, brandId);
    return this.concepts.pitch(dto, kit, await this.agentSettings.forUser(user.id));
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    // Videos created before projects existed are adopted by the first project.
    const fallback = await this.brands.ensureDefault(user.id);
    await this.projects.adoptOrphans(user.id, fallback._id);
    const brands = await this.brands.list(user.id);
    const counts = await this.projects.countByBrand(user.id);
    return brands.map((b) => ({ id: b._id.toString(), name: b.name, notes: b.notes, palettes: b.palettes, videos: counts.get(b._id.toString()) ?? 0 }));
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateBrandDto) {
    const b = await this.brands.create(user.id, dto);
    return this.view(b._id.toString(), user);
  }

  @Get(":brandId")
  view(@Param("brandId") brandId: string, @CurrentUser() user: AuthUser) {
    return this.full(user, brandId);
  }

  @Patch(":brandId")
  async update(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Body() dto: UpdateBrandDto) {
    await this.brands.update(user.id, brandId, dto);
    return this.full(user, brandId);
  }

  @Delete(":brandId")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string) {
    if (await this.projects.countInBrand(user.id, brandId)) throw new BadRequestException("delete or move its videos first");
    await this.brands.remove(user.id, brandId);
  }

  @Get(":brandId/videos")
  async videos(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string) {
    const b = await this.brands.get(user.id, brandId);
    // Mark videos the agent team is still building (it keeps going with the page closed).
    return (await this.projects.list(user.id, b._id)).map((p) => ({ ...p, generating: this.generator.isRunning(String(p._id)) }));
  }

  /** Logo, screenshot, photo or video clip (mp4/webm/mov) for the brand kit, with an optional description. */
  @Post(":brandId/assets")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname)) }),
      limits: { fileSize: MAX_VIDEO_BYTES },
      fileFilter: (_req, f, cb) => cb(null, f.mimetype.startsWith("image/") || VIDEO_TYPES.includes(f.mimetype)),
    }),
  )
  async upload(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Body() meta: AssetMetaDto, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("send an image or a video (mp4, webm, mov) in 'file'");
    const isVideo = VIDEO_TYPES.includes(file.mimetype);
    if (!isVideo && file.size > MAX_IMAGE_BYTES) {
      await removeMedia(file.filename);
      throw new BadRequestException("images are limited to 15 MB");
    }
    const b = await this.brands.get(user.id, brandId).catch(async (e: unknown) => {
      await removeMedia(file.filename);
      throw e;
    });
    // Clips: length, size and a contact sheet, so agents can trim them without probing.
    const video = isVideo ? await describeVideo(join(MEDIA_DIR, file.filename)) : undefined;
    await this.brands.addAsset(b._id, file, meta, video);
    return this.full(user, brandId);
  }

  @Patch(":brandId/assets/:assetId")
  async updateAsset(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Param("assetId") assetId: string, @Body() meta: AssetMetaDto) {
    const b = await this.brands.get(user.id, brandId);
    await this.brands.updateAsset(b._id, assetId, meta);
    return this.full(user, brandId);
  }

  @Delete(":brandId/assets/:assetId")
  async removeAsset(@CurrentUser() user: AuthUser, @Param("brandId") brandId: string, @Param("assetId") assetId: string) {
    const b = await this.brands.get(user.id, brandId);
    await this.brands.removeAsset(b._id, assetId);
    return this.full(user, brandId);
  }

  private async full(user: AuthUser, brandId: string) {
    const b = await this.brands.get(user.id, brandId);
    return brandView(b, await this.brands.listAssets(b._id));
  }
}

export function brandView(
  b: { _id: { toString(): string }; name: string; notes: string; palettes: unknown[] },
  assets: {
    _id: { toString(): string };
    kind: string;
    name: string;
    description: string;
    file: string;
    mime: string;
    duration?: number;
    width?: number;
    height?: number;
    poster?: string;
  }[],
) {
  return {
    id: b._id.toString(),
    name: b.name,
    notes: b.notes,
    palettes: b.palettes,
    assets: assets.map((a) => ({
      id: a._id.toString(),
      kind: a.kind,
      name: a.name,
      description: a.description,
      url: `/media/${a.file}`,
      mime: a.mime,
      ...(a.duration !== undefined ? { duration: a.duration, width: a.width, height: a.height } : {}),
      ...(a.poster ? { poster: a.poster } : {}),
    })),
  };
}
