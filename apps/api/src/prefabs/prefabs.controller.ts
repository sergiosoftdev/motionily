import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { PrefabsService } from "./prefabs.service";
import { ClonePrefabDto, EditPrefabDto } from "./prefabs.dto";
import { ProjectsService } from "../projects/projects.service";
import { BrandsService } from "../brands/brands.service";
import { GenerateService } from "../projects/generate.service";

/** The signed-in user's prefab library, for the profile screen. */
@Controller("prefabs")
export class PrefabsController {
  constructor(
    private readonly prefabs: PrefabsService,
    private readonly projects: ProjectsService,
    private readonly brands: BrandsService,
    private readonly generator: GenerateService,
  ) {}

  /** The hidden workshop video the prefab screen previews and the agent edits in. */
  @Get("-/workshop")
  async workshop(@CurrentUser() user: AuthUser) {
    const brand = await this.brands.ensureDefault(user.id);
    const w = await this.projects.workshop(user.id, brand._id);
    return { videoId: w.id };
  }

  /** Create a new prefab from a prompt ("monigote con bata"): the agent designs, saves and shows it. */
  @Post("-/create")
  async create(@CurrentUser() user: AuthUser, @Body() dto: EditPrefabDto) {
    const brand = await this.brands.ensureDefault(user.id);
    const w = await this.projects.workshop(user.id, brand._id);
    const instruction =
      `PREFAB WORKSHOP, not a video. Create a NEW prefab: ${dto.instruction}. ` +
      `list_prefabs first (reuse pieces with {"prefab":…} inside the tree when useful), design it from primitives/rigs ` +
      `(see get_reference: 3D procedural building), pick a short snake_case name in English, save_prefab with a clear description, ` +
      `then show it on the turntable: apply_ops [{"op":"put_prop","prop":{"id":"preview","prefab":<name>}}]. ` +
      `render_frames at 0.5 and 3 to check it reads well from every side; fix and save again if needed. Do not add 2D layers.`;
    const status = await this.generator.start(user.id, user.email, w.id, { instruction, model: dto.model, effort: dto.effort });
    return { videoId: w.id, ...status };
  }

  /** Reshape a prefab with a prompt: the agent runs on the workshop video. */
  @Post(":name/edit")
  async edit(@CurrentUser() user: AuthUser, @Param("name") name: string, @Body() dto: EditPrefabDto) {
    await this.prefabs.get(user.id, name);
    const brand = await this.brands.ensureDefault(user.id);
    const w = await this.projects.workshop(user.id, brand._id);
    const instruction =
      `PREFAB WORKSHOP, not a video. Edit only the prefab '${name}': ${dto.instruction}. ` +
      `get_prefab ${name}, change its tree, save_prefab ${name} (or clone_prefab first if a new variant is asked for). ` +
      `The editor shows it on a turntable: render_frames at 0.5 and 3 to check. Do not touch the scene layers or other prefabs.`;
    const status = await this.generator.start(user.id, user.email, w.id, { instruction, model: dto.model, effort: dto.effort });
    return { videoId: w.id, ...status };
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("full") full?: string) {
    return full ? this.prefabs.all(user.id) : this.prefabs.list(user.id);
  }

  @Get(":name")
  get(@CurrentUser() user: AuthUser, @Param("name") name: string) {
    return this.prefabs.get(user.id, name);
  }

  @Post(":name/clone")
  clone(@CurrentUser() user: AuthUser, @Param("name") name: string, @Body() dto: ClonePrefabDto) {
    return this.prefabs.clone(user.id, name, dto.name, dto.description);
  }

  @Delete(":name")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param("name") name: string) {
    return this.prefabs.remove(user.id, name);
  }
}
