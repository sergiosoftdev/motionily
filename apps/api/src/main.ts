import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./setup";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app, process.env.WEB_ORIGIN ?? "http://localhost:5173");
  await app.listen(Number(process.env.PORT ?? 3100));
}
void bootstrap();
