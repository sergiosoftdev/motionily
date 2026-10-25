import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureApp } from "./setup";
import { JwtService } from "@nestjs/jwt";
import { BridgeHub } from "./bridge-hub";
import { ProjectsService } from "./projects/projects.service";
import { GenerateService } from "./projects/generate.service";

/** How often an API started by the desktop app checks that the app is still running. */
const PARENT_CHECK_MS = 2000;

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app, process.env.WEB_ORIGIN ?? "http://localhost:5173");
  // The desktop app passes its editor build: agents' headless editors open it here, on the API's
  // own origin, since there is no web server on the machine. Only existing files are served (folders
  // such as fonts/ fall through), so every API route still answers.
  if (process.env.MOTIONILY_WEB_DIR) app.useStaticAssets(process.env.MOTIONILY_WEB_DIR, { redirect: false });
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
  // The desktop app's API answers this machine only (its local account signs in without a password).
  const host = process.env.HOST ?? (process.env.MOTIONILY_DESKTOP === "1" ? "127.0.0.1" : undefined);
  const port = Number(process.env.PORT ?? 3100);
  await (host ? app.listen(port, host) : app.listen(port));
}
void bootstrap();
