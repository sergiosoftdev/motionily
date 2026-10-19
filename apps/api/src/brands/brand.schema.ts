import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

/** Five colors, same shape as palette bricks. */
@Schema({ _id: false })
export class BrandPalette {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) background: string;
  @Prop({ required: true }) surface: string;
  @Prop({ required: true }) primary: string;
  @Prop({ required: true }) accent: string;
  @Prop({ required: true }) text: string;
}
const BrandPaletteSchema = SchemaFactory.createForClass(BrandPalette);

/**
 * A user's project: the brand/product its videos are about. Holds the brand kit
 * (notes, palettes, logos, screenshots) the agent designs with.
 */
@Schema({ timestamps: true })
export class Brand {
  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true }) ownerId: Types.ObjectId;
  @Prop({ required: true, trim: true }) name: string;
  /** What the product is, who it's for, tone of voice… in the user's words. */
  @Prop({ default: "" }) notes: string;
  @Prop({ type: [BrandPaletteSchema], default: [] }) palettes: BrandPalette[];
}

export type BrandDocument = HydratedDocument<Brand>;
export const BrandSchema = SchemaFactory.createForClass(Brand);

export enum AssetKind {
  Logo = "logo",
  /** A screen of the product (app, dashboard…). */
  Screenshot = "screenshot",
  Photo = "photo",
  Other = "other",
}

/** An image of the brand kit, with what it shows so the agent can explain it. */
@Schema({ timestamps: true })
export class BrandAsset {
  @Prop({ type: Types.ObjectId, ref: "Brand", required: true, index: true }) brandId: Types.ObjectId;
  @Prop({ required: true, enum: AssetKind, type: String }) kind: AssetKind;
  @Prop({ required: true }) name: string;
  /** How it works / what it does, written by the user. */
  @Prop({ default: "" }) description: string;
  /** File name in the media folder. */
  @Prop({ required: true }) file: string;
  @Prop({ required: true }) mime: string;
}

export type BrandAssetDocument = HydratedDocument<BrandAsset>;
export const BrandAssetSchema = SchemaFactory.createForClass(BrandAsset);
