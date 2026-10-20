/**
 * `get_layout` answers "where does this land on screen?" with numbers, so an agent never has to
 * render test rectangles to learn how the camera, depth or a tilted plane place things.
 */
import type { FrameLayout, LayoutRow } from "@motionily/protocol";

/** Below this share of the frame a layer reads as a speck. */
const TINY_SHARE = 0.002;
/** Allowed share of a layer outside the frame before it is flagged. */
const OFF_TOLERANCE = 0.02;

export type LayoutFilter = { ids?: string[]; group?: string; hidden?: boolean };

const r = (n: number) => Math.round(n);

function flags(row: LayoutRow, [sw, sh]: [number, number]): string[] {
  const [x0, y0, x1, y1] = row.screen;
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const inside = Math.max(0, Math.min(x1, sw) - Math.max(x0, 0)) * Math.max(0, Math.min(y1, sh) - Math.max(y0, 0));
  const out: string[] = [];
  if (!row.visible) out.push("hidden");
  if (x0 <= 0 && y0 <= 0 && x1 >= sw && y1 >= sh) out.push("fills frame");
  else if (inside / area < 1 - OFF_TOLERANCE) out.push(`${r((1 - inside / area) * 100)}% off frame`);
  if (row.visible && inside > 0 && area / (sw * sh) < TINY_SHARE) out.push("tiny");
  return out;
}

function offFrame(row: LayoutRow, [sw, sh]: [number, number]): boolean {
  const [x0, y0, x1, y1] = row.screen;
  return x1 <= 0 || y1 <= 0 || x0 >= sw || y0 >= sh;
}

function rowLine(row: LayoutRow, size: [number, number]): string {
  const [x0, y0, x1, y1] = row.screen;
  const parts = [
    row.id,
    row.group ? `[${row.group}]` : "",
    `${r(x0)},${r(y0)}→${r(x1)},${r(y1)} (${r(x1 - x0)}×${r(y1 - y0)}${row.ink ? " ink" : ""})`,
    row.k !== 1 ? `k=${row.k.toFixed(2)}` : "",
    row.z !== 0 ? `z=${r(row.z)}` : "",
    row.plane ? `plane=${row.plane}` : "",
    ...flags(row, size),
  ];
  return parts.filter(Boolean).join(" ");
}

/** Compact text for the agent: one line per layer and instant. */
export function formatLayouts(layouts: FrameLayout[], size: [number, number], filter: LayoutFilter): string {
  // Asking for a component instance also lists the layers inside it (`instance/layer`).
  const byId = (id: string) => !filter.ids?.length || filter.ids.some((want) => id === want || id.startsWith(`${want}/`));
  const wanted = (row: LayoutRow) => byId(row.id) && (!filter.group || row.group === filter.group) && (row.visible || filter.hidden || !!filter.ids?.length);
  return layouts
    .map((frame) => {
      const head = [`t=${frame.t}s · frame ${size[0]}×${size[1]}`];
      if (frame.camera) {
        const { look, dolly, focal } = frame.camera;
        head.push(`camera look=${r(look[0])},${r(look[1])} dolly=${r(dolly)} focal=${r(focal)} → z=${r(dolly)} draws 1:1, z≤${r(dolly - focal)} is behind it`);
      } else head.push("no camera (flat; z≠0 still scales around the frame center)");
      const matching = frame.layers.filter(wanted);
      // Layers entirely outside the frame are one line: usually fine (waiting off screen), sometimes the bug.
      const outside = matching.filter((row) => offFrame(row, size)).map((row) => row.id);
      const rows = matching.filter((row) => !offFrame(row, size)).map((row) => rowLine(row, size));
      const behind = frame.behind.filter(byId);
      return [
        head.join(" · "),
        ...(rows.length ? rows : ["(no matching layers on screen at this time)"]),
        ...(outside.length ? [`entirely off frame: ${outside.join(", ")}`] : []),
        ...(behind.length ? [`behind the camera (not drawn): ${behind.join(", ")}`] : []),
      ].join("\n");
    })
    .join("\n\n");
}
