import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The coding-agent CLIs Motionily can drive headless. Every one of them speaks MCP, so the same
 * Motionily server and prompts work with any; the user picks with MOTIONILY_AGENT (default claude).
 */
export enum AgentCli {
  Claude = "claude",
  Codex = "codex",
  Gemini = "gemini",
  OpenCode = "opencode",
}

/** The Motionily MCP server as a stdio command, plus the tools this role may call (undefined = all). */
export type AgentMcp = { name: string; command: string; args: string[]; env: Record<string, string>; tools?: readonly string[] };

export type AgentLaunch = {
  prompt: string;
  /** The role's system prompt; replaces the CLI's own coding prompt where the CLI allows it. */
  system: string;
  /** Empty working folder, private to this run: config files the CLI reads go here. */
  cwd: string;
  mcp?: AgentMcp;
  /** Read-only file access in cwd (reference images to look at), for runs without MCP. */
  readFiles?: boolean;
  /** Motionily's model tier (fable/opus/sonnet/haiku); mapped per CLI, see `modelFor`. */
  model?: string;
  effort?: string;
  /** Stream events while running (generation) or only the final answer (one-shot copy). */
  stream: boolean;
};

/** Token and cost totals of one run, normalized across CLIs. */
export type AgentUsage = {
  costUsd: number;
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export const AgentEventKind = { Tool: "tool", Text: "text", Error: "error" } as const;
export type AgentEventKind = (typeof AgentEventKind)[keyof typeof AgentEventKind];
export type AgentEvent = { kind: AgentEventKind; text: string };

/** Running state of one run's output: what each CLI reports piece by piece. */
export type AgentRead = { events: AgentEvent[]; text: string; usage: AgentUsage; done: boolean; failed: string | null };

type Driver = {
  /** Read at launch, so CLAUDE_BIN and friends can change at runtime (tests, settings). */
  bin(): string;
  args(l: AgentLaunch): string[];
  /** Writes the config files the CLI reads from its working folder; returns extra env. */
  prepare?(l: AgentLaunch): Record<string, string>;
  /** Folds one stdout line into the run's state. */
  read(line: string, r: AgentRead): void;
};

export function emptyUsage(): AgentUsage {
  return { costUsd: 0, turns: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function newRead(): AgentRead {
  return { events: [], text: "", usage: emptyUsage(), done: false, failed: null };
}

/** A user's agent: the CLI and, for CLIs other than Claude Code, their tier → model map. */
export type AgentChoice = { cli: AgentCli; models?: Record<string, string> };

/** Which CLI drives the agents: the user's choice, else MOTIONILY_AGENT, else Claude Code. */
export function agentCli(preferred?: AgentCli | null): AgentCli {
  const valid = (v: unknown): v is AgentCli => Object.values(AgentCli).includes(v as AgentCli);
  if (valid(preferred)) return preferred;
  const env = process.env.MOTIONILY_AGENT;
  return valid(env) ? env : AgentCli.Claude;
}

const VERSION_TIMEOUT_MS = 4000;
const DETECT_TTL_MS = 60_000;
let detected: { at: number; versions: Promise<Partial<Record<AgentCli, string>>> } | null = null;

/** The version of every agent CLI installed on this machine (missing ones are left out); cached a minute. */
export function detectClis(): Promise<Partial<Record<AgentCli, string>>> {
  if (detected && Date.now() - detected.at < DETECT_TTL_MS) return detected.versions;
  const one = (cli: AgentCli) =>
    new Promise<[AgentCli, string | null]>((resolve) => {
      const child = spawn(DRIVERS[cli].bin(), ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => child.kill(), VERSION_TIMEOUT_MS);
      child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", () => resolve([cli, null]));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve([cli, code === 0 ? (out.match(/\d+\.\d+[\w.-]*/)?.[0] ?? (out.trim() || "installed")) : null]);
      });
    });
  const versions = Promise.all(Object.values(AgentCli).map(one)).then((r) => Object.fromEntries(r.filter(([, v]) => v)) as Partial<Record<AgentCli, string>>);
  detected = { at: Date.now(), versions };
  return versions;
}

/**
 * The model each CLI gets for a Motionily tier. Claude Code takes the tier alias itself; other CLIs read
 * the user's map from Settings, then MOTIONILY_AGENT_MODELS, a JSON map such as {"opus":"gpt-5.5","sonnet":"gpt-5.5-mini","*":"gpt-5.5"}.
 * With no mapping the CLI's own default model runs.
 */
export function modelFor(cli: AgentCli, tier: string | undefined, userModels?: Record<string, string>): string | undefined {
  if (!tier) return undefined;
  if (cli === AgentCli.Claude) return tier;
  if (userModels && (userModels[tier] || userModels["*"])) return userModels[tier] ?? userModels["*"];
  try {
    const map = JSON.parse(process.env.MOTIONILY_AGENT_MODELS ?? "{}") as Record<string, string>;
    return map[tier] ?? map["*"];
  } catch {
    return undefined;
  }
}

function json(line: string): Record<string, any> | null {
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Tool names come back prefixed per CLI (mcp__motionily__x, motionily_x, mcp_motionily_x): keep the tool's own name. */
export function bareTool(name: string, server: string): string {
  for (const p of [`mcp__${server}__`, `mcp_${server}_`, `${server}__`, `${server}_`]) if (name.startsWith(p)) return name.slice(p.length);
  return name;
}

const claude: Driver = {
  bin: () => process.env.CLAUDE_BIN ?? "claude",
  args(l) {
    const tools = l.readFiles ? "Read" : "";
    return [
      "-p",
      l.prompt,
      // Our own lean system prompt and no built-in tools: ~5k tokens of base context instead of ~27k, on every turn.
      "--system-prompt",
      l.system,
      "--tools",
      tools,
      ...(l.mcp ? ["--mcp-config", claudeMcpConfig(l)] : []),
      "--strict-mcp-config",
      "--allowedTools",
      l.mcp ? `mcp__${l.mcp.name}` : tools,
      "--output-format",
      l.stream ? "stream-json" : "json",
      ...(l.stream ? ["--verbose"] : []),
      ...(l.model ? ["--model", l.model] : []),
      ...(l.effort ? ["--effort", l.effort] : []),
    ];
  },
  read(line, r) {
    const m = json(line);
    if (!m) return;
    if (m.type === "assistant") {
      for (const c of m.message?.content ?? []) {
        if (c.type === "tool_use" && c.name) r.events.push({ kind: AgentEventKind.Tool, text: c.name });
        if (c.type === "text" && c.text?.trim()) r.events.push({ kind: AgentEventKind.Text, text: c.text.trim() });
      }
    }
    if (m.type === "result") {
      r.done = true;
      r.text = typeof m.result === "string" ? m.result : "";
      if (m.subtype && m.subtype !== "success") r.failed = m.subtype;
      if (m.is_error && !r.failed) r.failed = r.text || "error";
      r.usage = {
        costUsd: m.total_cost_usd ?? 0,
        turns: m.num_turns ?? 0,
        durationMs: m.duration_ms ?? 0,
        inputTokens: m.usage?.input_tokens ?? 0,
        outputTokens: m.usage?.output_tokens ?? 0,
        cacheReadTokens: m.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: m.usage?.cache_creation_input_tokens ?? 0,
      };
    }
  },
};

function claudeMcpConfig(l: AgentLaunch) {
  const file = join(l.cwd, ".mcp-config.json");
  const { name, command, args, env, tools } = l.mcp!;
  writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { command, args, env: tools ? { ...env, MOTIONILY_TOOLS: tools.join(",") } : env } } }));
  return file;
}

