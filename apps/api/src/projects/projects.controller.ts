import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { MAX_AUDIO_BYTES, MEDIA_DIR, mediaName, removeMedia } from "../media";
import { JwtService } from "@nestjs/jwt";
import { CurrentUser, TokenScope, type AuthUser, type JwtPayload } from "../auth/auth";
import { BricksService } from "../bricks/bricks.service";
import { CreateBrickDto, ListBricksQuery } from "../bricks/bricks.dto";
import { BrickSlot } from "../bricks/brick.enums";
import { ProjectsService } from "./projects.service";
import { BridgeHub } from "../bridge-hub";
import { PrefabsService } from "../prefabs/prefabs.service";
import { BrandsService } from "../brands/brands.service";
import { brandView } from "../brands/brands.controller";
import { ClonePrefabDto, PREFAB_NAME, SavePrefabDto } from "../prefabs/prefabs.dto";
import { GenerateService } from "./generate.service";
import { CreateFeedbackDto, CreateProjectDto, FOOTAGE_LANGUAGES, FootageWordsDto, UploadFootageDto, GenerateDto, GenerateVoiceDto, SaveSceneDto, SetSlotDto, UpdateProjectDto } from "./projects.dto";
import { describeVideo, VIDEO_TYPES } from "../brands/video-asset";
import { fitSong, songEnergy } from "../music/energy";
import { SunoPromptDto, SunoService } from "../music/suno";
import { VoiceService } from "../voice/voice.service";
import { VoiceModel } from "../voice/elevenlabs";
import type { ProjectDocument } from "./project.schema";

/** A few minutes of phone video (4K HEVC runs about 100 MB a minute). */
const MAX_FOOTAGE_BYTES = 2 * 1024 * 1024 * 1024;

