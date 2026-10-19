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
    None,
    #[default]
    Short,
    Long,
    Bun,
    Cap,
}

/// A procedural 3D character (stickman style: no hands or feet). Colors are palette slots or raw.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rig {
    /// Total height (m). Default 1.7.
    #[serde(default = "default_height")]
    pub height: f32,
    #[serde(default = "skin")]
    pub skin: ColorRef,
    #[serde(default = "primary")]
    pub top: ColorRef,
    #[serde(default = "text")]
    pub bottom: ColorRef,
    #[serde(default)]
    pub hair: HairStyle,
    #[serde(default = "text")]
    pub hair_color: ColorRef,
    /// Long coat over the top (doctor/physio bata).
    #[serde(default)]
    pub coat: Option<ColorRef>,
    /// 0.8 slim … 1.3 broad.
    #[serde(default = "unit")]
    pub build: f32,
    #[serde(default)]
    pub action: Action,
}

fn default_height() -> f32 {
    1.7
}
fn unit() -> f32 {
    1.0
}
fn skin() -> ColorRef {
    ColorRef::Raw(Rgba([0.95, 0.78, 0.65, 1.0]))
}
fn primary() -> ColorRef {
    ColorRef::Slot(PaletteSlot::Primary)
}
fn text() -> ColorRef {
    ColorRef::Slot(PaletteSlot::Text)
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

/// Build a rigged character from capsules posed by its action (shared with the 2D characters).
fn rig_solids(rig: &Rig, base: Mat4, ctx: &NodeCtx, out: &mut Vec<DrawSolid>) {
    let p: Pose = pose(ctx.action.unwrap_or(rig.action), ctx.time);
    let h = rig.height;
    let col = |c: ColorRef| c.resolve(ctx.palette);
    let (skin, top, bottom, hair) = (col(rig.skin), col(rig.top), col(rig.bottom), col(rig.hair_color));
    let limb = h * 0.055 * rig.build;
    let (leg, arm, torso) = ([h * 0.25, h * 0.24], [h * 0.17, h * 0.16], h * 0.3);
    let head_r = h * 0.075;
    let mut put = |g: Geometry, m: Mat4, color: Rgba| out.push(DrawSolid { geometry: g, transform: (base * m).to_cols_array_2d(), color });

    // Bones are capsules from `a` to `b` (body space: y up, z forward, x side).
    let bone = |a: Vec3, b: Vec3, r: f32, color: Rgba, put: &mut dyn FnMut(Geometry, Mat4, Rgba)| {
        let d = b - a;
        let len = d.length().max(1e-4);
        let rot = Quat::from_rotation_arc(Vec3::Y, d / len);
        put(Geometry::Capsule { radius: r, height: len + 2.0 * r }, Mat4::from_rotation_translation(rot, (a + b) * 0.5), color);
    };
    // Angle 0 = hanging down; positive swings forward (+z).
    let swing = |from: Vec3, angles: [f32; 2], lens: [f32; 2]| {
        let dir = |a: f32| Vec3::new(0.0, -a.cos(), a.sin());
        let mid = from + dir(angles[0]) * lens[0];
        (mid, mid + dir(angles[0] + angles[1]) * lens[1])
    };

    let hip_y = leg[0] + leg[1] + p.hip_y * h;
    let hip = Vec3::new(0.0, hip_y, 0.0);
    let neck = hip + Vec3::new(0.0, torso * p.lean.cos(), torso * p.lean.sin());
    let shoulder_w = h * 0.11 * rig.build;
    let hip_w = h * 0.06 * rig.build;

    for (side, angles) in [(-1.0_f32, p.far_leg), (1.0, p.near_leg)] {
        let from = hip + Vec3::new(side * hip_w, 0.0, 0.0);
        let (knee, foot) = swing(from, angles, leg);
        bone(from, knee, limb, bottom, &mut put);
        bone(knee, foot, limb, bottom, &mut put);
    }
    // Torso (and coat).
    bone(hip + Vec3::Y * limb, neck, limb * 2.1, top, &mut put);
    if let Some(coat) = rig.coat {
        let c = col(coat);
        put(Geometry::Cylinder { radius: limb * 2.35, height: torso * 1.05 }, Mat4::from_translation(hip + Vec3::new(0.0, torso * 0.35, 0.0)), c);
    }
    for (side, angles) in [(-1.0_f32, p.far_arm), (1.0, p.near_arm)] {
        let from = neck + Vec3::new(side * shoulder_w, -limb, 0.0);
        let (elbow, hand) = swing(from, angles, arm);
        bone(from, elbow, limb * 0.9, rig.coat.map_or(top, col), &mut put);
        bone(elbow, hand, limb * 0.85, skin, &mut put);
    }
    let head = neck + Vec3::new(0.0, head_r * 1.15, 0.0);
    put(Geometry::Sphere { radius: head_r }, Mat4::from_translation(head) * Mat4::from_rotation_x(p.head), skin);
    let hair_cap = |scale: Vec3, offset: Vec3| Mat4::from_translation(head + offset) * Mat4::from_scale(scale);
    match rig.hair {
        HairStyle::None => {}
        HairStyle::Short => put(Geometry::Sphere { radius: head_r * 1.06 }, hair_cap(Vec3::new(1.0, 0.62, 1.0), Vec3::new(0.0, head_r * 0.42, -head_r * 0.08)), hair),
        HairStyle::Long => {
            put(Geometry::Sphere { radius: head_r * 1.08 }, hair_cap(Vec3::new(1.0, 0.65, 1.0), Vec3::new(0.0, head_r * 0.4, -head_r * 0.08)), hair);
            put(Geometry::Box { size: [head_r * 2.1, head_r * 2.2, head_r * 0.8], radius: head_r * 0.35 }, Mat4::from_translation(head + Vec3::new(0.0, -head_r * 0.4, -head_r * 0.7)), hair);
        }
        HairStyle::Bun => {
            put(Geometry::Sphere { radius: head_r * 1.06 }, hair_cap(Vec3::new(1.0, 0.6, 1.0), Vec3::new(0.0, head_r * 0.42, -head_r * 0.08)), hair);
            put(Geometry::Sphere { radius: head_r * 0.48 }, Mat4::from_translation(head + Vec3::new(0.0, head_r * 0.95, -head_r * 0.55)), hair);
        }
        HairStyle::Cap => {
            put(Geometry::Sphere { radius: head_r * 1.08 }, hair_cap(Vec3::new(1.0, 0.55, 1.0), Vec3::new(0.0, head_r * 0.45, 0.0)), hair);
            put(Geometry::Cylinder { radius: head_r * 0.9, height: head_r * 0.12 }, Mat4::from_translation(head + Vec3::new(0.0, head_r * 0.4, head_r * 0.7)), hair);
        }
    }
    // Eyes: two dark dots facing +z.
    for side in [-1.0_f32, 1.0] {
        put(Geometry::Sphere { radius: head_r * 0.13 }, Mat4::from_translation(head + Vec3::new(side * head_r * 0.36, head_r * 0.1, head_r * 0.9)), col(text()));
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
                {"rig":{"coat":"surface","hair":"bun","action":"wave"},"position":[0,0,1]}]}"#,
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
        let n: Node3D = serde_json::from_str(r#"{"rig":{"coat":"surface","hair":"bun","action":"stressed"}}"#).unwrap();
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
