import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadGatewayException } from "@nestjs/common";
import type { AgentEffort, AgentModel } from "../projects/projects.dto";
import type { usageFrom } from "../projects/generate.service";

/** What `claude -p --output-format json` reports about a run (cost, tokens, turns). */
export type ClaudeUsage = Parameters<typeof usageFrom>[0];

/**
 * One Claude answer with no tools (pitches, captions): its own lean system prompt and an empty
 * working folder, so no repo CLAUDE.md or tools leak in. `files` are copied next to it and become
 * readable (e.g. reference images Claude should look at).
 */
export function askClaude(o: {
  prompt: string;
  system: string;
  model: AgentModel;
  effort: AgentEffort;
  timeoutMs: number;
  files?: { from: string; as: string }[];
}): Promise<{ text: string; usage: ClaudeUsage | null }> {
  const cwd = mkdtempSync(join(tmpdir(), "motionily-once-"));
  for (const f of o.files ?? []) copyFileSync(f.from, join(cwd, f.as));
  const tools = o.files?.length ? "Read" : "";
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CLAUDE_BIN ?? "claude",
      // Own lean system prompt: Claude Code's default one is ~20k tokens of coding instructions.
      ["-p", o.prompt, "--system-prompt", o.system, "--tools", tools, "--strict-mcp-config", "--allowedTools", tools, "--output-format", "json", "--model", o.model, "--effort", o.effort],
      { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), o.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new BadGatewayException(`claude failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new BadGatewayException(`claude failed: ${err.trim().slice(0, 300) || `exit ${code}`}`));
      try {
        const r = JSON.parse(out) as ClaudeUsage & { result: string };
        resolve({ text: r.result, usage: r });
      } catch {
        resolve({ text: out, usage: null });
      }
    });
  });
}

/** The first JSON object in a model's answer (it may wrap it in prose or a code fence). */
export function jsonIn<T>(text: string): T | null {
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T;
  } catch {
    return null;
  }
}
