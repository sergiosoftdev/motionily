import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { CurrentUser, TokenScope, type AuthUser } from "../auth/auth";
import { MEDIA_DIR, mediaName, removeMedia } from "../media";
import { CopywriterService } from "./copywriter";
import { CreatePostDto, ListPostsQuery, UpdatePostDto, UploadPostVideoDto, WriteCopyDto } from "./posts.dto";
import { PostsService } from "./posts.service";

/** A rendered reel: 1080p for a couple of minutes stays well under this. */
const MAX_POST_VIDEO_BYTES = 500 * 1024 * 1024;
/** What the editor's export produces (MP4 where the browser can encode it, WebM otherwise). */
const POST_VIDEO_TYPES = ["video/mp4", "video/webm"];

/** Agents never schedule or read the user's posting plan. */
function userOnly(user: AuthUser) {
  if (user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
  return user.id;
}

/** The posting calendar: videos scheduled for Instagram, TikTok and YouTube Shorts, with their captions and files. */
@Controller("posts")
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly copywriter: CopywriterService,
  ) {}

  /** Caption and hashtags for each platform, written from the video; nothing is saved. */
  @Post("copy")
  @HttpCode(200)
  async writeCopy(@CurrentUser() user: AuthUser, @Body() dto: WriteCopyDto) {
    return { copy: await this.copywriter.write(userOnly(user), dto) };
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListPostsQuery) {
    return this.posts.list(userOnly(user), q);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePostDto) {
    return this.posts.create(userOnly(user), dto);
  }

  @Patch(":id")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UpdatePostDto) {
    return this.posts.update(userOnly(user), id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await removeMedia(await this.posts.remove(userOnly(user), id));
  }

  /** The rendered video, uploaded by the editor right after it exports it. */
  @Post(":id/video")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname || "video.mp4")) }),
      limits: { fileSize: MAX_POST_VIDEO_BYTES },
      fileFilter: (_req, f, cb) => cb(null, POST_VIDEO_TYPES.includes(f.mimetype)),
    }),
  )
  async uploadVideo(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UploadPostVideoDto, @UploadedFile() file?: Express.Multer.File) {
    const owner = userOnly(user);
    if (!file) throw new BadRequestException("send the rendered MP4 or WebM in 'file'");
    try {
      const { post, previous } = await this.posts.setVideo(owner, id, { file: file.filename, mime: file.mimetype, size: file.size, sceneRevision: dto.sceneRevision });
      await removeMedia(previous);
      return post;
    } catch (e) {
      await removeMedia(file.filename);
      throw e;
    }
  }
}
