import { Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, Param, ParseEnumPipe, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { IsEnum, IsMongoId, IsString, IsUrl, MaxLength, MinLength } from "class-validator";
import { SocialPlatform } from "./types";
import { CurrentUser, Public, TokenScope, type AuthUser } from "../auth/auth";
import { PostsService } from "../posts/posts.service";
import { SocialService } from "./social.service";

class InstagramTokenDto {
  @IsString() @MinLength(20) @MaxLength(1024) token: string;
}

class TikTokAppDto {
  @IsString() @MinLength(4) @MaxLength(256) clientKey: string;
  @IsString() @MinLength(4) @MaxLength(256) clientSecret: string;
  @IsUrl({ require_tld: false, protocols: ["https", "http"] }) redirectUri: string;
}

class TikTokFinishDto {
  @IsString() @MaxLength(4096) url: string;
}

class GoogleAppDto {
  @IsString() @MinLength(10) @MaxLength(256) clientId: string;
  @IsString() @MinLength(4) @MaxLength(256) clientSecret: string;
}

class LinkDto {
  @IsEnum(SocialPlatform) platform: SocialPlatform;
  @IsString() @MaxLength(512) url: string;
}

class LinkPublishedDto {
  @IsMongoId() projectId: string;
  @IsEnum(SocialPlatform) platform: SocialPlatform;
  @IsString() @MaxLength(128) videoId: string;
}

const platformPipe = new ParseEnumPipe(SocialPlatform);

function userOnly(user: AuthUser) {
  if (user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
  return user.id;
}

/** Where Google sends the user back: this API, as the browser reached it (register it in the Google Cloud client). */
const youtubeRedirect = (req: Request) => `${req.protocol}://${req.get("host")}/social/youtube/callback`;

/** The user's Instagram, TikTok and YouTube accounts (agents never see them). */
@Controller("social")
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get("accounts")
  async accounts(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return { accounts: await this.social.accounts(userOnly(user)), youtubeRedirect: youtubeRedirect(req) };
  }

  @Put("instagram")
  instagram(@CurrentUser() user: AuthUser, @Body() dto: InstagramTokenDto) {
    return this.social.connectInstagram(userOnly(user), dto.token);
  }

  @Post("tiktok/start")
  @HttpCode(200)
  tiktokStart(@CurrentUser() user: AuthUser, @Body() dto: TikTokAppDto) {
    return this.social.startTikTok(userOnly(user), { clientKey: dto.clientKey.trim(), clientSecret: dto.clientSecret.trim(), redirectUri: dto.redirectUri.trim() });
  }

  @Post("tiktok/finish")
  @HttpCode(200)
  tiktokFinish(@CurrentUser() user: AuthUser, @Body() dto: TikTokFinishDto) {
    return this.social.finishTikTok(userOnly(user), dto.url);
  }

  @Post("youtube/start")
  @HttpCode(200)
  youtubeStart(@CurrentUser() user: AuthUser, @Body() dto: GoogleAppDto, @Req() req: Request) {
    return this.social.startYouTube(userOnly(user), { clientId: dto.clientId.trim(), clientSecret: dto.clientSecret.trim(), redirectUri: youtubeRedirect(req) });
  }

  /** Google's redirect after the user allows access: a page that says so and closes. */
  @Public()
  @Get("youtube/callback")
  @Header("content-type", "text/html; charset=utf-8")
  async youtubeCallback(@Query("code") code?: string, @Query("state") state?: string, @Query("error") error?: string) {
    let message: string;
    try {
      if (error || !code || !state) throw new Error(error ?? "Google sent no code back");
      message = `YouTube connected${await this.social.finishYouTube(code, state).then((h) => (h ? ` as ${h}` : ""))}. You can close this tab and go back to Motionily.`;
    } catch (e) {
      message = `YouTube could not be connected: ${(e as Error).message}`;
    }
    const safe = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    return `<!doctype html><meta charset="utf-8"><title>Motionily</title><body style="font:15px system-ui;background:#0a0a0a;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p>${safe}</p><script>setTimeout(()=>window.close(),1500)</script>`;
  }

  @Delete(":platform")
  disconnect(@CurrentUser() user: AuthUser, @Param("platform", platformPipe) platform: SocialPlatform) {
    return this.social.disconnect(userOnly(user), platform);
  }

  /** The latest videos on the connected accounts, with what each is linked to here. */
  @Get("published")
  published(@CurrentUser() user: AuthUser) {
    return this.social.published(userOnly(user));
  }

  /** Link one of them to a video made here (posted outside the calendar). */
  @Post("published/link")
  @HttpCode(200)
  linkPublished(@CurrentUser() user: AuthUser, @Body() dto: LinkPublishedDto) {
    return this.social.linkPublished(userOnly(user), dto.projectId, dto.platform, dto.videoId);
  }

  /** Every posted video with its numbers: the dashboard. */
  @Get("channel")
  channel(@CurrentUser() user: AuthUser) {
    return this.social.channel(userOnly(user));
  }

  /** Match and measure everything posted in the last 90 days now (it also runs every few hours). */
  @Post("sync")
  @HttpCode(200)
  sync(@CurrentUser() user: AuthUser) {
    return this.social.sync(userOnly(user));
  }
}

/** A calendar post's published copies: link one by URL, unlink it, or refresh its numbers. */
@Controller("posts")
export class PostLinksController {
  constructor(
    private readonly social: SocialService,
    private readonly posts: PostsService,
  ) {}

  @Post(":id/links")
  @HttpCode(200)
  async link(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: LinkDto) {
    return this.posts.view(await this.social.link(userOnly(user), id, dto.platform, dto.url));
  }

  @Delete(":id/links/:platform")
  async unlink(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("platform", platformPipe) platform: SocialPlatform) {
    return this.posts.view(await this.social.unlink(userOnly(user), id, platform));
  }

  @Post(":id/sync")
  @HttpCode(200)
  async sync(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const owner = userOnly(user);
    const { errors } = await this.social.sync(owner, id);
    return { post: await this.posts.view(await this.posts.get(owner, id)), errors };
  }
}

/** How a video's posts did, for the user's editor and for the video's own agent. */
@Controller("projects")
export class PerformanceController {
  constructor(private readonly social: SocialService) {}

  @Get(":id/performance")
  performance(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.social.performance(user.id, id);
  }

  /** Every posted video of the account with its numbers, for the agent comparing what worked. */
  @Get(":id/channel")
  channel(@CurrentUser() user: AuthUser) {
    return this.social.channel(user.id);
  }
}
