import { invoke } from "@tauri-apps/api/core";
import { API_URL } from "../api/client";
import { SideFile } from "@motionily/protocol";
import { desktop } from "../desktop";
import { engineHost } from "../engine/host";
import { sceneOutput } from "./resolution";

/** Where other editors find the media: the uploads folder on this machine (desktop) or the API's URLs. */
function mediaRoot(): string {
  return desktop?.mediaDir ? `file://${encodeURI(desktop.mediaDir)}/` : `${API_URL}/media/`;
}

/** The file's text for the scene as it is now (subtitles follow the export range, like the video). */
export function sideFileText(kind: SideFile, name: string): string {
  const range = sceneOutput().range ?? null;
  switch (kind) {
    case SideFile.Srt:
    case SideFile.Vtt:
      return engineHost.subtitles(kind, range);
    case SideFile.Fcpxml:
    case SideFile.Otio:
    case SideFile.Edl:
      return engineHost.timelineFile(kind, name || "Motionily video", mediaRoot());
  }
}

/** Desktop: write it next to the exports and return the path. Browser: download it. */
export async function saveSideFile(name: string, kind: SideFile, text: string): Promise<string | null> {
  if (desktop) return invoke<string>("save_side_file", { name, kind, contents: text });
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name || "motionily"}.${kind}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
