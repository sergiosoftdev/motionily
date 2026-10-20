import { useState } from "react";
import type { ImageCredit } from "@motionily/protocol";
import { mediaUrl } from "../api/client";

const COPIED_MS = 1500;

const creditLine = (c: ImageCredit) => `"${c.title}" — ${c.author} · ${c.license} · ${c.pageUrl}`;

/** Real photos the agent used, with the attribution their licenses ask for (to paste in the post description). */
export function ImageCredits({ credits }: { credits: ImageCredit[] }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(`Images:\n${credits.map(creditLine).join("\n")}`);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-neutral-500">Real photos · credits for the post caption</span>
        <button type="button" onClick={copy} className="shrink-0 text-xs text-neutral-400 hover:text-white">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {credits.map((c) => (
          <li key={c.src} className="flex items-center gap-3">
            <img src={mediaUrl(c.src)} alt="" className="size-10 shrink-0 rounded object-cover" />
            <a href={c.pageUrl} target="_blank" rel="noreferrer" className="min-w-0 text-xs leading-snug hover:text-white">
              <span className="block truncate text-neutral-300">{c.title}</span>
              <span className="block truncate text-neutral-500">
                {c.author} · {c.license}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
