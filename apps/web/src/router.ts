import { useSyncExternalStore } from "react";

/**
 * Tiny hash router. Survives reloads, no dependency.
 * #/projects · #/b/:id[/kit] · #/b/:id/new · #/p/:id · #/calendar[/:postId] · #/prefabs · #/sounds · #/settings · #/welcome
 */
export const RouteName = {
  Projects: "projects",
  Brand: "brand",
  NewVideo: "new",
  Editor: "editor",
  /** Scheduled posts, optionally with one open. */
  Calendar: "calendar",
  Prefabs: "prefabs",
  Sounds: "sounds",
  Settings: "settings",
  /** The public landing page, also reachable when signed in. */
  Welcome: "welcome",
} as const;
export type RouteName = (typeof RouteName)[keyof typeof RouteName];

export const BrandTab = { Videos: "videos", Kit: "kit" } as const;
export type BrandTab = (typeof BrandTab)[keyof typeof BrandTab];

export type Route =
  | { name: typeof RouteName.Projects }
  | { name: typeof RouteName.Brand; id: string; tab: BrandTab }
  | { name: typeof RouteName.NewVideo; brandId: string }
  | { name: typeof RouteName.Editor; id: string }
  | { name: typeof RouteName.Calendar; postId?: string }
  | { name: typeof RouteName.Prefabs }
  | { name: typeof RouteName.Sounds }
  | { name: typeof RouteName.Settings }
  | { name: typeof RouteName.Welcome };

function parse(hash: string): Route {
  const [, first, second, third] = hash.replace(/^#/, "").split("/");
  if (first === "p" && second) return { name: RouteName.Editor, id: second };
  if (first === "b" && second) {
    if (third === RouteName.NewVideo) return { name: RouteName.NewVideo, brandId: second };
    return { name: RouteName.Brand, id: second, tab: third === BrandTab.Kit ? BrandTab.Kit : BrandTab.Videos };
  }
  if (first === RouteName.Calendar) return { name: RouteName.Calendar, postId: second || undefined };
  if (first === RouteName.Prefabs) return { name: RouteName.Prefabs };
  if (first === RouteName.Sounds) return { name: RouteName.Sounds };
  if (first === RouteName.Settings) return { name: RouteName.Settings };
  if (first === RouteName.Welcome) return { name: RouteName.Welcome };
  return { name: RouteName.Projects };
}

export function href(route: Route): string {
  switch (route.name) {
    case RouteName.Editor:
      return `#/p/${route.id}`;
    case RouteName.Brand:
      return route.tab === BrandTab.Kit ? `#/b/${route.id}/kit` : `#/b/${route.id}`;
    case RouteName.NewVideo:
      return `#/b/${route.brandId}/new`;
    case RouteName.Calendar:
      return route.postId ? `#/calendar/${route.postId}` : "#/calendar";
    case RouteName.Prefabs:
      return "#/prefabs";
    case RouteName.Sounds:
      return "#/sounds";
    case RouteName.Settings:
      return "#/settings";
    case RouteName.Welcome:
      return "#/welcome";
    case RouteName.Projects:
      return "#/projects";
  }
}

export function navigate(route: Route) {
  window.location.hash = href(route);
}

const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parse(hash);
}
