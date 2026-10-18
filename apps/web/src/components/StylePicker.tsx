import { FeedbackKind, OpName, StylePreset } from "@motionily/protocol";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, EngineStatus, logActivity, useEditor } from "../store";
import { Section } from "./Section";

const LABELS: Record<StylePreset, string> = {
  [StylePreset.Clean]: "Limpio",
  [StylePreset.Neon]: "Neón",
  [StylePreset.Bold]: "Bold",
  [StylePreset.Pastel]: "Pastel",
};

export function StylePicker() {
  const current = useEditor((s) => s.style);
  const ready = useEditor((s) => s.engineStatus) === EngineStatus.Ready;

  const choose = (style: StylePreset) => {
    engineHost.applyOps([{ op: OpName.SetStyle, style }]);
    agentBridge.sceneChanged();
    agentBridge.feedback({ kind: FeedbackKind.StyleChosen, style, createdAt: new Date().toISOString() });
    logActivity(ActivitySource.User, `Estilo: ${LABELS[style]}`);
  };

  return (
    <Section title="Estilo visual" hint="Se aplica a todo el vídeo. El agente lo respeta.">
      <div className="grid grid-cols-2 gap-2">
        {ready &&
          engineHost.styles.map((style) => {
            const [bg, , primary, accent, text] = engineHost.palettes[style] ?? [];
            const active = style === current;
            return (
              <button
                key={style}
                type="button"
                onClick={() => choose(style)}
                className={`flex flex-col gap-2 rounded-lg p-2 text-left text-xs transition ${
                  active ? "bg-neutral-800 ring-1 ring-white/70" : "hover:bg-neutral-900"
                }`}
              >
                <span className="flex h-10 items-end gap-1 rounded-md p-1.5" style={{ background: bg }}>
                  <span className="h-full w-3 rounded-sm" style={{ background: primary }} />
                  <span className="h-2/3 w-3 rounded-sm" style={{ background: accent }} />
                  <span className="h-1/3 w-3 rounded-sm" style={{ background: text }} />
                </span>
                {LABELS[style]}
              </button>
            );
          })}
      </div>
    </Section>
  );
}
