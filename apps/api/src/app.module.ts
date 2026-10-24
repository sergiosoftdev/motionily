import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { MongooseModule } from "@nestjs/mongoose";
import { isSqliteUri, useSqliteDriver } from "./common/sqlite-driver";
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
import { ConceptsService } from "./brands/concepts";
import { Prefab, PrefabSchema } from "./prefabs/prefab.schema";
import { PrefabsService } from "./prefabs/prefabs.service";
import { PrefabsController } from "./prefabs/prefabs.controller";
import { FontsController } from "./fonts";
import { AssetsController } from "./assets/assets.controller";
import { AssetsService } from "./assets/assets.service";
import { LibraryAsset, LibraryAssetSchema, LibraryController, LibraryService } from "./assets/library";
import { ProviderKeysController, ProviderKeysService } from "./assets/provider-keys";
import { DirectionController, DirectionService } from "./direction/direction.controller";
import { VoiceController } from "./voice/voice.controller";
import { VoiceService } from "./voice/voice.service";
import { Post, PostSchema } from "./posts/post.schema";
import { PostsService } from "./posts/posts.service";
import { PostsController } from "./posts/posts.controller";
import { CopywriterService } from "./posts/copywriter";
import { SunoService } from "./music/suno";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      // MongoDB, or one SQLite file (`sqlite:/path/motionily.db`) for the desktop app and zero-setup installs.
      useFactory: (c: ConfigService) => {
        const uri = c.get<string>("DATABASE_URL") ?? c.get("MONGO_URI", "mongodb://127.0.0.1:27017/motionily");
        if (isSqliteUri(uri)) useSqliteDriver();
        return { uri };
      },
    }),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Brick.name, schema: BrickSchema },
      { name: Project.name, schema: ProjectSchema },
      { name: Feedback.name, schema: FeedbackSchema },
      { name: Prefab.name, schema: PrefabSchema },
      { name: Brand.name, schema: BrandSchema },
      { name: BrandAsset.name, schema: BrandAssetSchema },
      { name: Post.name, schema: PostSchema },
      { name: LibraryAsset.name, schema: LibraryAssetSchema },
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
  controllers: [AuthController, BricksController, ProjectsController, MediaController, ReferencesController, FontsController, BrandsController, PrefabsController, SoundsController, AssetsController, LibraryController, ProviderKeysController, DirectionController, VoiceController, PostsController],
  providers: [BricksService, ProjectsService, GenerateService, PrefabsService, BrandsService, ConceptsService, VoiceService, PostsService, CopywriterService, SunoService, AssetsService, LibraryService, ProviderKeysService, DirectionService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
