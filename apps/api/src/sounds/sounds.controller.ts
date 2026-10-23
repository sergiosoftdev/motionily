import { Controller, Get, NotFoundException, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/auth";
import { soundLibrary, type LibrarySound } from "./library";

/** URL of a library sound's audio (what a cue's `src` holds). */
const audioUrl = (name: string) => `/sounds/${name}/audio`;

const view = (rows: LibrarySound[]) =>
  rows.map(({ name, category, description, duration, peak, shape, hits, every }) => ({ name, category, description, duration, peak, shape, hits, every, url: audioUrl(name) }));

/** Motionily's sound effect library, the same for every account (see library.ts). */
@Controller()
export class SoundsController {
  @Get("sounds")
  async list() {
    return view(await soundLibrary.list());
  }

  /** Same list for the agent (agent tokens only reach routes of their project). */
  @Get("projects/:id/sounds")
  async listForProject() {
    return view(await soundLibrary.list());
  }

  /** The audio itself, without auth headers (<audio src>, Web Audio fetches). */
  @Public()
  @Get("sounds/:name/audio")
  async audio(@Param("name") name: string, @Res() res: Response) {
    const file = await soundLibrary.fileOf(name);
    if (!file) throw new NotFoundException();
    // The library lives under ~/.motionily: allow that dot folder (the path was resolved inside SOUNDS_DIR).
    res.sendFile(file, { maxAge: "1h", dotfiles: "allow" }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
}
