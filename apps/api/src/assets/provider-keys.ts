import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Param, ParseEnumPipe, Put } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { IsString, MaxLength, MinLength } from "class-validator";
import { Model, Types } from "mongoose";
import { CurrentUser, TokenScope, type AuthUser } from "../auth/auth";
import { User } from "../users/user.schema";
import { seal, unseal, type Sealed } from "../voice/secrets";
import type { SourceKeys } from "./asset-types";

/**
 * The user's own keys for asset sources (BYOK): stock libraries, web image search, image
 * generation. Stored encrypted, only ever sent to their provider. Free stock libraries may also
 * run on the platform's key (env); paid ones only ever use the user's.
 */
export enum ProviderKey {
  Pexels = "pexels",
  Pixabay = "pixabay",
  Brave = "brave",
  OpenAI = "openai",
  Europeana = "europeana",
}

/** Platform keys (env) for free sources only. */
const PLATFORM_ENV: Partial<Record<ProviderKey, string>> = {
  [ProviderKey.Pexels]: "PEXELS_API_KEY",
  [ProviderKey.Pixabay]: "PIXABAY_API_KEY",
  [ProviderKey.Europeana]: "EUROPEANA_API_KEY",
};
const HINT_CHARS = 4;
const CHECK_TIMEOUT_MS = 10_000;

/** A cheap call that only succeeds with a valid key. */
const CHECKS: Record<ProviderKey, (key: string) => Promise<Response>> = {
  [ProviderKey.Pexels]: (key) => fetch("https://api.pexels.com/v1/search?query=paper&per_page=1", { headers: { Authorization: key }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
  [ProviderKey.Pixabay]: (key) => fetch(`https://pixabay.com/api/?${new URLSearchParams({ key, q: "paper", per_page: "3" })}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
  [ProviderKey.Brave]: (key) =>
    fetch("https://api.search.brave.com/res/v1/images/search?q=paper&count=1", { headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
  [ProviderKey.OpenAI]: (key) => fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
  [ProviderKey.Europeana]: (key) => fetch(`https://api.europeana.eu/record/v2/search.json?${new URLSearchParams({ wskey: key, query: "paper", rows: "1" })}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
};

export type ProviderStatus = { provider: ProviderKey; connected: boolean; hint: string | null; platform: boolean };

@Injectable()
export class ProviderKeysService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  async status(userId: Types.ObjectId): Promise<ProviderStatus[]> {
    const u = await this.users.findById(userId, { providerHints: 1 }).lean();
    return Object.values(ProviderKey).map((provider) => {
      const hint = u?.providerHints?.[provider] ?? null;
      return { provider, connected: !!hint, hint, platform: !!platformKey(provider) };
    });
  }

  async connect(userId: Types.ObjectId, provider: ProviderKey, apiKey: string) {
    const key = apiKey.trim();
    const res = await CHECKS[provider](key).catch(() => null);
    if (!res) throw new BadRequestException(`${provider} could not be reached to check the key: try again`);
    if (!res.ok) throw new BadRequestException(res.status === 429 ? `${provider} is rate limiting: try again in a minute` : `${provider} refused this key (${res.status})`);
    const hint = key.slice(-HINT_CHARS);
    await this.users.updateOne({ _id: userId }, { $set: { [`providerKeys.${provider}`]: seal(key), [`providerHints.${provider}`]: hint } });
    return this.status(userId);
  }

  async disconnect(userId: Types.ObjectId, provider: ProviderKey) {
    await this.users.updateOne({ _id: userId }, { $unset: { [`providerKeys.${provider}`]: 1, [`providerHints.${provider}`]: 1 } });
    return this.status(userId);
  }

  /** The user's key, else the platform's (free sources only), else null. */
  async keyFor(userId: Types.ObjectId, provider: ProviderKey): Promise<string | null> {
    const u = await this.users.findById(userId).select("+providerKeys").lean();
    const sealed = (u?.providerKeys as Record<string, Sealed> | undefined)?.[provider];
    if (sealed) {
      try {
        return unseal(sealed);
      } catch {
        // Unreadable (rotated secret): fall back like a missing key.
      }
    }
    return platformKey(provider);
  }

  async sourceKeys(userId: Types.ObjectId): Promise<SourceKeys> {
    const [pexels, pixabay, brave, europeana] = await Promise.all([ProviderKey.Pexels, ProviderKey.Pixabay, ProviderKey.Brave, ProviderKey.Europeana].map((p) => this.keyFor(userId, p)));
    return { pexels: pexels ?? undefined, pixabay: pixabay ?? undefined, brave: brave ?? undefined, europeana: europeana ?? undefined };
  }
}

function platformKey(provider: ProviderKey) {
  const env = PLATFORM_ENV[provider];
  return (env && process.env[env]?.trim()) || null;
}

class ProviderKeyDto {
  @IsString() @MinLength(8) @MaxLength(512) apiKey: string;
}

/** Settings › Asset sources (agent tokens never see these routes). */
@Controller("keys")
export class ProviderKeysController {
  constructor(private readonly keys: ProviderKeysService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.keys.status(userOnly(user));
  }

  @Put(":provider")
  connect(@CurrentUser() user: AuthUser, @Param("provider", new ParseEnumPipe(ProviderKey)) provider: ProviderKey, @Body() dto: ProviderKeyDto) {
    return this.keys.connect(userOnly(user), provider, dto.apiKey);
  }

  @Delete(":provider")
  disconnect(@CurrentUser() user: AuthUser, @Param("provider", new ParseEnumPipe(ProviderKey)) provider: ProviderKey) {
    return this.keys.disconnect(userOnly(user), provider);
  }
}

function userOnly(user: AuthUser) {
  if (user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
  return user.id;
}
