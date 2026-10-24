/** MCP clients Motionily gives setup for. Any other client takes the generic JSON. */
export const McpClient = {
  ClaudeCode: "claude-code",
  Codex: "codex",
  Gemini: "gemini",
  OpenCode: "opencode",
  Cursor: "cursor",
  VsCode: "vscode",
  ClaudeDesktop: "claude-desktop",
  Other: "other",
} as const;
export type McpClient = (typeof McpClient)[keyof typeof McpClient];

/** How the setup is applied: a command for the terminal, or JSON to merge into a config file. */
export const SetupKind = { Command: "command", File: "file" } as const;
export type SetupKind = (typeof SetupKind)[keyof typeof SetupKind];

export type ClientSetup = {
  client: McpClient;
  label: string;
  kind: SetupKind;
  /** Config file to merge the JSON into (file setups). */
  file?: string;
  text: string;
  /** What to type next to start working. */
  next: string;
};

/** The Motionily MCP server as a stdio command with its environment. */
export type McpServer = { command: string; args: string[]; env: Record<string, string> };

const NAME = "motionily";
const quote = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Setup for every client, for the same server. `ask` is the first request to type in the agent. */
export function clientSetups(server: McpServer, ask: string): ClientSetup[] {
  const { command, args, env } = server;
  const run = [command, ...args].map(quote).join(" ");
  const envFlags = (flag: string) => Object.entries(env).map(([k, v]) => `${flag} ${k}=${quote(v)}`).join(" ");
  const stdio = { command, args, env };
  return [
    {
      client: McpClient.ClaudeCode,
      label: "Claude Code",
      kind: SetupKind.Command,
      text: `claude mcp remove ${NAME} -s user >/dev/null 2>&1; claude mcp add ${NAME} -s user ${envFlags("-e")} -- ${run}`,
      next: `claude "${ask}"`,
    },
    {
      client: McpClient.Codex,
      label: "Codex",
      kind: SetupKind.Command,
      text: `codex mcp remove ${NAME} >/dev/null 2>&1; codex mcp add ${NAME} ${envFlags("--env")} -- ${run}`,
      next: `codex "${ask}"`,
    },
    {
      client: McpClient.Gemini,
      label: "Gemini CLI",
      kind: SetupKind.Command,
      text: `gemini mcp remove -s user ${NAME} >/dev/null 2>&1; gemini mcp add -s user ${envFlags("-e")} ${NAME} ${run}`,
      next: `gemini -i "${ask}"`,
    },
    {
      client: McpClient.OpenCode,
      label: "OpenCode",
      kind: SetupKind.File,
      file: "~/.config/opencode/opencode.json",
      text: json({ $schema: "https://opencode.ai/config.json", mcp: { [NAME]: { type: "local", command: [command, ...args], environment: env, enabled: true } } }),
      next: `opencode run "${ask}"`,
    },
    {
      client: McpClient.Cursor,
      label: "Cursor",
      kind: SetupKind.File,
      file: "~/.cursor/mcp.json",
      text: json({ mcpServers: { [NAME]: stdio } }),
      next: `Ask Cursor's agent: "${ask}"`,
    },
    {
      client: McpClient.VsCode,
      label: "VS Code",
      kind: SetupKind.File,
      file: ".vscode/mcp.json (or the user mcp.json)",
      text: json({ servers: { [NAME]: { type: "stdio", ...stdio } } }),
      next: `Ask Copilot in agent mode: "${ask}"`,
    },
    {
      client: McpClient.ClaudeDesktop,
      label: "Claude Desktop",
      kind: SetupKind.File,
      file: "claude_desktop_config.json (Settings › Developer › Edit config)",
      text: json({ mcpServers: { [NAME]: stdio } }),
      next: `Restart Claude Desktop and ask: "${ask}"`,
    },
    {
      client: McpClient.Other,
      label: "Other",
      kind: SetupKind.File,
      file: "your client's MCP config (stdio server)",
      text: json({ mcpServers: { [NAME]: stdio } }),
      next: `Ask your agent: "${ask}"`,
    },
  ];
}
