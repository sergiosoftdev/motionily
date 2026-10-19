import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Types } from "mongoose";

const IS_PUBLIC = "isPublic";
/** Opt a route out of the global JWT guard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export enum TokenScope {
  /** Full account access, from signing in. */
  User = "user",
  /** One project only, handed to an agent (MCP). */
  Agent = "agent",
  /** The agent's headless editor: reads anything of the account, writes only its project. */
  Editor = "editor",
}

export type JwtPayload = { sub: string; email: string; scope?: TokenScope; projectId?: string };
export type AuthUser = { id: Types.ObjectId; email: string; scope: TokenScope; projectId?: string };

type AuthedRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  user?: AuthUser;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !token) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      req.user = {
        id: new Types.ObjectId(payload.sub),
        email: payload.email,
        scope: payload.scope ?? TokenScope.User,
        projectId: payload.projectId,
      };
    } catch {
      throw new UnauthorizedException();
    }
    // Agent tokens only reach their own project.
    if (req.user.scope === TokenScope.Agent && req.params?.id !== req.user.projectId) {
      throw new ForbiddenException("agent token is limited to its project");
    }
    if (req.user.scope === TokenScope.Editor) {
      const own = `/projects/${req.user.projectId}`;
      const path = (req.url ?? "").split("?")[0];
      const onOwn = path === own || path.startsWith(`${own}/`);
      if (path.startsWith("/projects/") && req.params?.id && !onOwn) throw new ForbiddenException("editor token is limited to its project");
      if (req.method !== "GET" && !onOwn) throw new ForbiddenException("editor token can only change its project");
    }
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user!,
);
