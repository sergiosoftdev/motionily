import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BadGatewayException, BadRequestException, Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { MAX_REFERENCE_BYTES, MEDIA_DIR, mediaName } from "../media";
import { ProjectsService } from "../projects/projects.service";
import { downloadImage, ImageSource, resolveImage, searchImages, type ImageCredit } from "./image-search";

const MAX_HITS = 12;

class SearchImagesQuery {
  @IsString() @MinLength(2) @MaxLength(120) q: string;
  @IsOptional() @IsEnum(ImageSource) source?: ImageSource;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_HITS) limit?: number;
}

class ImportImageDto {
  @IsString() @MinLength(3) @MaxLength(300) id: string;
}

/** Real photos for a video: the agent searches free libraries and imports what it picks, with its credit. */
@Controller("projects/:id/images")
export class ImagesController {
  constructor(private readonly projects: ProjectsService) {}

  @Get("search")
  async search(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: SearchImagesQuery) {
    await this.projects.get(user.id, id);
    return searchImages(query.q, query.limit ?? 8, query.source);
  }

  /** Download into /media and remember the attribution; importing the same image again reuses it. */
  @Post()
  async import(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: ImportImageDto): Promise<ImageCredit> {
    const project = await this.projects.get(user.id, id);
    const image = await resolveImage(dto.id).catch((e: Error) => {
      throw new BadRequestException(e.message);
    });
    const known = project.imageCredits?.find((c) => c.pageUrl === image.credit.pageUrl);
    if (known) return known;
    const [file, small] = await Promise.all([
      downloadImage(image.download, MAX_REFERENCE_BYTES),
      // The preview only spares the agent's context: without it, it looks at the full image.
      downloadImage(image.preview, MAX_REFERENCE_BYTES).catch(() => null),
    ]).catch((e: Error) => {
      throw new BadGatewayException(e.message);
    });
    const save = async (f: { bytes: Buffer; ext: string }) => {
      const name = mediaName(`image${f.ext}`);
      await writeFile(join(MEDIA_DIR, name), f.bytes);
      return `/media/${name}`;
    };
    const credit = { src: await save(file), ...(small ? { preview: await save(small) } : {}), ...image.credit };
    await this.projects.addImageCredit(id, credit);
    return credit;
  }
}
