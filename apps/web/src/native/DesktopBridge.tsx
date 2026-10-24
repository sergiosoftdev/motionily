import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { desktop } from "../desktop";
import { RouteName, useRoute } from "../router";

/**
 * The desktop app's side of the editor: tells it which video is open (File › Save Video as Folder…)
 * and follows where it sends the user (File › Open Project Folder… opens the imported video).
 */
export function DesktopBridge() {
  const route = useRoute();
  const project = route.name === RouteName.Editor ? route.id : null;

  useEffect(() => {
    if (desktop) void invoke("desktop_route", { project });
  }, [project]);

  useEffect(() => {
    if (!desktop) return;
    const off = listen<string>("desktop-navigate", (e) => {
      window.location.hash = e.payload;
    });
    return () => void off.then((f) => f());
  }, []);

  return null;
}
