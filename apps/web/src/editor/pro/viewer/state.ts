import { create } from "zustand";
import { groupLayerIds } from "../../../editing/groups";
import { useEditor } from "../../../store";

/** The Composition panel's tools, like AE's Tools bar. */
export const Tool = {
  Select: "select",
  Hand: "hand",
  Zoom: "zoom",
  Rotate: "rotate",
  PanBehind: "pan_behind",
  Shape: "shape",
  Pen: "pen",
  Type: "type",
} as const;
export type Tool = (typeof Tool)[keyof typeof Tool];

/** What the shape tool draws (Q cycles them, as in AE). */
export const ShapeKind = { Rect: "rect", RoundRect: "round_rect", Ellipse: "ellipse", Polygon: "polygon", Star: "star" } as const;
export type ShapeKind = (typeof ShapeKind)[keyof typeof ShapeKind];
export const SHAPE_KINDS: [ShapeKind, string][] = [
  [ShapeKind.Rect, "Rectangle"],
  [ShapeKind.RoundRect, "Rounded Rectangle"],
  [ShapeKind.Ellipse, "Ellipse"],
  [ShapeKind.Polygon, "Polygon"],
  [ShapeKind.Star, "Star"],
];

/** Magnification: CSS px per scene px, or `null` to fit the panel. */
export type Zoom = number | null;
export const ZOOM_FIT = null;
/** What the footer menu offers. */
export const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4] as const;
/** What `.` and `,` step through. */
const ZOOM_STEPS = [0.125, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 8];
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;

/** Overlays toggled from the footer (AE's "Choose grid and guide options"). */
export const Overlay = { Grid: "grid", Rulers: "rulers", Guides: "guides", Safe: "safe", Snap: "snap" } as const;
export type Overlay = (typeof Overlay)[keyof typeof Overlay];

/** Vertical-video apps whose UI covers part of the frame. */
export const Platform = { None: "none", TikTok: "tiktok", Reels: "reels", Shorts: "shorts" } as const;
export type Platform = (typeof Platform)[keyof typeof Platform];
export const PLATFORMS: [Platform, string][] = [
  [Platform.None, "No app UI"],
  [Platform.TikTok, "TikTok"],
  [Platform.Reels, "Instagram Reels"],
  [Platform.Shorts, "YouTube Shorts"],
];

/** Editor-only guides in scene px: vertical lines at `x`, horizontal at `y`. */
export type Guides = { x: number[]; y: number[] };

type ViewerState = {
  tool: Tool;
  shape: ShapeKind;
  zoom: Zoom;
  /** Offset (CSS px) of the frame's center from the stage's center while zoomed. */
  pan: [number, number];
  overlays: Record<Overlay, boolean>;
  platform: Platform;
  /** Layers Shift-added to the selection besides the store's `selectedLayerId`. */
  extra: string[];
  projectId: string | null;
  guides: Guides;
};

const PREFS_KEY = "motionily.proViewer";
const GUIDES_KEY = "motionily.guides.";
const DEFAULT_OVERLAYS: Record<Overlay, boolean> = { grid: false, rulers: false, guides: true, safe: false, snap: true };

type Prefs = { overlays: Record<Overlay, boolean>; platform: Platform };

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    const platform = (Object.values(Platform) as string[]).includes(p?.platform ?? "") ? p!.platform! : Platform.None;
    return { overlays: { ...DEFAULT_OVERLAYS, ...(p?.overlays ?? {}) }, platform };
  } catch {
    return { overlays: DEFAULT_OVERLAYS, platform: Platform.None };
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Not critical: the toggles reset next time.
  }
}

function loadGuides(projectId: string): Guides {
  try {
    const g = JSON.parse(localStorage.getItem(GUIDES_KEY + projectId) ?? "null") as Guides | null;
    return g && Array.isArray(g.x) && Array.isArray(g.y) ? g : { x: [], y: [] };
  } catch {
    return { x: [], y: [] };
  }
}

export const useViewer = create<ViewerState>(() => ({
  tool: Tool.Select,
  shape: ShapeKind.Rect,
  zoom: ZOOM_FIT,
  pan: [0, 0],
  ...loadPrefs(),
  extra: [],
  projectId: null,
  guides: { x: [], y: [] },
}));

export function setTool(tool: Tool) {
  useViewer.setState({ tool });
}

/** Q: the shape tool, then the next shape each press. */
export function cycleShape() {
  const { tool, shape } = useViewer.getState();
  if (tool !== Tool.Shape) return setTool(Tool.Shape);
  const i = SHAPE_KINDS.findIndex(([k]) => k === shape);
  useViewer.setState({ shape: SHAPE_KINDS[(i + 1) % SHAPE_KINDS.length]![0] });
}

export function toggleOverlay(o: Overlay) {
  const s = useViewer.getState();
  const overlays = { ...s.overlays, [o]: !s.overlays[o] };
  useViewer.setState({ overlays });
  savePrefs({ overlays, platform: s.platform });
}

export function setPlatform(platform: Platform) {
  useViewer.setState({ platform });
  savePrefs({ overlays: useViewer.getState().overlays, platform });
}

/** Next zoom step up (dir 1) or down (-1) from `current`. */
export function stepZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > current * 1.01) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((z) => z < current * 0.99) ?? MIN_ZOOM;
}

export const zoomLabel = (z: number) => `${+(z * 100).toFixed(1)}%`;

// ── guides (per project, this browser only) ──────────────────────────────

export function openProject(projectId: string) {
  if (useViewer.getState().projectId === projectId) return;
  useViewer.setState({ projectId, guides: loadGuides(projectId), extra: [] });
}

export function setGuides(guides: Guides) {
  useViewer.setState({ guides });
  const id = useViewer.getState().projectId;
  if (!id) return;
  try {
    localStorage.setItem(GUIDES_KEY + id, JSON.stringify(guides));
  } catch {
    // Not critical: guides last for this session.
  }
}

// ── selection: the store holds the primary layer, Shift adds more here ──────

/** What the gizmos act on: the selected group's layers, or the primary layer plus Shift-added ones. */
export function selectedIds(): string[] {
  const { selectedLayerId, selectedGroup } = useEditor.getState();
  if (selectedGroup) return groupLayerIds(selectedGroup);
  if (!selectedLayerId) return [];
  return [selectedLayerId, ...useViewer.getState().extra.filter((id) => id !== selectedLayerId)];
}

let lastPrimary: string | null = null;

/** Select `ids` (the first one is the primary: Effect Controls shows it). */
export function setSelection(ids: string[]) {
  const unique = [...new Set(ids)];
  lastPrimary = unique[0] ?? null;
  useViewer.setState({ extra: unique.slice(1) });
  useEditor.setState({ selectedLayerId: lastPrimary, selectedGroup: null });
}

/** Selection changed elsewhere (timeline, layers panel): the Shift-added layers no longer apply. */
export function followStoreSelection() {
  return useEditor.subscribe((s, prev) => {
    if (s.selectedLayerId === prev.selectedLayerId && s.selectedGroup === prev.selectedGroup) return;
    if (s.selectedGroup || s.selectedLayerId !== lastPrimary) {
      lastPrimary = s.selectedLayerId;
      if (useViewer.getState().extra.length) useViewer.setState({ extra: [] });
    }
  });
}
