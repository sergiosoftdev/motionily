import { CaptionStyle, FeedbackKind, OpName } from "@motionily/protocol";
import { engineHost } from "../engine/host";
import { agentBridge } from "../bridge";
import { ActivitySource, EngineStatus, logActivity, useEditor } from "../store";
import { Section } from "./Section";

const LABELS: Record<CaptionStyle, { name: string; sample: string }> = {
  [CaptionStyle.Minimal]: { name: "Minimal", sample: "texto limpio abajo" },
  [CaptionStyle.Karaoke]: { name: "Karaoke", sample: "se ilumina al hablar" },
  [CaptionStyle.PopWord]: { name: "Pop", sample: "palabra a palabra" },
  [CaptionStyle.Highlight]: { name: "Highlight", sample: "resalta las clave" },
};

export function CaptionPicker() {
  const current = useEditor((s) => s.captionStyle);
  const ready = useEditor((s) => s.engineStatus) === EngineStatus.Ready;

  const choose = (captionStyle: CaptionStyle) => {
    engineHost.applyOps([{ op: OpName.SetCaptionStyle, caption_style: captionStyle }]);
    agentBridge.sceneChanged();
    agentBridge.feedback({ kind: FeedbackKind.CaptionStyleChosen, captionStyle, createdAt: new Date().toISOString() });
    logActivity(ActivitySource.User, `Subtítulos: ${LABELS[captionStyle].name}`);
  };

  return (
    <Section title="Subtítulos" hint="El render de subtítulos llega en el próximo hito.">
      <div className="flex flex-col gap-1">
        {ready &&
          engineHost.captionStyles.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => choose(c)}
              className={`flex items-baseline justify-between rounded-lg px-3 py-2 text-left text-xs transition ${
                c === current ? "bg-neutral-800 ring-1 ring-white/70" : "hover:bg-neutral-900"
              }`}
            >
              <span className="font-medium">{LABELS[c].name}</span>
              <span className="text-neutral-500">{LABELS[c].sample}</span>
            </button>
          ))}
      </div>
    </Section>
  );
}
