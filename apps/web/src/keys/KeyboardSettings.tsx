import { useEffect, useState, useSyncExternalStore } from "react";
import { COMMANDS, comboFromEvent, commandLabel, conflicts, keymap, KeyPreset, KeyScope, PRESETS, SCOPE_LABEL } from "./keymap";
import { Dropdown } from "../components/Dropdown";

/** Settings › Keyboard: a preset like the editor you come from, and any command re-assigned by pressing its new key. */
export function KeyboardSettings() {
  // Re-render on every change of the keymap.
  const version = useSyncExternalStore(keymap.subscribe, () => `${keymap.preset}:${JSON.stringify(COMMANDS.map((c) => commandLabel(c.id)))}`);
  const [recording, setRecording] = useState<string | null>(null);
  const [scope, setScope] = useState<KeyScope>(KeyScope.Transport);
  const clash = conflicts();
  void version;

  // The next key press becomes the command's key (Esc cancels, Backspace alone clears it).
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return setRecording(null);
      if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        keymap.setCustom(recording, []);
        return setRecording(null);
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      keymap.setCustom(recording, [combo]);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const sections = [...new Set(COMMANDS.filter((c) => c.scope === scope).map((c) => c.section))];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Dropdown
          className="w-56"
          label="Keyboard preset"
          value={keymap.preset}
          onChange={(p) => keymap.setPreset(p)}
          options={(Object.entries(PRESETS) as [KeyPreset, (typeof PRESETS)[KeyPreset]][]).map(([id, p]) => ({ value: id, label: p.label }))}
        />
        <div className="flex rounded-lg bg-neutral-900 p-0.5">
          {Object.values(KeyScope).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded-md px-2.5 py-1.5 text-xs ${scope === s ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-neutral-500">Choosing a preset resets your own changes. Click a key to change it: press the new one (Esc cancels, Backspace leaves it unassigned).</p>
      <div className="flex flex-col gap-4">
        {sections.map((section) => (
          <div key={section}>
            <p className="pb-1 text-[11px] text-neutral-500">{section}</p>
            {COMMANDS.filter((c) => c.scope === scope && c.section === section).map((c) => {
              const with_ = clash.get(c.id);
              return (
                <div key={c.id} className="flex items-center gap-3 border-b border-white/5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 text-neutral-300">
                    {c.help}
                    {with_ && <span className="ml-2 text-xs text-amber-300">same key as “{with_.map((id) => COMMANDS.find((x) => x.id === id)?.help).join("”, “")}”</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRecording(recording === c.id ? null : c.id)}
                    aria-label={`Change the key of ${c.help}`}
                    className={`min-w-28 rounded-md px-2 py-1 text-right font-mono text-xs ${recording === c.id ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/50" : "bg-neutral-900 text-white hover:bg-neutral-800"}`}
                  >
                    {recording === c.id ? "Press a key…" : commandLabel(c.id)}
                  </button>
                  <button
                    type="button"
                    onClick={() => keymap.setCustom(c.id, null)}
                    disabled={!keymap.isCustom(c.id)}
                    className="w-10 text-xs text-neutral-500 hover:text-white disabled:invisible"
                  >
                    Reset
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
