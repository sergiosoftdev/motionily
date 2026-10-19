/**
 * 2D scene templates the agent fills with its own words. 3D sets, people and
 * camera are built procedurally (prefabs, stickman rigs, shots), never from stock models. Each returns ops for apply_ops.
 * Times are relative to `at`, so templates can be chained into a longer video.
 */
import type { Op } from "@motionily/protocol";

export const TemplateId = {
  KineticTitle: "kinetic_title",
} as const;
export type TemplateId = (typeof TemplateId)[keyof typeof TemplateId];

export type TemplateParams = {
  /** Unique prefix for layer/prop ids, so templates can be stacked. */
  id: string;
  /** Second where this beat starts. */
  at: number;
  /** Beat length in seconds. */
  duration: number;
  title: string;
  subtitle?: string;
  /** Short call to action, e.g. "Pide tu demo". */
  cta?: string;
};

type Template = { id: TemplateId; summary: string; uses: string; build: (p: TemplateParams) => Op[] };

const k = (t: number, v: number, ease?: string) => (ease ? { t, v, ease } : { t, v });

const text = (id: string, p: TemplateParams, t: string, opts: Record<string, unknown>) => ({
  op: "add_layer",
  layer: { id, type: "text", text: t, start: p.at, end: p.at + p.duration, fill: "text", w: 900, h: 220, size: 96, ...opts },
});

const shape = (id: string, p: TemplateParams, opts: Record<string, unknown>) => ({
  op: "add_layer",
  layer: { id, type: "shape", shape: "rect", start: p.at, end: p.at + p.duration, fill: "primary", ...opts },
});


export const TEMPLATES: Template[] = [
  {
    id: TemplateId.KineticTitle,
    summary: "Kinetic typography: color block sweeps in, each word of the title pops in sequence, accent bar underlines.",
    uses: "title (2-5 words). No 3D.",
    build: (p) => {
      const words = p.title.split(/\s+/).filter(Boolean).slice(0, 5);
      return [
        shape(`${p.id}-block`, p, { anchor: "center", w: 1100, h: 1100, radius: 0, rotation: -8, anims: [{ use: "animation/slide_in" }] }),
        ...words.map((w, i) =>
          text(`${p.id}-w${i}`, p, w, {
            anchor: "center",
            y: (i - (words.length - 1) / 2) * 150,
            size: 140,
            h: 160,
            fill: i % 2 ? "surface" : "text",
            anims: [{ use: "animation/pop_in", at: 0.3 + i * 0.18 }],
          }),
        ),
        shape(`${p.id}-bar`, p, { anchor: "center", y: (words.length / 2) * 150 + 40, w: 420, h: 22, radius: 11, fill: "accent", anims: [{ use: "animation/slide_in", at: 0.4 + words.length * 0.18 }] }),
      ];
    },
  },
];
