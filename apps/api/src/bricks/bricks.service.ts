import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Brick, BrickDocument } from "./brick.schema";
import { BrickSlot, BrickVisibility, EngineSupport } from "./brick.enums";
import { CATALOG, brickKey } from "./seed/catalog";
import type { CreateBrickDto, ListBricksQuery } from "./bricks.dto";

@Injectable()
export class BricksService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BricksService.name);

  constructor(@InjectModel(Brick.name) private readonly bricks: Model<Brick>) {}

  async onApplicationBootstrap() {
    await this.seed();
  }

  /** Upsert the official catalog. A brick is rewritten only when its version goes up. */
  async seed() {
    let changed = 0;
    for (const b of CATALOG) {
      const key = brickKey(b.slot, b.id);
      const version = b.version ?? 1;
      const res = await this.bricks.updateOne(
        { key, projectId: null, version: { $lt: version } },
        {
          $set: {
            key,
            slot: b.slot,
            name: b.name,
            description: b.description,
            tags: b.tags ?? [],
            fits: (b.fits ?? []).map((id) => brickKey(BrickSlot.MotionStyle, id)),
            payload: b.payload ?? {},
            params: b.params ?? [],
            engine: b.engine ?? EngineSupport.Planned,
            visibility: BrickVisibility.Official,
            version,
          },
        },
        { upsert: true },
      ).catch((e: { code?: number }) => {
        // Duplicate key: same key already at this version or newer. Nothing to do.
        if (e.code === 11000) return null;
        throw e;
      });
      if (res && (res.upsertedCount || res.modifiedCount)) changed++;
    }
    if (changed) this.logger.log(`catalog: ${changed} bricks updated`);
  }

  /** Official bricks plus the private ones of `projectId`, if given. */
  list(q: ListBricksQuery, projectId?: Types.ObjectId) {
    const filter: Record<string, unknown> = {
      $or: [{ visibility: BrickVisibility.Official }, ...(projectId ? [{ projectId }] : [])],
    };
    if (q.slot) filter.slot = q.slot;
    if (q.fits) filter.fits = { $in: [q.fits, []] };
    if (q.q) filter.name = { $regex: escapeRegex(q.q), $options: "i" };
    return this.bricks.find(filter).sort({ slot: 1, name: 1 }).lean();
  }

  async get(key: string, projectId?: Types.ObjectId): Promise<BrickDocument> {
    const brick = await this.bricks.findOne({
      key,
      $or: [{ visibility: BrickVisibility.Official }, ...(projectId ? [{ projectId }] : [])],
    });
    if (!brick) throw new NotFoundException(`brick '${key}' not found`);
    return brick;
  }

  /** Bricks the agent invents for one project (e.g. an animation that did not exist). */
  async createPrivate(dto: CreateBrickDto, ownerId: Types.ObjectId, projectId: Types.ObjectId) {
    const key = brickKey(dto.slot, dto.id);
    const official = await this.bricks.exists({ key, visibility: BrickVisibility.Official });
    if (official) throw new BadRequestException(`'${key}' is an official brick; pick another id`);
    return this.bricks.findOneAndUpdate(
      { key, projectId },
      {
        $set: {
          key,
          slot: dto.slot,
          name: dto.name,
          description: dto.description ?? "",
          tags: dto.tags ?? [],
          fits: dto.fits ?? [],
          payload: dto.payload ?? {},
          params: [],
          engine: EngineSupport.Planned,
          visibility: BrickVisibility.Private,
          ownerId,
          projectId,
        },
        $inc: { version: 1 },
      },
      { upsert: true, returnDocument: "after" },
    );
  }
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
