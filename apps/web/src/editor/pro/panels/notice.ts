import { create } from "zustand";

export const NoticeKind = { Error: "error", Info: "info" } as const;
export type NoticeKind = (typeof NoticeKind)[keyof typeof NoticeKind];

type Notice = { text: string; kind: NoticeKind; at: number };

/** How long a notice stays in the menu bar. */
const NOTICE_MS = 6000;

/** The last thing a menu or panel action has to say (a refused op, a missing selection). */
export const useNotice = create<{ notice: Notice | null }>(() => ({ notice: null }));

export function notify(text: string, kind: NoticeKind = NoticeKind.Error) {
  const at = Date.now();
  useNotice.setState({ notice: { text, kind, at } });
  setTimeout(() => {
    if (useNotice.getState().notice?.at === at) useNotice.setState({ notice: null });
  }, NOTICE_MS);
}

export const clearNotice = () => useNotice.setState({ notice: null });
