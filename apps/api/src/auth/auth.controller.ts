import { Body, Controller, ForbiddenException, Get, NotFoundException, Post } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";
import { Model } from "mongoose";
import { AuthProvider, User } from "../users/user.schema";
import { CurrentUser, Public, TokenScope, type AuthUser, type JwtPayload } from "./auth";

class MockLoginDto {
  @IsEmail() email: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
}

/**
 * Simulated "Sign in with Google": any email logs in and gets a real JWT.
 * Swapping it for Google OAuth only changes how the user is identified here.
 */
@Controller("auth")
export class AuthController {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Post("mock-google")
  async mockGoogle(@Body() dto: MockLoginDto) {
    const email = dto.email.toLowerCase();
    const user = await this.users.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, name: dto.name ?? email.split("@")[0], provider: AuthProvider.Mock } },
      { upsert: true, returnDocument: "after" },
    );
    const payload: JwtPayload = { sub: user.id, email: user.email };
    return { token: await this.jwt.signAsync(payload), user: toUserView(user) };
  }

  /** A token the user pastes into their agent (MCP) so it can create videos and work on any of them. */
  @Post("agent-token")
  async agentToken(@CurrentUser() user: AuthUser) {
    if (user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
    const payload: JwtPayload = { sub: user.id.toString(), email: user.email, scope: TokenScope.Account };
    return { token: await this.jwt.signAsync(payload, { expiresIn: "90d" }) };
  }

  @Get("me")
  async me(@CurrentUser() auth: AuthUser) {
    const user = await this.users.findById(auth.id);
    if (!user) throw new NotFoundException();
    return toUserView(user);
  }
}

function toUserView(u: { id: string; email: string; name: string; avatarUrl?: string; provider: AuthProvider }) {
  return { id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl ?? null, provider: u.provider };
}