@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly bricks: BricksService,
    private readonly jwt: JwtService,
    private readonly generator: GenerateService,
    private readonly prefabs: PrefabsService,
    private readonly brands: BrandsService,
    private readonly voice: VoiceService,
    private readonly suno: SunoService,
  ) {}

  /** The brand kit of the project this video belongs to (agents read it to design on-brand). */
  @Get(":id/brand")
  async brand(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const video = await this.projects.get(user.id, id);
    const brand = video.brandId ? await this.brands.get(user.id, video.brandId.toString()) : await this.brands.ensureDefault(user.id);
    return brandView(brand, await this.brands.listAssets(brand._id));
  }

  // ── Prefabs: the user's reusable 3D library, reachable from any of their projects ──

  @Get(":id/prefabs")
  async listPrefabs(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query("full") full?: string) {
    await this.projects.get(user.id, id);
    return full ? this.prefabs.all(user.id) : this.prefabs.list(user.id);
  }

  @Get(":id/prefabs/:name")
  async getPrefab(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("name") name: string) {
    await this.projects.get(user.id, id);
    return this.prefabs.get(user.id, name);
  }

  @Put(":id/prefabs/:name")
  async savePrefab(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("name") name: string, @Body() dto: SavePrefabDto) {
    if (!PREFAB_NAME.test(name)) throw new BadRequestException("prefab names are snake_case (2-40 chars)");
    await this.projects.get(user.id, id);
    return this.prefabs.save(user.id, name, dto);
  }

  @Post(":id/prefabs/:name/clone")
  async clonePrefab(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("name") name: string, @Body() dto: ClonePrefabDto) {
    await this.projects.get(user.id, id);
    return this.prefabs.clone(user.id, name, dto.name, dto.description);
  }

  @Delete(":id/prefabs/:name")
  @HttpCode(204)
  async deletePrefab(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("name") name: string) {
    userOnly(user);
    await this.projects.get(user.id, id);
    await this.prefabs.remove(user.id, name);
  }

  /** "Generar": run the agent on this project from the editor, no terminal needed. */
  @Post(":id/generate")
  generate(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: GenerateDto) {
    userOnly(user);
    return this.generator.start(user.id, user.email, id, dto);
  }

  @Get(":id/generate")
  async generateStatus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const project = await this.projects.get(user.id, id);
    return this.generator.statusOf(project.id);
  }

  @Delete(":id/generate")
  async stopGenerate(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    userOnly(user);
    const project = await this.projects.get(user.id, id);
    return this.generator.stop(project.id);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.projects.list(user.id);
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    // Every video lives in a project: the given one (if it is theirs) or their first.
    const brand = dto.brandId ? await this.brands.get(user.id, dto.brandId) : await this.brands.ensureDefault(user.id);
    dto.brandId = brand._id.toString();
    return this.view(await this.projects.create(user.id, dto));
  }

  @Get(":id")
  async get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.view(await this.projects.get(user.id, id));
  }

  @Patch(":id")
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UpdateProjectDto) {
    const project = await this.projects.update(user.id, id, dto);
    if (user.scope === TokenScope.Agent) BridgeHub.instance?.notifyProjectChanged(project.id);
    return this.view(project);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    userOnly(user);
    return this.projects.remove(user.id, id);
  }

  @Put(":id/build/:slot")
  async setSlot(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("slot") slot: BrickSlot,
    @Body() dto: SetSlotDto,
  ) {
    // Agents may change options too; only the user's own choices are reported back as feedback.
    const project = await this.projects.setSlot(user.id, id, slot, dto, user.scope === TokenScope.User);
    if (user.scope === TokenScope.Agent) BridgeHub.instance?.notifyProjectChanged(project.id);
    return this.view(project);
  }

  /** A token the user pastes into their agent (MCP), or one an account token gets per video. It can only touch this project. */
  @Post(":id/agent-token")
  async agentToken(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    if (user.scope !== TokenScope.User && user.scope !== TokenScope.Account) throw new ForbiddenException("only the user can do this");
    const project = await this.projects.get(user.id, id);
    const payload: JwtPayload = { sub: user.id.toString(), email: user.email, scope: TokenScope.Agent, projectId: project.id };
    return { token: await this.jwt.signAsync(payload, { expiresIn: "90d" }), projectId: project.id };
  }

  /** Short-lived token for the agent's headless editor (self-review without the user's browser). */
  @Post(":id/headless-token")
  async headlessToken(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const project = await this.projects.get(user.id, id);
    const payload: JwtPayload = { sub: user.id.toString(), email: user.email, scope: TokenScope.Editor, projectId: project.id };
    return { token: await this.jwt.signAsync(payload, { expiresIn: "2h" }), user: { id: user.id.toString(), email: user.email, name: "Motionily agent", avatarUrl: null, provider: "agent" } };
  }

  /** Voice-over or music for the video. Replaces the previous file. */
  /** Background music for the video; the editor places it (scene `music`) and ducks it under the voice. */
  @Post(":id/music")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname || "music.mp3")) }),
      limits: { fileSize: MAX_AUDIO_BYTES },
      fileFilter: (_req, f, cb) => cb(null, f.mimetype.startsWith("audio/")),
    }),
  )
  async uploadMusic(@CurrentUser() user: AuthUser, @Param("id") id: string, @UploadedFile() file?: Express.Multer.File) {
    userOnly(user);
    if (!file) throw new BadRequestException("send an audio file (mp3, m4a, wav…) in 'file'");
    try {
      const current = await this.projects.get(user.id, id);
      // Where the song should start: its loud part on the video's key moment (from the Suno prompt), or past a quiet intro.
      const energy = await songEnergy(join(MEDIA_DIR, file.filename));
      const length = (current.scene as { duration?: number } | null)?.duration ?? 0;
      const fit = energy ? { trimIn: fitSong(energy, length, current.sunoPrompt?.dropAt ?? null), summary: energy.summary, duration: energy.duration } : {};
      const { project, previous } = await this.projects.setMusic(user.id, id, { file: file.filename, name: file.originalname, mime: file.mimetype, ...fit });
      await removeMedia(previous);
      return this.view(project);
    } catch (e) {
      await removeMedia(file.filename);
      throw e;
    }
  }

  /** Claude writes (and the video keeps) the Suno prompt for its background music. */
  @Post(":id/suno-prompt")
  @HttpCode(200)
  async sunoPrompt(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: SunoPromptDto) {
    userOnly(user);
    return this.suno.write(user.id, id, dto.steer);
  }

  /** The user's own clip to edit: probed (length, size, contact sheet), then transcribed by the editor. */
  @Post(":id/footage")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname || "clip.mp4")) }),
      limits: { fileSize: MAX_FOOTAGE_BYTES },
      fileFilter: (_req, f, cb) => cb(null, VIDEO_TYPES.includes(f.mimetype)),
    }),
  )
  async uploadFootage(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UploadFootageDto, @UploadedFile() file?: Express.Multer.File) {
    userOnly(user);
    if (!file) throw new BadRequestException("send a video (mp4, mov or webm) in 'file'");
    try {
      await this.projects.get(user.id, id);
      const facts = await describeVideo(join(MEDIA_DIR, file.filename));
      const project = await this.projects.addFootage(user.id, id, {
        file: file.filename,
        name: file.originalname,
        mime: file.mimetype,
        size: file.size,
        duration: facts?.duration ?? null,
        width: facts?.width ?? null,
        height: facts?.height ?? null,
        poster: facts?.poster ?? null,
        language: dto.language ?? FOOTAGE_LANGUAGES[0],
        words: null,
      });
      return this.view(project);
    } catch (e) {
      await removeMedia(file.filename);
      throw e;
    }
  }

  @Put(":id/footage/:clipId/words")
  async setFootageWords(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("clipId") clipId: string, @Body() dto: FootageWordsDto) {
    userOnly(user);
    return this.view(await this.projects.setFootageWords(user.id, id, clipId, dto.words));
  }

  @Delete(":id/footage/:clipId")
  async removeFootage(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("clipId") clipId: string) {
    userOnly(user);
    const { project, clip } = await this.projects.removeFootage(user.id, id, clipId);
    await Promise.all([removeMedia(clip.file), removeMedia(clip.poster?.replace(/^\/media\//, ""))]);
    return this.view(project);
  }

  @Post(":id/audio")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname)) }),
      limits: { fileSize: MAX_AUDIO_BYTES },
      fileFilter: (_req, f, cb) => cb(null, f.mimetype.startsWith("audio/") || f.mimetype.startsWith("video/")),
    }),
  )
  async uploadAudio(@CurrentUser() user: AuthUser, @Param("id") id: string, @UploadedFile() file?: Express.Multer.File) {
    userOnly(user);
    if (!file) throw new BadRequestException("send an audio or video file in 'file'");
    const { project, previous } = await this.projects.setAudio(user.id, id, { file: file.filename, name: file.originalname, mime: file.mimetype });
    await removeMedia(previous);
    return this.view(project);
  }

  /**
   * The voice-over generated with the user's ElevenLabs key, stored like an uploaded file plus
   * when each word is said (captions and timing need no transcription). Replaces the previous one.
   */
  @Post(":id/voice")
  async generateVoice(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: GenerateVoiceDto) {
    userOnly(user);
    const project = await this.projects.get(user.id, id);
    const text = (dto.text ?? project.voiceScript).trim();
    if (!text) throw new BadRequestException("there is no script to read yet: write it first");
    const model = dto.modelId ?? VoiceModel.V4;
    const { audio, words } = await this.voice.speak(user.id, dto.voiceId, text, model);
    const file = mediaName("voice.mp3");
    await writeFile(join(MEDIA_DIR, file), audio);
    if (dto.text !== undefined && dto.text !== project.voiceScript) await this.projects.update(user.id, id, { voiceScript: dto.text });
    const name = `${dto.voiceName ?? "Voice"} · ElevenLabs.mp3`;
    const { project: saved, previous } = await this.projects.setAudio(user.id, id, { file, name, mime: "audio/mpeg", words, voice: { voiceId: dto.voiceId, model } });
    await removeMedia(previous);
    return this.view(saved);
  }

  @Delete(":id/audio")
  async deleteAudio(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    userOnly(user);
    const { project, previous } = await this.projects.setAudio(user.id, id, null);
    await removeMedia(previous);
    return this.view(project);
  }

  @Put(":id/scene")
  saveScene(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: SaveSceneDto) {
    return this.projects.saveScene(user.id, id, dto);
  }

  /** Catalog as this project sees it: official bricks plus the ones the agent made for it. */
  @Get(":id/bricks")
  async bricksFor(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() q: ListBricksQuery) {
    const project = await this.projects.get(user.id, id);
    return this.bricks.list(q, project._id);
  }

  @Post(":id/bricks")
  async createBrick(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: CreateBrickDto) {
    const project = await this.projects.get(user.id, id);
    return this.bricks.createPrivate(dto, user.id, project._id);
  }

  @Get(":id/feedback")
  async feedback(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const project = await this.projects.get(user.id, id);
    return this.projects.listFeedback(project._id);
  }

  @Post(":id/feedback")
  addFeedback(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: CreateFeedbackDto) {
    return this.projects.addFeedback(user.id, id, dto);
  }

  /** For the agent: pending feedback, marked as read. */
  @Post(":id/feedback/consume")
  @HttpCode(200)
  consumeFeedback(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.projects.consumeFeedback(user.id, id);
  }

  private async view(p: ProjectDocument) {
    return {
      id: p.id,
      name: p.name,
      brief: p.brief,
      wantsScript: p.wantsScript,
      voiceScript: p.voiceScript,
      references: p.references ?? [],
      build: p.build,
      format: p.format,
      brandId: p.brandId?.toString() ?? null,
      misfits: await this.projects.misfits(p),
      scene: p.scene,
      audio: p.audio ? { url: `/media/${p.audio.file}`, name: p.audio.name, mime: p.audio.mime, words: p.audio.words ?? null } : null,
      music: p.music ? { url: `/media/${p.music.file}`, name: p.music.name, trimIn: p.music.trimIn ?? 0, summary: p.music.summary ?? null, duration: p.music.duration ?? null } : null,
      sunoPrompt: p.sunoPrompt ?? null,
      postCopy: p.postCopy ?? [],
      footage: (p.footage ?? []).map((c) => ({ id: c.id, name: c.name, url: `/media/${c.file}`, mime: c.mime, size: c.size, duration: c.duration, width: c.width, height: c.height, poster: c.poster, language: c.language, words: c.words })),
      sceneRevision: p.sceneRevision,
      agentRuns: p.agentRuns ?? [],
      imageCredits: p.imageCredits ?? [],
      updatedAt: (p as unknown as { updatedAt: Date }).updatedAt,
    };
  }
}

/** Routes that stay in the user's hands even when an agent holds a project token. */
function userOnly(user: AuthUser) {
  if (user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
}
