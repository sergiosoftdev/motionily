import { useState } from "react";
import { useSession } from "../session";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { AgentEffort, AgentModel, EFFORT_LABEL, loadPrefs, MODEL_LABEL, savePrefs, type AgentPrefs } from "../components/GeneratePanel";

export function SettingsScreen() {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const [prefs, setPrefs] = useState<AgentPrefs>(loadPrefs);
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
        <p className="text-sm text-neutral-400">{user?.email} · acceso simulado de Google</p>
        <button type="button" onClick={logout} className="self-start text-sm text-neutral-400 hover:text-white">
          Sign out
        </button>
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Agent</h2>
          <p className="text-xs text-neutral-500">Default model and effort when generating videos or editing prefabs.</p>
        </div>
        <div className="flex gap-2">
          <select value={prefs.model} onChange={(e) => update({ model: e.target.value as AgentModel })} className="rounded-lg bg-neutral-900 px-3 py-2 text-sm focus:outline-none" aria-label="Modelo">
            {Object.values(AgentModel).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABEL[m]}
              </option>
            ))}
          </select>
          <select value={prefs.effort} onChange={(e) => update({ effort: e.target.value as AgentEffort })} className="rounded-lg bg-neutral-900 px-3 py-2 text-sm focus:outline-none" aria-label="Esfuerzo">
            {Object.values(AgentEffort).map((x) => (
              <option key={x} value={x}>
                Esfuerzo: {EFFORT_LABEL[x]}
              </option>
            ))}
          </select>
        </div>
      </section>
    </MotionilyLayout>
  );
}
