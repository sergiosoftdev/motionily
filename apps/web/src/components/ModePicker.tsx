import { AgentEffort, AgentModel, EFFORT_LABEL, MODEL_LABEL, type AgentPrefs } from "./GeneratePanel";

/** Mirrors GenerateMode in the API: who builds the video and how hard they think. */
export const GenerationMode = { Premium: "premium", Balanced: "balanced", Economy: "economy", Custom: "custom" } as const;
export type GenerationMode = (typeof GenerationMode)[keyof typeof GenerationMode];

/** Costs: economy measured (~0,8 $ / 2,5 min for 12 s); the others are estimates until measured. */
const MODES: { id: GenerationMode; label: string; team: string; estimate: string }[] = [
  { id: GenerationMode.Premium, label: "Máxima calidad", team: "Todo Opus: directora pensando a fondo y montadores Opus. Los mejores efectos.", estimate: "≈ 4–8 $ · 5–10 min" },
  { id: GenerationMode.Balanced, label: "Equilibrado", team: "Directora Opus, montadores Sonnet. Buen diseño a buen precio.", estimate: "≈ 1,5–3 $ · 3–5 min" },
  { id: GenerationMode.Economy, label: "Económico", team: "Todo Sonnet con esfuerzo bajo. Rápido y barato para probar ideas.", estimate: "≈ 0,8 $ · 2–3 min" },
  { id: GenerationMode.Custom, label: "Personalizado", team: "Eliges modelo y esfuerzo para todo el equipo.", estimate: "" },
];

export function ModePicker({ prefs, onChange }: { prefs: AgentPrefs; onChange: (p: Partial<AgentPrefs>) => void }) {
  const mode = prefs.mode ?? GenerationMode.Balanced;
  const select = "flex-1 rounded-lg bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300 focus:outline-none";
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            title={m.team}
            onClick={() => onChange({ mode: m.id })}
            className={`flex flex-col gap-0.5 rounded-lg px-3 py-2 text-left ring-1 transition ${
              mode === m.id ? "bg-white/[0.08] ring-white/40" : "bg-neutral-900 ring-white/5 hover:ring-white/20"
            }`}
          >
            <span className="text-xs font-semibold">{m.label}</span>
            {m.estimate && <span className="font-mono text-[10px] text-neutral-500">{m.estimate}</span>}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-neutral-500">{MODES.find((m) => m.id === mode)!.team}</p>
      {mode === GenerationMode.Custom && (
        <div className="flex gap-2">
          <select value={prefs.model} onChange={(e) => onChange({ model: e.target.value as AgentModel })} aria-label="Modelo" className={select}>
            {Object.values(AgentModel).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABEL[m]}
              </option>
            ))}
          </select>
          <select value={prefs.effort} onChange={(e) => onChange({ effort: e.target.value as AgentEffort })} aria-label="Esfuerzo" className={select}>
            {Object.values(AgentEffort).map((x) => (
              <option key={x} value={x}>
                Esfuerzo: {EFFORT_LABEL[x]}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
