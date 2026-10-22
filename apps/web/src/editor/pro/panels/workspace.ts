import { create } from "zustand";

/** Tabs of the left panel. */
export const LeftTab = { Controls: "controls", Project: "project" } as const;
export type LeftTab = (typeof LeftTab)[keyof typeof LeftTab];

/** Tabs of the right panel, next to the agent. */
export const RightTab = { Agent: "agent", Activity: "activity", Effects: "effects" } as const;
export type RightTab = (typeof RightTab)[keyof typeof RightTab];

/** AE's type and layout panels, stacked under the agent in the right column (hidden from Window). */
export const ToolTab = { Character: "character", Paragraph: "paragraph", Align: "align" } as const;
export type ToolTab = (typeof ToolTab)[keyof typeof ToolTab];

/** Dialogs the Layer menu opens before it creates anything. */
export const DialogKind = { Solid: "solid", Camera: "camera", Precompose: "precompose" } as const;
export type DialogKind = (typeof DialogKind)[keyof typeof DialogKind];

/** A property row clicked in Effect Controls: Animation > Add Expression acts on it. */
export type FocusedProp = { id: string; props: string[]; label: string };

type Workspace = {
  left: LeftTab;
  right: RightTab;
  /** null = the tool panel is closed. */
  tool: ToolTab | null;
  dialog: DialogKind | null;
  prop: FocusedProp | null;
};

const TOOL_KEY = "motionily.proTool";

function loadTool(): ToolTab | null {
  try {
    const v = localStorage.getItem(TOOL_KEY);
    if (v === "") return null;
    return (Object.values(ToolTab) as string[]).includes(v ?? "") ? (v as ToolTab) : ToolTab.Character;
  } catch {
    return ToolTab.Character;
  }
}

/** Which Pro panels are open, shared by the panels themselves and the Window menu. */
export const useWorkspace = create<Workspace>(() => ({
  left: LeftTab.Controls,
  right: RightTab.Agent,
  tool: loadTool(),
  dialog: null,
  prop: null,
}));

export const setLeft = (left: LeftTab) => useWorkspace.setState({ left });
export const setRight = (right: RightTab) => useWorkspace.setState({ right });
export const openDialog = (dialog: DialogKind | null) => useWorkspace.setState({ dialog });
export const focusProp = (prop: FocusedProp | null) => useWorkspace.setState({ prop });

/** Show a tool tab, or close the tool panel when that tab is already showing. */
export function toggleTool(t: ToolTab) {
  const tool = useWorkspace.getState().tool === t ? null : t;
  useWorkspace.setState({ tool });
  try {
    localStorage.setItem(TOOL_KEY, tool ?? "");
  } catch {
    // Not critical: the next visit opens Character.
  }
}

export const setTool = (t: ToolTab) => {
  if (useWorkspace.getState().tool !== t) toggleTool(t);
};
