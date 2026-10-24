import type { User } from "@motionily/protocol";

/** What the desktop app (apps/desktop) injects before the editor starts; undefined in a browser. */
export type DesktopInfo = {
  /** The local API the app started (SQLite in the app's data folder). */
  apiUrl?: string;
  /** The install's single local account, already signed in. */
  session?: { token: string; user: User };
  /** How agents start the Motionily MCP server on this machine. */
  mcp?: { command: string; args: string[] } | null;
  platform: string;
  /** Folder of the uploads served at /media (timelines exported for other editors point at it). */
  mediaDir?: string;
  /** The local runtime could not start; the editor shows why instead of loading. */
  error?: string;
};

declare global {
  interface Window {
    __MOTIONILY_DESKTOP__?: DesktopInfo;
  }
}

export const desktop: DesktopInfo | undefined = typeof window === "undefined" ? undefined : window.__MOTIONILY_DESKTOP__;
