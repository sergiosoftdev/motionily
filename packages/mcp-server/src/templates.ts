/**
 * Scene templates: hand-designed beats (3D set, camera move, characters, type and
 * motion) that the agent fills with its own words. Each returns ops for apply_ops.
 * Times are relative to `at`, so templates can be chained into a longer video.
 */
import type { Op } from "@motionily/protocol";

export const TemplateId = {
  ClinicScene: "clinic_scene",
  ProductReveal: "product_reveal",
  KineticTitle: "kinetic_title",
  CityIntro: "city_intro",
  CharacterCta: "character_cta",
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
  /** Model key for the hero object/character (see list_models). */
  model?: string;
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

const prop = (p: TemplateParams, id: string, model: string, opts: Record<string, unknown>) => ({
  op: "put_prop",
  prop: { id: `${p.id}-${id}`, model, start: p.at, end: p.at + p.duration, ...opts },
});

export const TEMPLATES: Template[] = [
  {
    id: TemplateId.ClinicScene,
    summary: "3D treatment room: patient on the camilla, physio treating, slow orbit and push-in, title card on top.",
    uses: "title (+ subtitle). model = physio character (default characters/character-female-b).",
    build: (p) => [
      { op: "set_stage_preset", kind: "clinic_room" },
      prop(p, "paciente", "characters/character-male-c", { x: 0.35, y: 0.45, z: -1.25, action: "sit", enter: "pop" }),
      prop(p, "fisio", p.model ?? "characters/character-female-b", { x: 0.95, z: -0.35, rotation: -40, action: "interact-left", enter: "drop", enter_delay: 0.25 }),
      {
        op: "set_camera",
        camera: {
          yaw: [k(p.at, 12), k(p.at + p.duration, 40, "ease_in_out")],
          pitch: [k(p.at, 30), k(p.at + p.duration, 22, "ease_in_out")],
          distance: [k(p.at, 7.0), k(p.at + p.duration, 5.6, "ease_in_out")],
          target_x: 0.2,
          target_y: 0.35,
          target_z: -0.8,
        },
      },
      shape(`${p.id}-card`, p, { anchor: "top", w: 900, h: 260, radius: 40, fill: "surface", anims: [{ use: "animation/pop_in", at: 0.3 }] }),
      text(`${p.id}-title`, p, p.title, { anchor: "top", w: 800, h: 150, y: p.subtitle ? -30 : 0, anims: [{ use: "animation/fade_up", at: 0.45 }] }),
      ...(p.subtitle
        ? [text(`${p.id}-sub`, p, p.subtitle, { anchor: "top", y: 70, w: 780, h: 70, size: 44, role: "body", fill: "primary", anims: [{ use: "animation/fade_up", at: 0.65 }] })]
        : []),
    ],
  },
  {
    id: TemplateId.ProductReveal,
    summary: "Hero object rises on an empty studio floor while the camera circles it; big title then subtitle.",
    uses: "title, subtitle. model = the hero object (any furniture/shop/building model).",
    build: (p) => [
      { op: "set_stage_preset", kind: "empty_studio" },
      prop(p, "hero", p.model ?? "furniture/laptop", { scale: 2.2, enter: "rise", rotation: [k(0, -30), k(p.duration, 30)] }),
      {
        op: "set_camera",
        camera: {
          yaw: [k(p.at, -25), k(p.at + p.duration, 25, "ease_in_out")],
          pitch: 18,
          distance: [k(p.at, 3.4), k(p.at + p.duration, 2.6, "ease_in_out")],
          target_x: 0.3,
          target_y: 0.35,
          target_z: -0.3,
        },
      },
      text(`${p.id}-title`, p, p.title, { anchor: "top", size: 110, anims: [{ use: "animation/mask_reveal", at: 0.5 }] }),
      ...(p.subtitle ? [text(`${p.id}-sub`, p, p.subtitle, { anchor: "bottom", size: 48, role: "body", h: 120, anims: [{ use: "animation/fade_up", at: 1.0 }] })] : []),
    ],
  },
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
  {
    id: TemplateId.CityIntro,
    summary: "Isometric city builds itself block by block; camera drifts; title lands on a card.",
    uses: "title (+ subtitle).",
    build: (p) => [
      { op: "set_stage_preset", kind: "iso_city" },
      {
        op: "set_camera",
        camera: { kind: "isometric", yaw: [k(p.at, 35), k(p.at + p.duration, 55, "ease_in_out")], pitch: 35, distance: [k(p.at, 4.6), k(p.at + p.duration, 3.8)], target_y: 0.4 },
      },
      shape(`${p.id}-card`, p, { anchor: "top", w: 880, h: 220, radius: 36, fill: "surface", anims: [{ use: "animation/pop_in", at: 1.2 }] }),
      text(`${p.id}-title`, p, p.title, { anchor: "top", w: 780, h: 140, anims: [{ use: "animation/fade_up", at: 1.35 }] }),
      ...(p.subtitle ? [text(`${p.id}-sub`, p, p.subtitle, { anchor: "bottom", size: 46, role: "body", h: 110, anims: [{ use: "animation/fade_up", at: 1.7 }] })] : []),
    ],
  },
  {
    id: TemplateId.CharacterCta,
    summary: "Closing beat: a character waves (emote-yes) on a clean floor, CTA pill pops with the title.",
    uses: "title, cta. model = character.",
    build: (p) => [
      { op: "set_stage_preset", kind: "empty_studio" },
      prop(p, "host", p.model ?? "characters/character-female-a", { scale: 1.6, action: "emote-yes", enter: "drop" }),
      { op: "set_camera", camera: { yaw: 15, pitch: 10, distance: [k(p.at, 3.4), k(p.at + p.duration, 2.9, "ease_out")], target_y: 0.6 } },
      text(`${p.id}-title`, p, p.title, { anchor: "top", size: 100, anims: [{ use: "animation/fade_up", at: 0.4 }] }),
      ...(p.cta
        ? [
            shape(`${p.id}-pill`, p, { anchor: "bottom", w: 560, h: 120, radius: 60, fill: "primary", anims: [{ use: "animation/pop_in", at: 0.8 }] }),
            text(`${p.id}-cta`, p, p.cta, { anchor: "bottom", w: 500, h: 90, size: 52, fill: "surface", anims: [{ use: "animation/pop_in", at: 0.9 }] }),
          ]
        : []),
    ],
  },
];
