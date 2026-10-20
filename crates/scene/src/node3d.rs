//! Procedural 3D: a tree of primitives (and rigged characters) the agent writes
//! as JSON. Prefabs are named trees stored in the user's library and reused
//! across projects. The scene flattens a tree into solid pieces for one frame;
//! the engine turns each `Geometry` into a cached mesh.

use crate::character::{pose, Action, Pose};
use crate::{ColorRef, Palette, PaletteSlot, Rgba};
use glam::{EulerRot, Mat4, Quat, Vec3};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Mesh recipe. Equal recipes share one GPU mesh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "snake_case")]
pub enum Geometry {
    /// `size` w×h×d (m), corners rounded by `radius`.
    Box {
        size: [f32; 3],
        #[serde(default)]
        radius: f32,
    },
    Cylinder {
        radius: f32,
        height: f32,
    },
    Cone {
        radius: f32,
        height: f32,
    },
    Sphere {
        radius: f32,
    },
    /// Pill along y: `height` is the total height.
    Capsule {
        radius: f32,
        height: f32,
    },
    Torus {
        radius: f32,
        tube: f32,
    },
    /// Flat on the floor (xz), w×d.
    Plane {
        size: [f32; 2],
    },
    /// A 2D outline (x, y points, counter-clockwise) pushed `depth` along z.
    Extrude {
        points: Vec<[f32; 2]>,
        depth: f32,
    },
    /// A profile (radius, y) spun around the y axis: vases, lamps, bottles.
    Lathe {
        points: Vec<[f32; 2]>,
    },
}

impl Geometry {
    /// Half of the largest dimension (m) at scale 1, for framing.
    pub fn extent(&self) -> f32 {
        match self {
            Geometry::Box { size, .. } => size.iter().fold(0.0f32, |a, b| a.max(*b)) / 2.0,
            Geometry::Cylinder { radius, height } | Geometry::Cone { radius, height } | Geometry::Capsule { radius, height } => radius.max(height / 2.0),
            Geometry::Sphere { radius } => *radius,
            Geometry::Torus { radius, tube } => radius + tube,
            Geometry::Plane { size } => size[0].max(size[1]) / 2.0,
            Geometry::Extrude { points, depth } => points.iter().fold(depth / 2.0, |a, p| a.max(p[0].abs()).max(p[1].abs())),
            Geometry::Lathe { points } => points.iter().fold(0.0f32, |a, p| a.max(p[0].abs()).max(p[1].abs())),
        }
    }

    /// Stable cache key for the engine.
    pub fn key(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Copies of a node on a grid (rows of chairs, clinic boxes…).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Repeat {
    /// Copies along x, y, z.
    pub count: [u32; 3],
    /// Distance between copies (m).
    pub spacing: [f32; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HairStyle {
    #[default]
    None,
    Bun,
    Pony,
    Cap,
    Beanie,
}

/// Garment of a stickman (Clinily spots style: only the clothes change).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Garment {
    #[default]
    Tee,
    Shirt,
    Sweater,
    Hoodie,
    Coat,
    /// Long white doctor/physio coat with lapels.
    Labcoat,
    Suit,
    /// Clinic pyjama with a V neck.
    Scrubs,
    Dress,
}

/// A stickman: black silhouette, round faceless head, tube limbs, no hands or feet.
/// Everything that varies is clothing and accessories. Colors: palette slot or raw.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rig {
    /// Total height (m). 1.64 = adult; children ~1.1.
    #[serde(default = "default_height")]
    pub height: f32,
    #[serde(default)]
    pub style: Garment,
    #[serde(default = "primary")]
    pub top: ColorRef,
    #[serde(default = "ink")]
    pub bottom: ColorRef,
    /// Silhouette color (head, hands, legs when not covered). Default near-black.
    #[serde(default = "ink")]
    pub body: ColorRef,
    #[serde(default)]
    pub hair: HairStyle,
    /// Color of the hair bun/pony or hat.
    #[serde(default = "ink")]
    pub hat: ColorRef,
    #[serde(default)]
    pub long_sleeves: Option<bool>,
    #[serde(default)]
    pub shorts: bool,
    /// Stethoscope around the neck.
    #[serde(default)]
    pub steth: bool,
    /// Name badge on the chest.
    #[serde(default)]
    pub badge: bool,
    #[serde(default)]
    pub tie: Option<ColorRef>,
    #[serde(default)]
    pub scarf: Option<ColorRef>,
    #[serde(default)]
    pub action: Action,
}

fn default_height() -> f32 {
    1.64
}
fn primary() -> ColorRef {
    ColorRef::Slot(PaletteSlot::Primary)
}
fn ink() -> ColorRef {
    ColorRef::Raw(Rgba([0.13, 0.15, 0.14, 1.0]))
}

/// What a node is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NodeKind {
    Rig { rig: Rig },
    Prefab { prefab: String },
    Model { model: String },
    Solid(Geometry),
    Group {},
}

impl Default for NodeKind {
    fn default() -> Self {
        NodeKind::Group {}
    }
}

/// One node of a procedural tree. Units: meters, degrees, y up.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Node3D {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(flatten)]
    pub kind: NodeKind,
    #[serde(default)]
    pub position: [f32; 3],
    /// Euler degrees (x, y, z).
    #[serde(default)]
    pub rotation: [f32; 3],
    #[serde(default = "ones")]
    pub scale: [f32; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ColorRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node3D>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Repeat>,
}

fn ones() -> [f32; 3] {
    [1.0; 3]
}

/// A solid piece ready to draw: geometry, world transform (column-major) and color.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawSolid {
    pub geometry: Geometry,
    pub transform: [[f32; 4]; 4],
    pub color: Rgba,
}

