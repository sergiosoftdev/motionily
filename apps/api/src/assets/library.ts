import { Controller, Delete, ForbiddenException, Get, Injectable, NotFoundException, Param, Query } from "@nestjs/common";
import { InjectModel, Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, Max, Min } from "class-validator";
import { HydratedDocument, Model, Schema as MongooseSchema, Types } from "mongoose";
import { CurrentUser, TokenScope, type AuthUser } from "../auth/auth";
import { removeMedia } from "../media";
import { AssetFormat, AssetKind, AssetSource, type AssetCredit, type AssetHit } from "./asset-types";

/**
 * The user's asset library: everything an agent imported, cut out or generated, reusable in every
 * video like sounds and prefabs. Search hits from it come first, so a logo found once is not
 * searched for again.
 */
@Schema({ timestamps: true })
export class LibraryAsset {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId: Types.ObjectId;
  /** The search id it was imported from (or generated:/cutout: ids), so importing again reuses it. */
  @Prop({ required: true }) sourceId: string;
  @Prop({ required: true, enum: AssetKind, type: String }) kind: AssetKind;
  @Prop({ required: true, enum: AssetFormat, type: String }) format: AssetFormat;
  @Prop({ required: true }) title: string;
  /** Lowercase words it is found by (query words, title words). */
  @Prop({ type: [String], default: [] }) tags: string[];
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) credit: AssetCredit;
  /** Videos that used it. */
  @Prop({ type: [Types.ObjectId], default: [] }) projects: Types.ObjectId[];
}

export type LibraryAssetDocument = HydratedDocument<LibraryAsset>;
export const LibraryAssetSchema = SchemaFactory.createForClass(LibraryAsset);
LibraryAssetSchema.index({ ownerId: 1, sourceId: 1 }, { unique: true });

const STOP = new Set(["the", "and", "with", "for", "from", "logo", "photo", "image", "texture", "of", "in", "on", "a", "an"]);
const MIN_WORD = 3;
/** How many recent items of a kind a library search scores. */
const SCAN = 300;

export const words = (...texts: string[]) => [...new Set(texts.join(" ").toLowerCase().split(/[^a-z0-9áéíóúüñ]+/i).filter((w) => w.length >= MIN_WORD && !STOP.has(w)))];

@Injectable()
export class LibraryService {
  constructor(@InjectModel(LibraryAsset.name) private readonly assets: Model<LibraryAsset>) {}

  bySource(ownerId: Types.ObjectId, sourceId: string) {
    return this.assets.findOne({ ownerId, sourceId });
  }

  async get(ownerId: Types.ObjectId, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("not in your library");
    const a = await this.assets.findOne({ _id: id, ownerId });
    if (!a) throw new NotFoundException("not in your library");
    return a;
  }

  /** Keep an import in the library (same source = same item) and note the video using it. */
  async add(ownerId: Types.ObjectId, projectId: string, sourceId: string, credit: AssetCredit, query = "") {
    const kind = credit.kind ?? (credit.format === AssetFormat.Video ? AssetKind.Footage : credit.format === AssetFormat.Svg ? AssetKind.Logo : AssetKind.Photo);
    const format = credit.format ?? AssetFormat.Raster;
    const doc = await this.assets.findOneAndUpdate(
      { ownerId, sourceId },
      {
        $setOnInsert: { ownerId, sourceId, kind, format, title: credit.title, credit },
        $addToSet: { tags: { $each: words(query, credit.title) }, projects: new Types.ObjectId(projectId) },
      },
      { upsert: true, new: true },
    );
    return doc!;
  }

  async markUsed(id: Types.ObjectId, projectId: string) {
    await this.assets.updateOne({ _id: id }, { $addToSet: { projects: new Types.ObjectId(projectId) } });
  }

  /** Library items matching the words of a query, best first. */
  async search(ownerId: Types.ObjectId, q: string, kind: AssetKind, limit: number): Promise<AssetHit[]> {
    const want = words(q);
    if (!want.length) return [];
    const kinds = kind === AssetKind.Photo || kind === AssetKind.Texture ? [AssetKind.Photo, AssetKind.Texture] : [kind];
    const rows = await this.assets.find({ ownerId, kind: { $in: kinds } }).sort({ updatedAt: -1 }).limit(SCAN).lean();
    return rows
      .map((r) => ({ r, score: want.filter((w) => r.tags.includes(w) || r.title.toLowerCase().includes(w)).length }))
      .filter((x) => x.score >= Math.min(2, want.length))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ r }) => toHit(r, kind));
  }

  list(ownerId: Types.ObjectId, kind?: AssetKind, limit = 100) {
    return this.assets
      .find({ ownerId, ...(kind ? { kind } : {}) })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();
  }

  /** Remove an item and its files (videos that show it lose the image). */
  async remove(ownerId: Types.ObjectId, id: string) {
    const a = await this.get(ownerId, id);
    await a.deleteOne();
    const c = a.credit;
    await Promise.all([c.src, c.preview, c.svg, c.poster].filter((f): f is string => !!f).map((f) => removeMedia(f.replace(/^\/media\//, ""))));
  }
}

export function toHit(r: Pick<LibraryAsset, "kind" | "format" | "title" | "credit"> & { _id: Types.ObjectId }, kind = r.kind): AssetHit {
  const c = r.credit;
  return {
    id: `${AssetSource.Library}:${r._id.toString()}`,
    kind,
    source: AssetSource.Library,
    format: r.format,
    title: r.title,
    description: `in your library (${c.source})`,
    author: c.author,
    license: c.license,
    date: "",
    width: c.width ?? 0,
    height: c.height ?? 0,
    // Media paths are made absolute by the controller before the contact sheet fetches them.
    thumb: c.poster ?? c.preview ?? c.src,
    ...(c.duration ? { duration: c.duration } : {}),
    ...(c.editorial ? { editorial: true } : {}),
    library: true,
  };
}

/** A library item as the user and the agent list it. */
export const libraryRow = (r: Pick<LibraryAsset, "kind" | "format" | "title" | "credit" | "projects"> & { _id: Types.ObjectId }) => ({
  id: `${AssetSource.Library}:${r._id.toString()}`,
  kind: r.kind,
  format: r.format,
  title: r.title,
  credit: r.credit,
  videos: r.projects.length,
});

export class LibraryQuery {
  @IsOptional() @IsEnum(AssetKind) kind?: AssetKind;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

/** The library as the user sees it (Settings › Library). */
@Controller("library")
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() query: LibraryQuery) {
    const rows = await this.library.list(userOnly(user), query.kind, query.limit);
    return rows.map(libraryRow);
  }

  @Delete(":assetId")
  async remove(@CurrentUser() user: AuthUser, @Param("assetId") assetId: string) {
    await this.library.remove(userOnly(user), assetId.replace(`${AssetSource.Library}:`, ""));
    return { ok: true };
  }
}

function userOnly(user: AuthUser) {
  if (user.scope !== TokenScope.User) throw new ForbiddenException("only the user can do this");
  return user.id;
}
