import { BadGatewayException, BadRequestException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "../users/user.schema";
import { ElevenLabsError, listVoices, MODEL_CHAR_LIMIT, speak, type VoiceModel } from "./elevenlabs";
import { seal, unseal, type Sealed } from "./secrets";

/** Characters of the key shown back to the user so they know which one is connected. */
const HINT_CHARS = 4;

/**
 * Each user's ElevenLabs connection: their key stays encrypted on the server and is only ever
 * sent to ElevenLabs. Motionily pays nothing; the user's account is charged.
 */
@Injectable()
export class VoiceService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  async status(userId: Types.ObjectId) {
    const u = await this.users.findById(userId, { elevenLabsHint: 1 }).lean();
    return { connected: !!u?.elevenLabsHint, hint: u?.elevenLabsHint ?? null };
  }

  /** Checks the key against ElevenLabs before keeping it. */
  async connect(userId: Types.ObjectId, apiKey: string) {
    const key = apiKey.trim();
    await this.guard(() => listVoices(key));
    const hint = key.slice(-HINT_CHARS);
    await this.users.updateOne({ _id: userId }, { $set: { elevenLabsKey: seal(key), elevenLabsHint: hint } });
    return { connected: true, hint };
  }

  async disconnect(userId: Types.ObjectId) {
    await this.users.updateOne({ _id: userId }, { $unset: { elevenLabsKey: 1, elevenLabsHint: 1 } });
    return { connected: false, hint: null };
  }

  async voices(userId: Types.ObjectId) {
    const key = await this.keyOf(userId);
    return this.guard(() => listVoices(key));
  }

  async speak(userId: Types.ObjectId, voiceId: string, text: string, model: VoiceModel) {
    const limit = MODEL_CHAR_LIMIT[model];
    if (text.length > limit) throw new BadRequestException(`the script is ${text.length} characters and ${model} reads up to ${limit} at once: shorten it or pick another model`);
    const key = await this.keyOf(userId);
    return this.guard(() => speak(key, voiceId, text, model));
  }

  private async keyOf(userId: Types.ObjectId) {
    const u = await this.users.findById(userId).select("+elevenLabsKey").lean();
    const sealed = u?.elevenLabsKey as Sealed | null | undefined;
    if (!sealed) throw new BadRequestException("connect ElevenLabs first: paste your API key in Settings");
    try {
      return unseal(sealed);
    } catch {
      throw new BadRequestException("your ElevenLabs key could not be read: paste it again in Settings");
    }
  }

  /**
   * ElevenLabs errors as the user's to fix (400, never 401: that would sign them out of
   * Motionily), rate limits as such, and outages as a bad gateway.
   */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ElevenLabsError)) throw e;
      if (e.status === HttpStatus.TOO_MANY_REQUESTS) throw new HttpException(e.message, HttpStatus.TOO_MANY_REQUESTS);
      if (e.status >= 500) throw new BadGatewayException(e.message);
      throw new BadRequestException(e.message);
    }
  }
}
