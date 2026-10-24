# Using Motionily with your agent

Motionily is driven through MCP. Any client that speaks MCP over stdio can build and edit videos;
the editor shows every change live.

## From your own agent (any MCP client)

In the editor or the side navigation, press **Connect your agent** and pick your client. It shows the
exact command or JSON for this machine, with a token that can create and edit your videos (never
delete them) and expires in 90 days. The server it registers is:

```json
{
  "mcpServers": {
    "motionily": {
      "command": "<path to tsx or node>",
      "args": ["<path to packages/mcp-server/src/index.ts>"],
      "env": { "MOTIONILY_API": "http://127.0.0.1:47310", "MOTIONILY_TOKEN": "<token>", "MOTIONILY_PROJECT": "<optional video id>" }
    }
  }
}
```

| Client | How |
| --- | --- |
| Claude Code | `claude mcp add motionily -s user -e … -- <command> <args>` |
| Codex | `codex mcp add motionily --env … -- <command> <args>` |
| Gemini CLI | `gemini mcp add -s user -e … motionily <command> <args>` |
| OpenCode | `mcp.motionily` in `~/.config/opencode/opencode.json` (`type: "local"`) |
| Cursor | `mcpServers.motionily` in `~/.cursor/mcp.json` |
| VS Code (Copilot agent mode) | `servers.motionily` (`type: "stdio"`) in `.vscode/mcp.json` |
| Claude Desktop | `mcpServers.motionily` in `claude_desktop_config.json` |

Without `MOTIONILY_PROJECT` the agent starts on no video: it can list, create and open them
(`list_projects`, `create_project`, `open_project`). The first `get_project` call returns the manual.

The desktop app's API keeps port 47310 (or the last free one) so a registered agent keeps working
across launches.

## Inside Motionily (Generate, the agent bar, pitches, post copy)

When you ask from inside the app, Motionily starts the agent CLI itself, headless, with its own lean
system prompt and only the Motionily tools. Pick the CLI in **Settings › Coding agent**:

| CLI | Driver notes |
| --- | --- |
| Claude Code (`claude`) | Default. Motionily's levels (Fable/Opus/Sonnet/Haiku) are passed as `--model`. |
| Codex (`codex exec --json`) | MCP server and instructions passed as `-c` overrides; read-only sandbox. |
| Gemini CLI (`gemini -p --output-format stream-json`) | Workspace `.gemini/settings.json` with the server trusted; system prompt via `GEMINI_SYSTEM_MD`. |
| OpenCode (`opencode run --format json`) | Per-run `opencode.json` with a `motionily` agent; writes, shell and web denied, reads kept inside the run's empty folder. |

For CLIs other than Claude Code, Settings maps each Motionily level to a model id of that CLI
(`gpt-5.5`, `openai/gpt-5.5`, `gemini-2.5-pro`…). Empty uses the CLI's own default.

Server-wide defaults: `MOTIONILY_AGENT=claude|codex|gemini|opencode` and
`MOTIONILY_AGENT_MODELS='{"opus":"…","sonnet":"…","*":"…"}'`. Binaries can be overridden with
`CLAUDE_BIN`, `CODEX_BIN`, `GEMINI_BIN` and `OPENCODE_BIN`.

Tested end to end: Claude Code and OpenCode. Codex and Gemini CLI follow their documented headless
interfaces; reports welcome.
