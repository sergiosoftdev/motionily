import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadGatewayException } from "@nestjs/common";
import type { AgentEffort, AgentModel } from "../projects/projects.dto";
import { agentCli, modelFor, runAgent, type AgentUsage } from "./agent-cli";

/**
 * One agent answer with no tools (pitches, captions), from whichever CLI the user runs: its own lean
 * system prompt and an empty working folder, so no repo instructions or tools leak in. `files` are copied
 * next to it and become readable (e.g. reference images the agent should look at).
 */
export async function askAgent(o: {
  prompt: string;
  system: string;
  model: AgentModel;
  effort: AgentEffort;
  timeoutMs: number;
  files?: { from: string; as: string }[];
}): Promise<{ text: string; usage: AgentUsage | null }> {
  const cwd = mkdtempSync(join(tmpdir(), "motionily-once-"));
  for (const f of o.files ?? []) copyFileSync(f.from, join(cwd, f.as));
  const cli = agentCli();
  try {
    const r = await runAgent(
      cli,
      { prompt: o.prompt, system: o.system, cwd, readFiles: !!o.files?.length, model: modelFor(cli, o.model), effort: o.effort, stream: false },
      { timeoutMs: o.timeoutMs },
    );
    return { text: r.text, usage: r.usage };
  } catch (e) {
    throw new BadGatewayException((e as Error).message.slice(0, 300));
  }
}

/** The first JSON object in a model's answer (it may wrap it in prose or a code fence). */
export function jsonIn<T>(text: string): T | null {
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T;
  } catch {
    return null;
  }
}
