import type { ReactNode } from "react";
import { useSession } from "../session";
import { Logo } from "../components/Logo";
import { href, RouteName } from "../router";

export function TopBar({ children }: { children?: ReactNode }) {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  return (
    <header className="flex items-center gap-4 px-5 py-3">
      <a href={href({ name: RouteName.Projects })}>
        <Logo />
      </a>
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      {user && (
        <div className="flex items-center gap-3 text-xs text-neutral-400">
          <span className="hidden sm:inline">{user.email}</span>
          <button type="button" onClick={logout} className="hover:text-white">
            Salir
          </button>
        </div>
      )}
    </header>
  );
}
