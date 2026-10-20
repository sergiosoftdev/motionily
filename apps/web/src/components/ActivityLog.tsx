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
    <Section title="Activity">
      {activity.length === 0 ? (
        <p className="text-xs text-neutral-500">
          Nothing yet. Edits by you and the agent show up here.
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
