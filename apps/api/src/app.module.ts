import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { MongooseModule } from "@nestjs/mongoose";
import { AuthController } from "./auth/auth.controller";
import { JwtAuthGuard } from "./auth/auth";
import { User, UserSchema } from "./users/user.schema";
import { Brick, BrickSchema } from "./bricks/brick.schema";
import { BricksService } from "./bricks/bricks.service";
import { BricksController } from "./bricks/bricks.controller";
import { Feedback, FeedbackSchema, Project, ProjectSchema } from "./projects/project.schema";
import { ProjectsService } from "./projects/projects.service";
import { GenerateService } from "./projects/generate.service";
import { ProjectsController } from "./projects/projects.controller";
import { MediaController, ReferencesController } from "./media";
import { Brand, BrandAsset, BrandAssetSchema, BrandSchema } from "./brands/brand.schema";
import { BrandsService } from "./brands/brands.service";
import { BrandsController } from "./brands/brands.controller";
import { SoundsController } from "./sounds/sounds.controller";
import { Sound, SoundSchema } from "./sounds/sound.schema";
import { ConceptsService } from "./brands/concepts";
import { Prefab, PrefabSchema } from "./prefabs/prefab.schema";
import { PrefabsService } from "./prefabs/prefabs.service";
import { PrefabsController } from "./prefabs/prefabs.controller";
import { FontsController } from "./fonts";
import { ImagesController } from "./images/images.controller";
import { VoiceController } from "./voice/voice.controller";
import { VoiceService } from "./voice/voice.service";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({ uri: c.get("MONGO_URI", "mongodb://127.0.0.1:27017/motionily") }),
    }),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Brick.name, schema: BrickSchema },
      { name: Project.name, schema: ProjectSchema },
      { name: Feedback.name, schema: FeedbackSchema },
      { name: Prefab.name, schema: PrefabSchema },
      { name: Sound.name, schema: SoundSchema },
      { name: Brand.name, schema: BrandSchema },
      { name: BrandAsset.name, schema: BrandAssetSchema },
    ]),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        secret: c.get("JWT_SECRET", "dev-only-secret"),
        signOptions: { expiresIn: "30d" },
      }),
    }),
  ],
  controllers: [AuthController, BricksController, ProjectsController, MediaController, ReferencesController, FontsController, BrandsController, PrefabsController, SoundsController, ImagesController, VoiceController],
  providers: [BricksService, ProjectsService, GenerateService, PrefabsService, BrandsService, ConceptsService, VoiceService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
