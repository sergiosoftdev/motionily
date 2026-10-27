/**
 * Stress scenes for the browser benchmark (bench.html). They mirror the native ones in
 * crates/engine/examples/bench.rs so the two runs compare the same work.
 */
type Json = Record<string, unknown>;

const keys = (a: number, b: number, d: number) => [{ t: 0, v: a, ease: "ease_in_out" }, { t: d, v: b }];
const frame = (layers: Json[]) => ({ version: 1, width: 1080, height: 1920, fps: 30, duration: 6, layers });

/** 200 animated texts, a fifth of them animated per character. */
export function texts(): Json {
  return frame(
    Array.from({ length: 200 }, (_, i) => {
      const [x, y] = [60 + (i % 10) * 100, 120 + Math.floor(i / 10) * 88];
      return {
        id: `t${i}`,
        type: "text",
        text: `Line ${i} moves`,
        x: keys(x, x + 40, 6),
        y,
        size: 34,
        fill: "text",
        rotation: keys(0, 8, 6),
        ...(i % 5 === 0 ? { animate: { by: "char", stagger: 0.02, duration: 0.5, from: { y: 30, opacity: 0, blur: 8 } } } : {}),
      };
    }),
  );
}

/** 800 moving shapes with animated fills. */
export function shapes(): Json {
  return frame(
    Array.from({ length: 800 }, (_, i) => {
      const [x, y] = [(i * 37) % 1080, (i * 91) % 1920];
      return {
        id: `s${i}`,
        type: "shape",
        shape: i % 2 === 0 ? "rect" : "ellipse",
        x: keys(x, 1080 - x, 6),
        y: keys(y, y + 200, 6),
        w: 60,
        h: 60,
        radius: 12,
        rotation: keys(0, 360, 6),
        fill: [{ t: 0, c: "#e5484d" }, { t: 6, c: "#3d7bff" }],
      };
    }),
  );
}

/** 40 layers each with glow, blur and a shadow, under three full-frame color grades. */
export function effects(): Json {
  const layers: Json[] = [{ id: "bg", type: "shape", shape: "rect", x: 540, y: 960, w: 1080, h: 1920, fill: "#141414" }];
  for (let i = 0; i < 40; i++) {
    const [x, y] = [140 + (i % 5) * 200, 200 + Math.floor(i / 5) * 210];
    layers.push({
      id: `e${i}`,
      type: "shape",
      shape: "ellipse",
      x: keys(x, x + 60, 6),
      y,
      w: 140,
      h: 140,
      fill: "#f2c14e",
      effects: [{ fx: "shadow", x: 0, y: 12, blur: 30, color: "#000000", opacity: 0.5 }, { fx: "glow", radius: 40, strength: 1 }, { fx: "blur", radius: 6 }],
    });
  }
  for (let i = 0; i < 3; i++)
    layers.push({ id: `grade${i}`, type: "shape", shape: "rect", adjustment: true, x: 540, y: 960, w: 1080, h: 1920, fill: "#ffffff", effects: [{ fx: "color", exposure: 0.1, contrast: 1.05, saturation: 1.1, vignette: 0.2 }] });
  return frame(layers);
}

export const SCENES: Record<string, () => Json> = { texts_200: texts, shapes_800: shapes, effects_40: effects };
