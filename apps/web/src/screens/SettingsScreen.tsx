import { useState } from "react";
import { useSession } from "../session";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { AgentEffort, AgentModel, EFFORT_LABEL, loadPrefs, MODEL_LABEL, savePrefs, type AgentPrefs } from "../components/GeneratePanel";
import { ElevenLabsKeyForm, useElevenLabs } from "../voice/ElevenLabs";
import { AssetSourcesForm, LibraryGrid } from "../assets/AssetSources";
import { AgentCliForm } from "../components/AgentCliForm";

export function SettingsScreen() {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const [prefs, setPrefs] = useState<AgentPrefs>(loadPrefs);
  const elevenLabs = useElevenLabs();
  const update = (p: Partial<AgentPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    savePrefs(next);
  };

  return (
    <MotionilyLayout title="Settings" description="Your account and how the agent works by default.">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Account</h2>
        <p className="text-sm text-neutral-300">{user?.name}</p>
        <p className="text-sm text-neutral-400">{user?.email} · simulated Google sign-in</p>
        <button type="button" onClick={logout} className="self-start text-sm text-neutral-400 hover:text-white">
          Sign out
        </button>
      </section>
      <section className="flex max-w-xl flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Coding agent</h2>
          <p className="text-xs text-neutral-500">The agent that builds and edits your videos inside Motionily, running on your own account. Any other MCP client can also work on them from outside.</p>
        </div>
        <AgentCliForm />
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Agent level</h2>
          <p className="text-xs text-neutral-500">Default model level and effort when generating videos or editing prefabs.</p>
        </div>
        <div className="flex gap-2">
          <select value={prefs.model} onChange={(e) => update({ model: e.target.value as AgentModel })} className="rounded-lg bg-neutral-900 px-3 py-2 text-sm focus:outline-none" aria-label="Model">
            {Object.values(AgentModel).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABEL[m]}
              </option>
            ))}
          </select>
          <select value={prefs.effort} onChange={(e) => update({ effort: e.target.value as AgentEffort })} className="rounded-lg bg-neutral-900 px-3 py-2 text-sm focus:outline-none" aria-label="Effort">
            {Object.values(AgentEffort).map((x) => (
              <option key={x} value={x}>
                Effort: {EFFORT_LABEL[x]}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="flex max-w-xl flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">ElevenLabs</h2>
          <p className="text-xs text-neutral-500">Generate voice-overs inside Motionily with your own ElevenLabs account: pick a voice and the script is read with every word timed.</p>
        </div>
        <ElevenLabsKeyForm el={elevenLabs} />
      </section>
      <section className="flex max-w-xl flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Asset sources</h2>
          <p className="text-xs text-neutral-500">Where the agent looks for real photos, footage and logos beyond the free libraries.</p>
        </div>
        <AssetSourcesForm />
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Library</h2>
          <p className="text-xs text-neutral-500">Everything the agent found, cut out or generated for your videos, reused across them.</p>
        </div>
        <LibraryGrid />
      </section>
    </MotionilyLayout>
  );
}
