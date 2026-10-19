import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { removeMedia } from "../media";
import { AssetKind, Brand, BrandAsset } from "./brand.schema";
import type { AssetMetaDto, CreateBrandDto, UpdateBrandDto } from "./brands.dto";

export const DEFAULT_BRAND_NAME = "Mi proyecto";

@Injectable()
export class BrandsService {
  constructor(
    @InjectModel(Brand.name) private readonly brands: Model<Brand>,
    @InjectModel(BrandAsset.name) private readonly assets: Model<BrandAsset>,
  ) {}

  list(ownerId: Types.ObjectId) {
    return this.brands.find({ ownerId }).sort({ updatedAt: -1 }).lean();
  }

  async get(ownerId: Types.ObjectId, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException("project not found");
    const brand = await this.brands.findOne({ _id: id, ownerId });
    if (!brand) throw new NotFoundException("project not found");
    return brand;
  }

  create(ownerId: Types.ObjectId, dto: CreateBrandDto) {
    return this.brands.create({ ownerId, name: dto.name, notes: dto.notes ?? "" });
  }

  /** Videos made before projects existed land in a default project. */
  async ensureDefault(ownerId: Types.ObjectId) {
    return (await this.brands.findOne({ ownerId }).sort({ createdAt: 1 })) ?? this.brands.create({ ownerId, name: DEFAULT_BRAND_NAME });
  }

  async update(ownerId: Types.ObjectId, id: string, dto: UpdateBrandDto) {
    const brand = await this.get(ownerId, id);
    if (dto.name !== undefined) brand.name = dto.name;
    if (dto.notes !== undefined) brand.notes = dto.notes;
    if (dto.palettes !== undefined) brand.palettes = dto.palettes;
    return brand.save();
  }

  async remove(ownerId: Types.ObjectId, id: string) {
    const brand = await this.get(ownerId, id);
    const assets = await this.assets.find({ brandId: brand._id }).lean();
    await Promise.all(assets.map((a) => removeMedia(a.file)));
    await this.assets.deleteMany({ brandId: brand._id });
    await brand.deleteOne();
  }

  listAssets(brandId: Types.ObjectId) {
    return this.assets.find({ brandId }).sort({ createdAt: 1 }).lean();
  }

  addAsset(brandId: Types.ObjectId, file: { filename: string; originalname: string; mimetype: string }, meta: AssetMetaDto) {
    return this.assets.create({
      brandId,
      file: file.filename,
      mime: file.mimetype,
      kind: meta.kind ?? AssetKind.Other,
      name: meta.name ?? file.originalname.replace(/\.[^.]+$/, ""),
      description: meta.description ?? "",
    });
  }

  async updateAsset(brandId: Types.ObjectId, assetId: string, meta: AssetMetaDto) {
    const asset = await this.assets.findOne({ _id: assetId, brandId });
    if (!asset) throw new NotFoundException("asset not found");
    if (meta.kind) asset.kind = meta.kind;
    if (meta.name !== undefined) asset.name = meta.name;
    if (meta.description !== undefined) asset.description = meta.description;
    return asset.save();
  }

  async removeAsset(brandId: Types.ObjectId, assetId: string) {
    const asset = await this.assets.findOneAndDelete({ _id: assetId, brandId });
    if (!asset) throw new NotFoundException("asset not found");
    await removeMedia(asset.file);
  }
}
