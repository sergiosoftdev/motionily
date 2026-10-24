import { Body, Controller, Get, Injectable, Put } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { IsEnum, IsObject, IsOptional } from "class-validator";
import { Model, Types } from "mongoose";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { AGENT_NAME, AgentCli, agentCli, detectClis, type AgentChoice } from "../common/agent-cli";
import { User } from "./user.schema";

class AgentSettingsDto {
  /** The CLI that runs in-app generation; omitted = the server's default (MOTIONILY_AGENT). */
  @IsOptional() @IsEnum(AgentCli) cli?: AgentCli;
  /** Motionily tier (fable/opus/sonnet/haiku, or "*") → that CLI's model id. */
  @IsOptional() @IsObject() models?: Record<string, string>;
}

/** Which agent CLI each user runs, so everyone uses Motionily with the tool they prefer. */
@Injectable()
export class AgentSettingsService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  async forUser(id: Types.ObjectId): Promise<AgentChoice> {
    const u = await this.users.findById(id, { agentCli: 1, agentModels: 1 }).lean();
    return { cli: agentCli(u?.agentCli), models: u?.agentModels ?? undefined };
  }

  async save(id: Types.ObjectId, dto: AgentSettingsDto) {
    const models = Object.fromEntries(Object.entries(dto.models ?? {}).filter(([k, v]) => typeof v === "string" && v.trim() && k.length < 20).map(([k, v]) => [k, v.trim()]));
    await this.users.updateOne({ _id: id }, { $set: { agentCli: dto.cli ?? null, agentModels: Object.keys(models).length ? models : null } });
  }
}

@Controller("settings/agent")
export class AgentSettingsController {
  constructor(private readonly settings: AgentSettingsService) {}

  /** The user's choice, the server default and which CLIs are installed on this machine. */
  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const choice = await this.settings.forUser(user.id);
    const installed = await detectClis();
    return {
      cli: choice.cli,
      models: choice.models ?? {},
      defaultCli: agentCli(),
      clis: Object.values(AgentCli).map((cli) => ({ cli, name: AGENT_NAME[cli], version: installed[cli] ?? null })),
    };
  }

  @Put()
  async put(@CurrentUser() user: AuthUser, @Body() dto: AgentSettingsDto) {
    await this.settings.save(user.id, dto);
    return this.get(user);
  }
}
