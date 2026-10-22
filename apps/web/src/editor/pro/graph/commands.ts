/** Keyboard commands the graph editor answers while it has selected keys. */
export const GraphCommand = {
  EasyEase: "easy_ease",
  EaseIn: "ease_in",
  EaseOut: "ease_out",
  Delete: "delete",
} as const;
export type GraphCommand = (typeof GraphCommand)[keyof typeof GraphCommand];

/**
 * The mounted graph editor's command entry. Pro's shortcut table listens on window (capture) before
 * the graph sees a key, so its F9 / ⇧F9 / ⌘⇧F9 / Delete handlers should try this first:
 * `if (graphKeys.run?.(GraphCommand.Delete)) return;` — true means the graph handled it.
 */
export const graphKeys: { run: ((cmd: GraphCommand) => boolean) | null } = { run: null };
