import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadGatewayException, BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsString, MaxLength, MinLength } from "class-validator";
import { diskStorage } from "multer";
import { Model } from "mongoose";
import { CurrentUser, type AuthUser } from "../auth/auth";
import { MEDIA_DIR, mediaName, removeMedia } from "../media";
import { Sound, SoundDocument } from "./sound.schema";

const MAX_SOUND_BYTES = 8 * 1024 * 1024;
const SOUND_NAME = /^[a-z0-9_]{2,40}$/;
const RECIPE_TIMEOUT_MS = 120_000;

class DescribeSoundDto {
  @IsString() @MinLength(3) @MaxLength(400) description: string;
}

/** Recipe format the model writes; mirrors apps/web/src/audio/synth.ts. */
const RECIPE_GUIDE = `You design sound effects for motion graphics as JSON synth recipes. Answer ONLY JSON:
{"name":"snake_case_name","category":"whoosh|pop|click|riser|impact|chime|glitch|ui|texture","description":"short English description","recipe":{
 "duration":0.4,"reverb":0..1(optional),"drive":0..1(optional),"volume":0..1(optional),
 "voices":[{"wave":"sine|square|sawtooth|triangle|noise","freq":440 or [start,end] (exp sweep, not for noise),
   "gain":0..1,"start":0,"length":secs,"attack":s,"decay":s,"sustain":0..1,"release":s,
   "filter":{"kind":"lowpass|highpass|bandpass","freq":hz or [start,end],"q":1},"pan":-1..1,"wobble":{"rate":hz,"depth":hz}}]}}
Techniques: whoosh = noise + bandpass sweep with slow attack; pop = sine pitch drop with 2 ms attack; impact = low sine drop
+ short noise; riser = saw/noise sweeping up with long attack; chime = sines with long decay + reverb; glitch = short
alternating square/noise bursts + drive. Max duration 8 s. Keep it musical and clean.`;

/** The user's sound effect library (reused in every video). */
@Controller()
export class SoundsController {
  constructor(@InjectModel(Sound.name) private readonly sounds: Model<SoundDocument>) {}

  @Get("sounds")
  list(@CurrentUser() user: AuthUser) {
    return this.view(user);
  }

  /** Same list for the agent (agent tokens only reach routes of their project). */
  @Get("projects/:id/sounds")
  listForProject(@CurrentUser() user: AuthUser) {
    return this.view(user);
  }

  /** Save a sound rendered in the browser: WAV file + its recipe and metadata. */
  @Post("sounds")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: MEDIA_DIR, filename: (_req, f, cb) => cb(null, mediaName(f.originalname || "sound.wav")) }),
      limits: { fileSize: MAX_SOUND_BYTES },
      fileFilter: (_req, f, cb) => cb(null, f.mimetype === "audio/wav" || f.mimetype === "audio/x-wav"),
    }),
  )
  async save(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { name?: string; category?: string; description?: string; recipe?: string; duration?: string },
  ) {
    if (!file) throw new BadRequestException("a WAV file is required");
    const name = body.name ?? "";
    if (!SOUND_NAME.test(name)) throw new BadRequestException("name must be snake_case (2-40 chars)");
    let recipe: Record<string, unknown>;
    try {
      recipe = JSON.parse(body.recipe ?? "") as Record<string, unknown>;
    } catch {
      throw new BadRequestException("recipe must be JSON");
    }
    const old = await this.sounds.findOne({ ownerId: user.id, name });
    await removeMedia(old?.file);
    await this.sounds.updateOne(
      { ownerId: user.id, name },
      { $set: { category: body.category ?? "ui", description: (body.description ?? "").slice(0, 300), recipe, file: file.filename, duration: Number(body.duration) || 0 } },
      { upsert: true },
    );
    return this.view(user);
  }

  @Delete("sounds/:name")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param("name") name: string) {
    const s = await this.sounds.findOneAndDelete({ ownerId: user.id, name });
    if (!s) throw new NotFoundException();
    await removeMedia(s.file);
  }

  /** "Describe a sound": Claude writes a recipe; the browser renders and saves it. */
  @Post("sounds/-/design")
  @HttpCode(200)
  async design(@Body() dto: DescribeSoundDto) {
    const out = await runClaude(`Design this sound effect: ${dto.description}`);
    try {
      return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as Record<string, unknown>;
    } catch {
      throw new BadGatewayException("the agent did not return a valid recipe; try again");
    }
  }

  private async view(user: AuthUser) {
    const rows = await this.sounds.find({ ownerId: user.id }).sort({ category: 1, name: 1 }).lean();
    return rows.map((s) => ({ name: s.name, category: s.category, description: s.description, duration: s.duration, url: `/media/${s.file}`, recipe: s.recipe }));
  }
}

function runClaude(prompt: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "motionily-sound-"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CLAUDE_BIN ?? "claude",
      ["-p", prompt, "--system-prompt", RECIPE_GUIDE, "--tools", "", "--strict-mcp-config", "--output-format", "json", "--model", "sonnet", "--effort", "low"],
      { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), RECIPE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new BadGatewayException(`claude failed: ${err.trim().slice(0, 200) || code}`));
      try {
        resolve((JSON.parse(out) as { result: string }).result);
      } catch {
        resolve(out);
      }
    });
  });
}

