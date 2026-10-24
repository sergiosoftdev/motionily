import { useEffect, useState } from "react";
import { AgentCli, api, type AgentSettings } from "../api/client";
import { AgentModel, MODEL_LABEL } from "./GeneratePanel";

/** How each CLI names its models, as a placeholder for the tier fields. */
const MODEL_HINT: Record<AgentCli, string> = {
  [AgentCli.Claude]: "",
  [AgentCli.Codex]: "e.g. gpt-5.5",
  [AgentCli.Gemini]: "e.g. gemini-2.5-pro",
  [AgentCli.OpenCode]: "provider/model, e.g. openai/gpt-5.5",
};

/**
 * Which coding agent runs inside Motionily: Claude Code, Codex, Gemini CLI or OpenCode, with the user's own
 * account. Any other MCP client can still drive Motionily from outside (Connect your agent).
 */
export function AgentCliForm() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agentSettings().then(setSettings, (e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!settings) return <p className="text-xs text-neutral-500">Looking for agents on this machine…</p>;

  const save = (cli: AgentCli, models: Record<string, string>) => {
    setSettings({ ...settings, cli, models });
    api.saveAgentSettings(cli, models).then(setSettings, (e: Error) => setError(e.message));
  };
  const current = settings.clis.find((c) => c.cli === settings.cli);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        {settings.clis.map((c) => (
          <label key={c.cli} className="flex cursor-pointer items-center gap-3 py-1 text-sm">
            <input type="radio" name="agent-cli" checked={settings.cli === c.cli} onChange={() => save(c.cli, settings.models)} className="accent-white" />
            <span className={settings.cli === c.cli ? "text-white" : "text-neutral-300"}>{c.name}</span>
            <span className={`text-xs ${c.version ? "text-neutral-500" : "text-amber-400/80"}`}>{c.version ? `v${c.version}` : "not installed"}</span>
          </label>
        ))}
      </div>
      {current && !current.version && <p className="text-xs text-amber-400/80">{current.name} is not on this machine's PATH: install it and sign in, or pick another agent.</p>}
      {settings.cli !== AgentCli.Claude && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500">Model for each level Motionily asks for. Empty uses the agent's own default.</p>
          {Object.values(AgentModel).map((tier) => (
            <label key={tier} className="flex items-center gap-3 text-sm">
              <span className="w-16 text-neutral-400">{MODEL_LABEL[tier]}</span>
              <input
                defaultValue={settings.models[tier] ?? ""}
                placeholder={MODEL_HINT[settings.cli]}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (settings.models[tier] ?? "")) save(settings.cli, { ...settings.models, [tier]: v });
                }}
                className="flex-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm placeholder:text-neutral-600 focus:outline-none"
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
