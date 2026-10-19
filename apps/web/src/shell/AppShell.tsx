import type { ReactNode } from "react";
import { Logo } from "../components/Logo";
import { href, RouteName, type Route } from "../router";
import { useSession } from "../session";

const NAV: { route: Route; label: string; icon: string; match: RouteName[] }[] = [
  { route: { name: RouteName.Projects }, label: "Proyectos", icon: "M3 7h18M3 12h18M3 17h12", match: [RouteName.Projects, RouteName.Brand, RouteName.NewVideo] },
  { route: { name: RouteName.Prefabs }, label: "Prefabs", icon: "M12 3 3 8l9 5 9-5-9-5zM3 8v8l9 5 9-5V8", match: [RouteName.Prefabs] },
  { route: { name: RouteName.Settings }, label: "Configuración", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2", match: [RouteName.Settings] },
];

/** Everything outside the editor: sidebar navigation + page content. */
export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 flex h-dvh w-56 shrink-0 flex-col gap-6 border-r border-neutral-900 px-3 py-5">
        <a href={href({ name: RouteName.Projects })} className="px-3">
          <Logo />
        </a>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => {
            const active = n.match.includes(route.name);
            return (
              <a
                key={n.label}
                href={href(n.route)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${active ? "bg-neutral-900 text-white" : "text-neutral-400 hover:bg-neutral-900/60 hover:text-white"}`}
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={n.icon} />
                </svg>
                {n.label}
              </a>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-1 px-3 text-xs text-neutral-500">
          <span className="truncate">{user?.email}</span>
          <button type="button" onClick={logout} className="self-start hover:text-white">
            Salir
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

/** Page title row used by every shell page. */
export function PageHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