/// A glTF model placed by a procedural tree.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawModelNode {
    pub model: String,
    pub transform: [[f32; 4]; 4],
}

/// Inputs for flattening a tree at one instant.
pub struct NodeCtx<'a> {
    pub palette: &'a Palette,
    pub prefabs: &'a BTreeMap<String, Node3D>,
    /// Seconds into the prop (rig actions).
    pub time: f32,
    /// Action override from the prop (e.g. walking prefab character).
    pub action: Option<Action>,
}

const MAX_DEPTH: u32 = 12;

impl Node3D {
    pub fn local(&self) -> Mat4 {
        let r = self.rotation.map(f32::to_radians);
        Mat4::from_scale_rotation_translation(
            Vec3::from(self.scale),
            Quat::from_euler(EulerRot::YXZ, r[1], r[0], r[2]),
            Vec3::from(self.position),
        )
    }

    /// Append every solid/model of this tree under `parent`.
    pub fn flatten(&self, parent: Mat4, inherited: Rgba, ctx: &NodeCtx, out: &mut Vec<DrawSolid>, models: &mut Vec<DrawModelNode>, depth: u32) {
        if depth > MAX_DEPTH {
            return;
        }
        let color = self.color.map_or(inherited, |c| c.resolve(ctx.palette));
        let copies = self.repeat.map_or(vec![Vec3::ZERO], |r| {
            let mut v = Vec::new();
            for x in 0..r.count[0].max(1) {
                for y in 0..r.count[1].max(1) {
                    for z in 0..r.count[2].max(1) {
                        v.push(Vec3::new(x as f32 * r.spacing[0], y as f32 * r.spacing[1], z as f32 * r.spacing[2]));
                    }
                }
            }
            v
        });
        for offset in copies {
            let m = parent * Mat4::from_translation(offset) * self.local();
            match &self.kind {
                NodeKind::Solid(g) => out.push(DrawSolid { geometry: g.clone(), transform: m.to_cols_array_2d(), color }),
                NodeKind::Model { model } => models.push(DrawModelNode { model: model.clone(), transform: m.to_cols_array_2d() }),
                NodeKind::Prefab { prefab } => {
                    if let Some(p) = ctx.prefabs.get(prefab) {
                        p.flatten(m, color, ctx, out, models, depth + 1);
                    }
                }
                NodeKind::Rig { rig } => rig_solids(rig, m, ctx, out),
                NodeKind::Group {} => {}
            }
            for c in &self.children {
                c.flatten(m, color, ctx, out, models, depth + 1);
            }
        }
    }
}