/** A TOML value for codex's `-c key=value` overrides (JSON strings and arrays are valid TOML). */
const toml = (v: unknown): string =>
  typeof v === "object" && v && !Array.isArray(v)
    ? `{ ${Object.entries(v)
        .map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`)
        .join(", ")} }`
    : JSON.stringify(v);

const codex: Driver = {
  bin: () => process.env.CODEX_BIN ?? "codex",
  args(l) {
    const set = (k: string, v: unknown) => ["-c", `${k}=${toml(v)}`];
    const mcp = l.mcp
      ? [
          ...set(`mcp_servers.${l.mcp.name}.command`, l.mcp.command),
          ...set(`mcp_servers.${l.mcp.name}.args`, l.mcp.args),
          ...set(`mcp_servers.${l.mcp.name}.env`, l.mcp.env),
          ...(l.mcp.tools ? set(`mcp_servers.${l.mcp.name}.enabled_tools`, [...l.mcp.tools]) : []),
          // Generation runs long tools (review_video renders a contact sheet).
          ...set(`mcp_servers.${l.mcp.name}.tool_timeout_sec`, 600),
        ]
      : [];
    return [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      ...set("approval_policy", "never"),
      ...set("developer_instructions", l.system),
      ...set("project_root_markers", []),
      ...mcp,
      ...(l.model ? ["--model", l.model] : []),
      ...(l.effort ? set("model_reasoning_effort", codexEffort(l.effort)) : []),
      l.prompt,
    ];
  },
  read(line, r) {
    const m = json(line);
    if (!m) return;
    const item = m.item as Record<string, any> | undefined;
    if (m.type === "item.started" && item?.type === "mcp_tool_call") r.events.push({ kind: AgentEventKind.Tool, text: item.tool });
    if (m.type === "item.completed" && item?.type === "agent_message" && item.text?.trim()) {
      r.text = item.text.trim();
      r.events.push({ kind: AgentEventKind.Text, text: r.text });
    }
    if (m.type === "turn.completed") {
      r.done = true;
      r.usage.turns += 1;
      r.usage.inputTokens += m.usage?.input_tokens ?? 0;
      r.usage.outputTokens += (m.usage?.output_tokens ?? 0) + (m.usage?.reasoning_output_tokens ?? 0);
      r.usage.cacheReadTokens += m.usage?.cached_input_tokens ?? 0;
      r.usage.cacheWriteTokens += m.usage?.cache_write_input_tokens ?? 0;
    }
    if (m.type === "turn.failed" || m.type === "error") {
      r.failed = m.error?.message ?? m.message ?? "error";
      r.events.push({ kind: AgentEventKind.Error, text: r.failed! });
    }
  },
};

/** Codex has no "max" or "xhigh" in older releases; clamp to what every version accepts. */
function codexEffort(e: string) {
  return ({ low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" } as Record<string, string>)[e] ?? "medium";
}

const gemini: Driver = {
  bin: () => process.env.GEMINI_BIN ?? "gemini",
  prepare(l) {
    // Workspace settings: the Motionily server (trusted, so no confirmation prompts) and nothing else.
    const dir = join(l.cwd, ".gemini");
    const system = join(l.cwd, "system.md");
    writeFileSync(system, l.system);
    const settings = l.mcp
      ? { mcpServers: { [l.mcp.name]: { command: l.mcp.command, args: l.mcp.args, env: l.mcp.env, trust: true, timeout: 600_000, ...(l.mcp.tools ? { includeTools: [...l.mcp.tools] } : {}) } } }
      : {};
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
    // GEMINI_SYSTEM_MD swaps the CLI's own system prompt for the role's.
    return { GEMINI_SYSTEM_MD: system };
  },
  args(l) {
    return [
      "-p",
      l.prompt,
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
      ...(l.mcp ? ["--allowed-mcp-server-names", l.mcp.name] : []),
      ...(l.model ? ["--model", l.model] : []),
    ];
  },
  read(line, r) {
    const m = json(line);
    if (!m) return;
    if (m.type === "tool_use" && m.tool_name) r.events.push({ kind: AgentEventKind.Tool, text: m.tool_name });
    // Assistant text arrives in chunks (delta: true); the answer is all of them.
    if (m.type === "message" && m.role === "assistant" && typeof m.content === "string") {
      r.text += m.content;
      if (!m.delta && m.content.trim()) r.events.push({ kind: AgentEventKind.Text, text: m.content.trim() });
    }
    if (m.type === "error") r.events.push({ kind: AgentEventKind.Error, text: m.message ?? "error" });
    if (m.type === "result") {
      r.done = true;
      r.text = r.text.trim();
      if (m.text?.trim()) r.events.push({ kind: AgentEventKind.Text, text: r.text });
      if (m.status !== "success") r.failed = m.error?.message ?? "error";
      r.usage.durationMs = m.stats?.duration_ms ?? 0;
      r.usage.inputTokens = m.stats?.input_tokens ?? 0;
      r.usage.outputTokens = m.stats?.output_tokens ?? 0;
      r.usage.cacheReadTokens = m.stats?.cached ?? 0;
      r.usage.turns = m.stats?.tool_calls ?? 0;
    }
  },
};

/** OpenCode agent name used for every Motionily role (its prompt is the role's system prompt). */
const OPENCODE_AGENT = "motionily";

const opencode: Driver = {
  bin: () => process.env.OPENCODE_BIN ?? "opencode",
  prepare(l) {
    writeFileSync(join(l.cwd, "system.md"), l.system);
    // Only the role's Motionily tools. OpenCode's own tools stay registered (the Zen free tier refuses runs
    // without them): writing, shell and web are denied, and reads cannot leave the run's empty folder.
    const allowed: Record<string, boolean> = {};
    if (l.mcp?.tools) {
      allowed[`${l.mcp.name}_*`] = false;
      for (const t of l.mcp.tools) allowed[`${l.mcp.name}_${t}`] = true;
    }
    const config = {
      $schema: "https://opencode.ai/config.json",
      ...(l.mcp ? { mcp: { [l.mcp.name]: { type: "local", command: [l.mcp.command, ...l.mcp.args], environment: l.mcp.env, enabled: true, timeout: 600_000 } } } : {}),
      // The role prompt goes in as instructions on top of OpenCode's own prompt: some providers (OpenCode Zen's
      // free tier) refuse requests whose system prompt is not OpenCode's.
      instructions: [join(l.cwd, "system.md")],
      agent: { [OPENCODE_AGENT]: { mode: "primary", tools: allowed, permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" } } },
    };
    const file = join(l.cwd, "opencode.json");
    writeFileSync(file, JSON.stringify(config));
    return { OPENCODE_CONFIG: file };
  },
  args(l) {
    return ["run", "--format", "json", "--agent", OPENCODE_AGENT, "--dir", l.cwd, ...(l.model ? ["--model", l.model] : []), ...(l.effort ? ["--variant", l.effort] : []), l.prompt];
  },
  read(line, r) {
    const m = json(line);
    if (!m) return;
    const part = m.part as Record<string, any> | undefined;
    if (m.type === "tool_use" && part?.tool) r.events.push({ kind: AgentEventKind.Tool, text: part.tool });
    if (m.type === "text" && part?.text?.trim()) {
      r.text = part.text.trim();
      r.events.push({ kind: AgentEventKind.Text, text: r.text });
    }
    if (m.type === "error") {
      r.failed = m.error?.data?.message ?? m.error?.name ?? "error";
      r.events.push({ kind: AgentEventKind.Error, text: r.failed! });
    }
    if (m.type === "step_finish" && part) {
      r.usage.turns += 1;
      r.usage.costUsd += part.cost ?? 0;
      r.usage.inputTokens += part.tokens?.input ?? 0;
      r.usage.outputTokens += (part.tokens?.output ?? 0) + (part.tokens?.reasoning ?? 0);
      r.usage.cacheReadTokens += part.tokens?.cache?.read ?? 0;
      r.usage.cacheWriteTokens += part.tokens?.cache?.write ?? 0;
      // OpenCode streams no closing event: a step that stops (not to call a tool) ends the run.
      if (part.reason === "stop") r.done = true;
    }
  },
};

const DRIVERS: Record<AgentCli, Driver> = { [AgentCli.Claude]: claude, [AgentCli.Codex]: codex, [AgentCli.Gemini]: gemini, [AgentCli.OpenCode]: opencode };

/** Command, args and env to start one agent run with the chosen CLI. */
export function agentCommand(cli: AgentCli, l: AgentLaunch): { bin: string; args: string[]; env: NodeJS.ProcessEnv; read: Driver["read"] } {
  const d = DRIVERS[cli];
  const extra = d.prepare?.(l) ?? {};
  return { bin: d.bin(), args: d.args(l), env: { ...process.env, ...extra }, read: d.read };
}

/** Human name for errors and the UI. */
export const AGENT_NAME: Record<AgentCli, string> = {
  [AgentCli.Claude]: "Claude Code",
  [AgentCli.Codex]: "Codex CLI",
  [AgentCli.Gemini]: "Gemini CLI",
  [AgentCli.OpenCode]: "OpenCode",
};

/** Starts one agent run and resolves with its final state; `onEvent` sees tool calls and text as they stream. */
export function runAgent(
  cli: AgentCli,
  l: AgentLaunch,
  hooks: { onEvent?: (e: AgentEvent) => void; onSpawn?: (child: ChildProcess) => void; onExit?: (child: ChildProcess) => void; timeoutMs?: number } = {},
): Promise<AgentRead> {
  const { bin, args, env, read } = agentCommand(cli, l);
  const child = spawn(bin, args, { cwd: l.cwd, stdio: ["ignore", "pipe", "pipe"], env });
  hooks.onSpawn?.(child);
  const r = newRead();
  const t0 = Date.now();
  const timer = hooks.timeoutMs ? setTimeout(() => child.kill(), hooks.timeoutMs) : null;
  let buffered = "";
  let stderr = "";
  const fold = (line: string) => {
    const before = r.events.length;
    read(line, r);
    for (const e of r.events.slice(before)) hooks.onEvent?.(e);
  };
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) fold(line);
    });
    child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Could not start ${AGENT_NAME[cli]} (${bin}): ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (buffered.trim()) fold(buffered);
      // Not every CLI reports its wall time.
      if (!r.usage.durationMs) r.usage.durationMs = Date.now() - t0;
      hooks.onExit?.(child);
      if (code === 0 && r.done && !r.failed) return resolve(r);
      const why = r.failed ?? (stderr.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`);
      reject(new Error(`${AGENT_NAME[cli]} failed: ${why}`));
    });
  });
}
