import { INestApplication, ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";

/** Scenes are big JSON (hundreds of layers with keyframes); Express' 100 KB default dropped autosaves. */
const BODY_LIMIT = "20mb";

/** Shared by main.ts and the e2e tests so both run the same pipeline. `webOrigin` may list several, comma-separated (the desktop app's webview). */
export function configureApp(app: INestApplication, webOrigin: string) {
  app.enableCors({ origin: webOrigin.split(",").map((o) => o.trim()) });
  const express = app as NestExpressApplication;
  express.useBodyParser("json", { limit: BODY_LIMIT });
  express.useBodyParser("urlencoded", { extended: true, limit: BODY_LIMIT });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
