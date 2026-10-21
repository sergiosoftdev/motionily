import { Body, Controller, Delete, ForbiddenException, Get, Put } from "@nestjs/common";
import { IsString, MaxLength, MinLength } from "class-validator";
import { CurrentUser, TokenScope, type AuthUser } from "../auth/auth";
import { VoiceService } from "./voice.service";

class ElevenLabsKeyDto {
  @IsString() @MinLength(16) @MaxLength(256) apiKey: string;
}

/** The user's ElevenLabs connection and voices (agent tokens never see either). */
@Controller("voice")
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Get("elevenlabs")
  status(@CurrentUser() user: AuthUser) {
    return this.voice.status(userOnly(user));
  }

  @Put("elevenlabs")
  connect(@CurrentUser() user: AuthUser, @Body() dto: ElevenLabsKeyDto) {
    return this.voice.connect(userOnly(user), dto.apiKey);
  }

  @Delete("elevenlabs")
  disconnect(@CurrentUser() user: AuthUser) {
    return this.voice.disconnect(userOnly(user));
  }

  @Get("voices")
  voices(@CurrentUser() user: AuthUser) {
    return this.voice.voices(userOnly(user));
  }
}

function userOnly(user: AuthUser) {
  if (user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
  return user.id;
}
