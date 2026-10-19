import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./setup";
import { JwtService } from "@nestjs/jwt";
import { BridgeHub } from "./bridge-hub";
import { ProjectsService } from "./projects/projects.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app, process.env.WEB_ORIGIN ?? "http://localhost:5173");
  new BridgeHub(app.getHttpServer(), app.get(JwtService), app.get(ProjectsService));
  await app.listen(Number(process.env.PORT ?? 3100));
}
void bootstrap();
