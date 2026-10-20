import { ActivitySource, useEditor } from "../store";
import { Section } from "./Section";

const WHO: Record<ActivitySource, string> = {
  [ActivitySource.Agent]: "Agent",
  [ActivitySource.User]: "You",
  [ActivitySource.System]: "·",
};

export function ActivityLog() {
  const activity = useEditor((s) => s.activity);

  return (
    <Section title="Actividad">
      {activity.length === 0 ? (
        <p className="text-xs text-neutral-500">
          Conecta Claude con <code className="text-neutral-300">pnpm mcp</code> y pídele un vídeo.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-xs">
          {activity.map((a) => (
            <li key={a.id} className="flex gap-2">
              <span className={a.source === ActivitySource.Agent ? "text-emerald-400" : "text-neutral-500"}>
                {WHO[a.source]}
              </span>
              <span className="text-neutral-300">{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
