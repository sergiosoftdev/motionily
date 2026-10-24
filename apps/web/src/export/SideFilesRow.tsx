import { useState } from "react";
import { SIDE_FILE_LABEL, SideFile } from "@motionily/protocol";
import { revealFile } from "./nativeExport";
import { saveSideFile, sideFileText } from "./sideFiles";

const SHORT: Record<SideFile, string> = { srt: ".srt", vtt: ".vtt", fcpxml: "FCPXML", otio: "OTIO", edl: "EDL" };

/** Subtitles and the timeline for other editors, next to the video export (the same as `export_file`). */
export function SideFilesRow({ name }: { name: string }) {
  const [note, setNote] = useState<{ text: string; path?: string; error?: boolean } | null>(null);
  const save = async (kind: SideFile) => {
    try {
      const text = sideFileText(kind, name);
      if (!text.trim()) throw new Error(kind === SideFile.Srt || kind === SideFile.Vtt ? "No captions to write yet." : "No clips on the timeline yet.");
      const path = await saveSideFile(name, kind, text);
      setNote(path ? { text: `Saved ${path.split(/[\\/]/).pop()}`, path } : { text: `${SIDE_FILE_LABEL[kind]} downloaded` });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-neutral-500">Subtitles</span>
        {[SideFile.Srt, SideFile.Vtt].map((k) => (
          <button key={k} type="button" title={SIDE_FILE_LABEL[k]} onClick={() => void save(k)} className="text-neutral-300 hover:text-white">
            {SHORT[k]}
          </button>
        ))}
        <span className="ml-2 text-neutral-500">Timeline</span>
        {[SideFile.Fcpxml, SideFile.Otio, SideFile.Edl].map((k) => (
          <button key={k} type="button" title={SIDE_FILE_LABEL[k]} onClick={() => void save(k)} className="text-neutral-300 hover:text-white">
            {SHORT[k]}
          </button>
        ))}
      </div>
      {note && (
        <p className={`text-[11px] ${note.error ? "text-red-400" : "text-neutral-500"}`}>
          {note.text}
          {note.path && (
            <button type="button" onClick={() => void revealFile(note.path!)} className="ml-1 text-neutral-300 hover:text-white">
              Show
            </button>
          )}
        </p>
      )}
    </div>
  );
}
