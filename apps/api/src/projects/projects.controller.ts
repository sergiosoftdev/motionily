import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { BricksService } from "../bricks/bricks.service";
import { CreateBrickDto, ListBricksQuery } from "../bricks/bricks.dto";
import { BrickSlot } from "../bricks/brick.enums";
import { ProjectsService } from "./projects.service";
import { CreateFeedbackDto, CreateProjectDto, SaveSceneDto, SetSlotDto, UpdateProjectDto } from "./projects.dto";
import type { ProjectDocument } from "./project.schema";

@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly bricks: BricksService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.projects.list(user.id);
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.view(await this.projects.create(user.id, dto));
  }

  @Get(":id")
  async get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.view(await this.projects.get(user.id, id));
  }

  @Patch(":id")
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UpdateProjectDto) {
    return this.view(await this.projects.update(user.id, id, dto));
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.projects.remove(user.id, id);
  }

  @Put(":id/build/:slot")
  async setSlot(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("slot") slot: BrickSlot,
    @Body() dto: SetSlotDto,
  ) {
    return this.view(await this.projects.setSlot(user.id, id, slot, dto));
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
      build: p.build,
      misfits: await this.projects.misfits(p),
      scene: p.scene,
      sceneRevision: p.sceneRevision,
      updatedAt: (p as unknown as { updatedAt: Date }).updatedAt,
    };
  }
}
