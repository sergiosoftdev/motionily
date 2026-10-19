import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Prefab, PrefabKind } from "./prefab.schema";

export type SavePrefab = { description?: string; kind: PrefabKind; node: Record<string, unknown> };

@Injectable()
export class PrefabsService {
  constructor(@InjectModel(Prefab.name) private readonly prefabs: Model<Prefab>) {}

  list(ownerId: Types.ObjectId) {
    return this.prefabs.find({ ownerId }, { node: 0 }).sort({ updatedAt: -1 }).lean();
  }

  /** Full trees, for the engine library. */
  all(ownerId: Types.ObjectId) {
    return this.prefabs.find({ ownerId }, { name: 1, node: 1 }).lean();
  }

  async get(ownerId: Types.ObjectId, name: string) {
    const p = await this.prefabs.findOne({ ownerId, name }).lean();
    if (!p) throw new NotFoundException(`no prefab '${name}'`);
    return p;
  }

  /** Create or update; every save bumps the version. */
  save(ownerId: Types.ObjectId, name: string, dto: SavePrefab) {
    return this.prefabs.findOneAndUpdate(
      { ownerId, name },
      { $set: { description: dto.description ?? "", kind: dto.kind, node: dto.node }, $inc: { version: 1 }, $setOnInsert: { ownerId, name } },
      { upsert: true, returnDocument: "after" },
    );
  }

  async clone(ownerId: Types.ObjectId, from: string, to: string, description?: string) {
    const src = await this.get(ownerId, from);
    if (await this.prefabs.exists({ ownerId, name: to })) throw new ConflictException(`prefab '${to}' already exists`);
    return this.prefabs.create({ ownerId, name: to, description: description ?? src.description, kind: src.kind, node: src.node, parent: from });
  }

  async remove(ownerId: Types.ObjectId, name: string) {
    const res = await this.prefabs.deleteOne({ ownerId, name });
    if (!res.deletedCount) throw new NotFoundException(`no prefab '${name}'`);
  }
}
