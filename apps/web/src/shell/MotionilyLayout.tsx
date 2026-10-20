import type { ReactNode } from "react";
import { Logo } from "../components/Logo";
import { href, RouteName, useRoute, type Route } from "../router";
import { useSession } from "../session";

const NAV: { route: Route; label: string; icon: string; match: RouteName[] }[] = [
  { route: { name: RouteName.Projects }, label: "Projects", icon: "M3 7h18M3 12h18M3 17h12", match: [RouteName.Projects, RouteName.Brand, RouteName.NewVideo] },
  { route: { name: RouteName.Prefabs }, label: "Prefabs", icon: "M12 3 3 8l9 5 9-5-9-5zM3 8v8l9 5 9-5V8", match: [RouteName.Prefabs] },
  { route: { name: RouteName.Sounds }, label: "Sounds", icon: "M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2", match: [RouteName.Sounds] },
  { route: { name: RouteName.Settings }, label: "Settings", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2", match: [RouteName.Settings] },
];

export type LayoutTab = { label: string; href: string; active: boolean };

/**
 * Frame of every page outside the editor, so they all look the same: app navigation on the left,
 * then the page — title, description and actions on top, optional tabs, the body (with an
 * optional side column, e.g. a list next to its detail) and an optional footer at the bottom.
 */
export function MotionilyLayout({
  title,
  description,
  actions,
  tabs,
  sidebar,
  footer,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the right of the title. */
  actions?: ReactNode;
  tabs?: LayoutTab[];
  /** Side column left of the body (not the app navigation, which is always there). */
  sidebar?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      <AppNav />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-8 py-10">
          <header className="flex flex-col gap-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-2xl font-bold">{title}</h1>
                {description && <p className="mt-1 text-sm text-neutral-400">{description}</p>}
              </div>
              {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
            </div>
            {tabs && (
              <nav className="flex gap-1">
                {tabs.map((t) => (
                  <a
                    key={t.href}
                    href={t.href}
                    className={`rounded-md px-3 py-1.5 text-sm ${t.active ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"}`}
                  >
                    {t.label}
                  </a>
                ))}
              </nav>
            )}
          </header>
          <div className="flex flex-1 gap-6">
            {sidebar && <aside className="flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto">{sidebar}</aside>}
            <div className="flex min-w-0 flex-1 flex-col gap-8">{children}</div>
          </div>
          {footer && <footer className="flex items-center justify-end gap-3">{footer}</footer>}
        </div>
      </main>
    </div>
  );
}

function AppNav() {
  const route = useRoute();
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  return (
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
          Sign out
        </button>
      </div>
    </aside>
  );
}
