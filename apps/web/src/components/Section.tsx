import type { ReactNode } from "react";

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
