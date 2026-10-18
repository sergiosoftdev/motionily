import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
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

export type JwtPayload = { sub: string; email: string };
export type AuthUser = { id: Types.ObjectId; email: string };

type AuthedRequest = { headers: Record<string, string | undefined>; user?: AuthUser };

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
      req.user = { id: new Types.ObjectId(payload.sub), email: payload.email };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user!,
);
