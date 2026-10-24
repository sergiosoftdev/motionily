import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Imported before the app: the desktop API's environment, read when its modules load (MEDIA_DIR). */
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "motionily-media-"));
process.env.MOTIONILY_DESKTOP = "1";
