import { AgentEffort, AgentModel, EFFORT_LABEL, MODEL_LABEL, type AgentPrefs } from "./GeneratePanel";

/** Mirrors GenerateMode in the API: who builds the video and how hard they think. */
export const GenerationMode = { Premium: "premium", Balanced: "balanced", Economy: "economy", Custom: "custom" } as const;
export type GenerationMode = (typeof GenerationMode)[keyof typeof GenerationMode];

/** Costs: economy measured (~0,8 $ / 2,5 min for 12 s); the others are estimates until measured. */
const MODES: { id: GenerationMode; label: string; team: string; estimate: string }[] = [
  { id: GenerationMode.Economy, label: "Económico", team: "Todo Sonnet con esfuerzo bajo. Rápido y barato para probar ideas.", estimate: "Todo Sonnet · ≈ 0,8 $ · 2–3 min" },
  { id: GenerationMode.Balanced, label: "Equilibrado", team: "Directora Opus, montadores Sonnet. Buen diseño a buen precio.", estimate: "Directora Opus + equipo Sonnet · ≈ 1,5 $ · 4 min" },
  { id: GenerationMode.Premium, label: "Máxima calidad", team: "Un solo diseñador Opus hace todo el vídeo como un mundo continuo y un revisor Opus lo compara con tus referencias.", estimate: "Un diseñador Opus · ≈ 4–8 $ · 8–15 min" },
  { id: GenerationMode.Custom, label: "Personalizado", team: "Eliges modelo y esfuerzo para todo el equipo.", estimate: "" },
];

/** The three everyday modes side by side; "Personalizado" opens model + effort. */
export function ModePicker({ prefs, onChange }: { prefs: AgentPrefs; onChange: (p: Partial<AgentPrefs>) => void }) {
  const mode = prefs.mode ?? GenerationMode.Balanced;
  const current = MODES.find((m) => m.id === mode)!;
  const select = "flex-1 rounded-md bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300 focus:outline-none";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex rounded-lg bg-neutral-900 p-0.5">
        {MODES.filter((m) => m.id !== GenerationMode.Custom).map((m) => (
          <button
            key={m.id}
            type="button"
            title={m.team}
            onClick={() => onChange({ mode: m.id })}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs transition ${mode === m.id ? "bg-white/10 font-medium text-white" : "text-neutral-400 hover:text-white"}`}
          >
            {SHORT[m.id]}
          </button>
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-neutral-500">
        <span>{current.estimate || current.team}</span>
        <button
          type="button"
          onClick={() => onChange({ mode: mode === GenerationMode.Custom ? GenerationMode.Balanced : GenerationMode.Custom })}
          className={mode === GenerationMode.Custom ? "text-white" : "hover:text-neutral-300"}
        >
          Personalizado
        </button>
      </div>
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

/** Labels short enough for one segmented row. */
const SHORT: Record<GenerationMode, string> = {
  [GenerationMode.Economy]: "Económico",
  [GenerationMode.Balanced]: "Equilibrado",
  [GenerationMode.Premium]: "Máxima",
  [GenerationMode.Custom]: "Personalizado",
};
