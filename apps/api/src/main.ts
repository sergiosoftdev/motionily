import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./setup";
import { JwtService } from "@nestjs/jwt";
import { BridgeHub } from "./bridge-hub";
import { ProjectsService } from "./projects/projects.service";
import { GenerateService } from "./projects/generate.service";

/** How often an API started by the desktop app checks that the app is still running. */
const PARENT_CHECK_MS = 2000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app, process.env.WEB_ORIGIN ?? "http://localhost:5173");
  // Hot reload / shutdown: stop the agents, then exit right away. (Nest's shutdown hooks would wait
  // forever for the editors' websockets to close and freeze the watcher's restart.)
  const generator = app.get(GenerateService);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void generator.onApplicationShutdown().finally(() => process.exit(0)));
  }
  // Started by the desktop app: stop with it, even when it was killed and could not stop us.
  const parent = Number(process.env.MOTIONILY_PARENT_PID);
  if (parent) {
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        void generator.onApplicationShutdown().finally(() => process.exit(0));
      }
    }, PARENT_CHECK_MS).unref();
  }
  new BridgeHub(app.getHttpServer(), app.get(JwtService), app.get(ProjectsService));
  await app.listen(Number(process.env.PORT ?? 3100));
}
void bootstrap();