/// Stickman dimensions at 1.64 m (Clinily stickman kit proportions).
mod dims {
    pub const HIP_Y: f32 = 0.78;
    pub const LEG_R: f32 = 0.068;
    pub const THIGH: f32 = 0.34;
    pub const SHIN: f32 = 0.34;
    pub const LEG_X: f32 = 0.085;
    pub const ARM_R: f32 = 0.058;
    pub const UPPER: f32 = 0.25;
    pub const FORE: f32 = 0.24;
    pub const SH_X: f32 = 0.215;
    pub const SH_Y: f32 = 0.36;
    pub const HEAD_R: f32 = 0.175;
    pub const HEAD_Y: f32 = 0.64;
    pub const NECK_R: f32 = 0.075;
    pub const NATURAL_HEIGHT: f32 = 1.64;
    /// Torso garment profile (radius, y) above the chest origin.
    pub const TORSO: [[f32; 2]; 10] = [
        [0.0, -0.04], [0.15, -0.04], [0.175, 0.02], [0.175, 0.14], [0.18, 0.26],
        [0.19, 0.33], [0.17, 0.39], [0.12, 0.43], [0.06, 0.45], [0.0, 0.45],
    ];
}

/// Build a stickman from primitives, posed by its action (same pose clips as the 2D characters).
fn rig_solids(rig: &Rig, base: Mat4, ctx: &NodeCtx, out: &mut Vec<DrawSolid>) {
    use dims::*;
    let p: Pose = pose(ctx.action.unwrap_or(rig.action), ctx.time);
    let col = |c: ColorRef| c.resolve(ctx.palette);
    let (body, top, bottom, hat) = (col(rig.body), col(rig.top), col(rig.bottom), col(rig.hat));
    let shade = |c: Rgba, k: f32| Rgba([c.0[0] * k, c.0[1] * k, c.0[2] * k, c.0[3]]);
    // Everything is modelled at natural size and scaled to the requested height.
    let root = base * Mat4::from_scale(Vec3::splat(rig.height / NATURAL_HEIGHT));
    let mut put = |g: Geometry, m: Mat4, color: Rgba| out.push(DrawSolid { geometry: g, transform: (root * m).to_cols_array_2d(), color });

    // A tube hangs from `at` along the joint's down axis.
    let tube = |m: Mat4, r: f32, len: f32| (Geometry::Capsule { radius: r, height: len + 2.0 * r }, m * Mat4::from_translation(Vec3::new(0.0, -len / 2.0, 0.0)));
    let dress = rig.style == Garment::Dress;
    let pants = !dress && !rig.shorts;
    let long_sleeves = rig.long_sleeves.unwrap_or(matches!(rig.style, Garment::Shirt | Garment::Sweater | Garment::Hoodie | Garment::Coat | Garment::Labcoat | Garment::Suit));

    let hips = Mat4::from_translation(Vec3::new(0.0, HIP_Y + p.hip_y * NATURAL_HEIGHT, 0.0));
    put(Geometry::Sphere { radius: 0.16 }, hips * Mat4::from_scale(Vec3::new(1.12, 0.62, 0.82)), if dress { top } else { bottom });

    for (side, angles) in [(-1.0_f32, p.far_leg), (1.0, p.near_leg)] {
        let hip = hips * Mat4::from_translation(Vec3::new(side * LEG_X, -0.02, 0.0)) * Mat4::from_rotation_x(-angles[0]);
        let leg_color = if pants { bottom } else { body };
        let lr = LEG_R + if pants { 0.008 } else { 0.0 };
        let (g, m) = tube(hip, lr, THIGH);
        put(g, m, leg_color);
        if rig.shorts {
            let (g, m) = tube(hip, LEG_R + 0.014, THIGH * 0.55);
            put(g, m, bottom);
        }
        let knee = hip * Mat4::from_translation(Vec3::new(0.0, -THIGH, 0.0)) * Mat4::from_rotation_x(-angles[1]);
        let (g, m) = tube(knee, lr - 0.004, SHIN);
        put(g, m, leg_color);
    }

    let chest = hips * Mat4::from_translation(Vec3::new(0.0, 0.04, 0.0)) * Mat4::from_rotation_x(-p.lean);
    put(Geometry::Lathe { points: TORSO.to_vec() }, chest * Mat4::from_scale(Vec3::new(1.0, 1.0, 0.8)), top);
    let tail_len = match rig.style {
        Garment::Labcoat => 0.5,
        Garment::Coat => 0.38,
        Garment::Dress => 0.4,
        _ => 0.0,
    };
    if tail_len > 0.0 {
        let bottom_r = if dress { 0.26 } else { 0.175 + tail_len * 0.13 };
        put(
            Geometry::Lathe { points: vec![[0.165, 0.0], [bottom_r, -tail_len]] },
            chest * Mat4::from_scale(Vec3::new(1.0, 1.0, 0.82)),
            top,
        );
    }
    if matches!(rig.style, Garment::Labcoat | Garment::Coat) {
        for side in [-1.0_f32, 1.0] {
            put(
                Geometry::Box { size: [0.045, 0.22, 0.012], radius: 0.006 },
                chest * Mat4::from_translation(Vec3::new(side * 0.05, 0.28, 0.14)) * Mat4::from_rotation_z(-side * 0.25),
                shade(top, 0.86),
            );
        }
    }
    if rig.style == Garment::Scrubs {
        put(Geometry::Cone { radius: 0.05, height: 0.07 }, chest * Mat4::from_translation(Vec3::new(0.0, 0.39, 0.13)) * Mat4::from_rotation_x(std::f32::consts::PI), body);
    }
    if matches!(rig.style, Garment::Shirt | Garment::Suit) {
        put(Geometry::Torus { radius: 0.07, tube: 0.016 }, chest * Mat4::from_translation(Vec3::new(0.0, 0.43, 0.0)) * Mat4::from_rotation_x(-0.2), if rig.style == Garment::Suit { Rgba([0.96, 0.96, 0.94, 1.0]) } else { top });
    }
    if rig.style == Garment::Hoodie {
        put(Geometry::Sphere { radius: 0.08 }, chest * Mat4::from_translation(Vec3::new(0.0, 0.42, -0.1)) * Mat4::from_scale(Vec3::new(1.3, 0.7, 0.9)), top);
    }
    if let Some(tie) = rig.tie {
        put(Geometry::Box { size: [0.03, 0.2, 0.012], radius: 0.006 }, chest * Mat4::from_translation(Vec3::new(0.0, 0.3, 0.14)), col(tie));
    }
    if let Some(scarf) = rig.scarf {
        put(Geometry::Torus { radius: 0.085, tube: 0.035 }, chest * Mat4::from_translation(Vec3::new(0.0, 0.45, 0.0)), col(scarf));
    }
    if rig.badge {
        put(Geometry::Box { size: [0.045, 0.06, 0.008], radius: 0.006 }, chest * Mat4::from_translation(Vec3::new(0.07, 0.27, 0.14)), Rgba([1.0, 1.0, 1.0, 1.0]));
    }
    if rig.steth {
        put(Geometry::Torus { radius: 0.095, tube: 0.009 }, chest * Mat4::from_translation(Vec3::new(0.0, 0.38, 0.1)) * Mat4::from_rotation_x(1.2), Rgba([0.12, 0.12, 0.14, 1.0]));
        put(Geometry::Sphere { radius: 0.026 }, chest * Mat4::from_translation(Vec3::new(0.05, 0.27, 0.15)), Rgba([0.72, 0.74, 0.73, 1.0]));
    }

    for (side, angles) in [(-1.0_f32, p.far_arm), (1.0, p.near_arm)] {
        let sh = chest * Mat4::from_translation(Vec3::new(side * SH_X, SH_Y, 0.0)) * Mat4::from_rotation_x(-angles[0]);
        put(Geometry::Sphere { radius: ARM_R + 0.014 }, sh, top);
        if long_sleeves {
            let (g, m) = tube(sh, ARM_R + 0.008, UPPER);
            put(g, m, top);
        } else {
            let (g, m) = tube(sh, ARM_R + 0.012, UPPER * 0.45);
            put(g, m, top);
            let (g, m) = tube(sh, ARM_R, UPPER);
            put(g, m, body);
        }
        let el = sh * Mat4::from_translation(Vec3::new(0.0, -UPPER, 0.0)) * Mat4::from_rotation_x(-angles[1]);
        let (g, m) = tube(el, ARM_R - 0.004, FORE);
        put(g, m, if long_sleeves && matches!(rig.style, Garment::Labcoat | Garment::Coat | Garment::Suit) { top } else { body });
    }

    put(Geometry::Cylinder { radius: NECK_R, height: 0.12 }, chest * Mat4::from_translation(Vec3::new(0.0, 0.47, 0.0)), body);
    let head = chest * Mat4::from_translation(Vec3::new(0.0, HEAD_Y, 0.0)) * Mat4::from_rotation_x(p.head);
    put(Geometry::Sphere { radius: HEAD_R }, head, body);
    match rig.hair {
        HairStyle::None => {}
        HairStyle::Bun => put(Geometry::Sphere { radius: 0.07 }, head * Mat4::from_translation(Vec3::new(0.0, 0.13, -0.12)), hat),
        HairStyle::Pony => {
            put(Geometry::Sphere { radius: 0.045 }, head * Mat4::from_translation(Vec3::new(0.0, 0.05, -0.17)), hat);
            put(Geometry::Capsule { radius: 0.035, height: 0.2 }, head * Mat4::from_translation(Vec3::new(0.0, -0.06, -0.2)), hat);
        }
        HairStyle::Cap => {
            put(Geometry::Sphere { radius: HEAD_R + 0.006 }, head * Mat4::from_translation(Vec3::new(0.0, 0.07, 0.0)) * Mat4::from_scale(Vec3::new(1.0, 0.6, 1.0)), hat);
            put(Geometry::Box { size: [0.2, 0.014, 0.13], radius: 0.006 }, head * Mat4::from_translation(Vec3::new(0.0, 0.055, HEAD_R + 0.04)), hat);
        }
        HairStyle::Beanie => {
            put(Geometry::Sphere { radius: HEAD_R + 0.008 }, head * Mat4::from_translation(Vec3::new(0.0, 0.06, 0.0)) * Mat4::from_scale(Vec3::new(1.0, 0.7, 1.0)), hat);
            put(Geometry::Sphere { radius: 0.045 }, head * Mat4::from_translation(Vec3::new(0.0, HEAD_R + 0.02, 0.0)), Rgba([1.0, 1.0, 1.0, 1.0]));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_primitives_groups_prefabs_and_rigs() {
        let n: Node3D = serde_json::from_str(
            r#"{"name":"camilla","children":[
                {"shape":"box","size":[1.9,0.12,0.7],"radius":0.05,"position":[0,0.62,0],"color":"primary"},
                {"shape":"cylinder","radius":0.03,"height":0.6,"position":[-0.85,0.3,-0.3],"repeat":{"count":[2,1,2],"spacing":[1.7,0,0.6]}},
                {"prefab":"pillow","position":[0.7,0.72,0]},
                {"rig":{"style":"labcoat","top":"surface","hair":"bun","steth":true,"action":"wave"},"position":[0,0,1]}]}"#,
        )
        .unwrap();
        assert!(matches!(n.kind, NodeKind::Group {}));
        let mut prefabs = BTreeMap::new();
        prefabs.insert("pillow".into(), serde_json::from_str::<Node3D>(r#"{"shape":"sphere","radius":0.1}"#).unwrap());
        let palette = crate::StylePreset::Clean.palette();
        let ctx = NodeCtx { palette: &palette, prefabs: &prefabs, time: 0.5, action: None };
        let (mut solids, mut models) = (Vec::new(), Vec::new());
        n.flatten(Mat4::IDENTITY, palette.surface, &ctx, &mut solids, &mut models, 0);
        let legs = solids.iter().filter(|s| matches!(s.geometry, Geometry::Cylinder { height, .. } if (height - 0.6).abs() < 1e-6)).count();
        assert_eq!(legs, 4, "repeat makes four legs");
        assert!(solids.len() > 15, "bed + pillow + a rigged character");
    }
}

#[cfg(test)]
mod debug_tests {
    use super::*;

    #[test]
    fn rig_pieces_stay_near_the_character() {
        let n: Node3D = serde_json::from_str(r#"{"rig":{"style":"labcoat","hair":"bun","steth":true,"badge":true,"action":"stressed"}}"#).unwrap();
        let palette = crate::StylePreset::Clean.palette();
        let prefabs = BTreeMap::new();
        for action in [None, Some(Action::Walk)] {
            let ctx = NodeCtx { palette: &palette, prefabs: &prefabs, time: 0.7, action };
            let (mut solids, mut models) = (Vec::new(), Vec::new());
            n.flatten(Mat4::IDENTITY, palette.surface, &ctx, &mut solids, &mut models, 0);
            for s in &solids {
                let m = Mat4::from_cols_array_2d(&s.transform);
                let (scale, _, t) = m.to_scale_rotation_translation();
                assert!(t.is_finite() && t.length() < 3.0, "piece far away: {t:?} {:?}", s.geometry);
                assert!(scale.is_finite() && scale.max_element() < 5.0, "huge scale {scale:?} {:?}", s.geometry);
            }
        }
    }
}
