import { useSyncExternalStore } from "react";

/** Tiny hash router: #/projects, #/new, #/p/:id. Survives reloads, no dependency. */
export const RouteName = { Projects: "projects", NewProject: "new", Editor: "editor" } as const;
export type RouteName = (typeof RouteName)[keyof typeof RouteName];

export type Route = { name: typeof RouteName.Projects } | { name: typeof RouteName.NewProject } | { name: typeof RouteName.Editor; id: string };

function parse(hash: string): Route {
  const [, first, second] = hash.replace(/^#/, "").split("/");
  if (first === "p" && second) return { name: RouteName.Editor, id: second };
  if (first === RouteName.NewProject) return { name: RouteName.NewProject };
  return { name: RouteName.Projects };
}

export function href(route: Route): string {
  switch (route.name) {
    case RouteName.Editor:
      return `#/p/${route.id}`;
    case RouteName.NewProject:
      return "#/new";
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
