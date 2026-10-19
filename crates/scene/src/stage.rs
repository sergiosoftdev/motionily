//! 3D stage: a camera and props (glTF models: characters, furniture, buildings)
//! drawn behind the 2D layers. Models are referenced by key ("characters/
//! character-female-b"); the engine loads and renders them.

use crate::node3d::{DrawModelNode, DrawSolid, NodeCtx};
use crate::{Action, Animated, ColorRef, Easing, Node3D, Palette, Rgba};
use glam::{Mat4, Quat, Vec3};
use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CameraKind {
    #[default]
    Perspective,
    /// Orthographic at 45°/35°: the isometric look.
    Isometric,
}

/// Orbit camera around `target`. Every number can be keyframed for camera moves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Camera3D {
    #[serde(default)]
    pub kind: CameraKind,
    /// Degrees around the vertical axis (0 = looking from +z towards -z).
    #[serde(default = "default_yaw")]
    pub yaw: Animated,
    /// Degrees above the horizon.
    #[serde(default = "default_pitch")]
    pub pitch: Animated,
    /// World units from the target (orthographic: half the visible height).
    #[serde(default = "default_distance")]
    pub distance: Animated,
    #[serde(default)]
    pub target_x: Animated,
    #[serde(default = "default_target_y")]
    pub target_y: Animated,
    #[serde(default)]
    pub target_z: Animated,
    /// Vertical field of view in degrees (perspective).
    #[serde(default = "default_fov")]
    pub fov: f32,
}

fn default_yaw() -> Animated {
    Animated::Static(30.0)
}
fn default_pitch() -> Animated {
    Animated::Static(25.0)
}
fn default_distance() -> Animated {
    Animated::Static(6.0)
}
fn default_target_y() -> Animated {
    Animated::Static(0.8)
}
fn default_fov() -> f32 {
    35.0
}

impl Default for Camera3D {
    fn default() -> Self {
        Camera3D {
            kind: CameraKind::default(),
            yaw: default_yaw(),
            pitch: default_pitch(),
            distance: default_distance(),
            target_x: Animated::default(),
            target_y: default_target_y(),
            target_z: Animated::default(),
            fov: default_fov(),
        }
    }
}

/// How a prop appears when its time starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropEnter {
    /// Already there.
    #[default]
    None,
    /// Scales up with a bounce.
    Pop,
    /// Drops from above and lands.
    Drop,
    /// Grows from the floor (buildings, furniture).
    Rise,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StageProp {
    pub id: String,
    /// glTF model key, e.g. "characters/character-female-b". Leave empty when using `prefab` or `node`.
    #[serde(default)]
    pub model: String,
    /// Name of a prefab in the user's library (procedural object or character).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefab: Option<String>,
    /// Inline procedural tree (primitives, groups, rigs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<Node3D>,
    /// World position (meters; y is up). Keyframe x/z to walk.
    #[serde(default)]
    pub x: Animated,
    #[serde(default)]
    pub y: Animated,
    #[serde(default)]
    pub z: Animated,
    /// Degrees around y.
    #[serde(default)]
    pub rotation: Animated,
    #[serde(default = "unit")]
    pub scale: Animated,
    /// Animation clip of the model (characters: idle, walk, sit, emote-yes, interact-right…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// Multiplies the model's colors (palette slot or raw color).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<ColorRef>,
    #[serde(default)]
    pub start: f32,
    #[serde(default)]
    pub end: Option<f32>,
    #[serde(default)]
    pub enter: PropEnter,
    /// Seconds after `start` the entrance begins (to stagger props).
    #[serde(default)]
    pub enter_delay: f32,
}

fn unit() -> Animated {
    Animated::Static(1.0)
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Stage {
    #[serde(default)]
    pub camera: Camera3D,
    #[serde(default)]
    pub props: Vec<StageProp>,
    /// Floor color (palette slot); `None` = no floor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor: Option<ColorRef>,
}

/// Resolved camera for one frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawCamera {
    pub kind: CameraKind,
    pub eye: [f32; 3],
    pub target: [f32; 3],
    pub fov: f32,
    /// Orthographic half-height.
    pub ortho: f32,
}

/// Resolved prop for one frame. The engine evaluates `action` at `action_time`.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawProp {
    pub model: String,
    pub position: [f32; 3],
    pub rotation: f32,
    pub scale: [f32; 3],
    pub action: Option<String>,
    pub action_time: f32,
    pub tint: Rgba,
}

/// The whole 3D stage for one frame; drawn first, behind the 2D layers.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawStage {
    pub camera: DrawCamera,
    pub props: Vec<DrawProp>,
    /// Procedural pieces (from prefabs and inline nodes).
    pub solids: Vec<DrawSolid>,
    /// glTF models placed inside procedural trees.
    pub placed: Vec<DrawModelNode>,
    pub floor: Option<Rgba>,
    pub ink: Rgba,
    pub background: Rgba,
}

const ENTER_TIME: f32 = 0.6;

impl Stage {
    pub fn draw(&self, t: f32, palette: &Palette, prefabs: &BTreeMap<String, Node3D>) -> DrawStage {
        let mut solids = Vec::new();
        let mut placed = Vec::new();
        let c = &self.camera;
        let (yaw, pitch) = (c.yaw.sample(t).to_radians(), c.pitch.sample(t).to_radians());
        let d = c.distance.sample(t).max(0.1);
        let target = [c.target_x.sample(t), c.target_y.sample(t), c.target_z.sample(t)];
        let eye = [
            target[0] + d * pitch.cos() * yaw.sin(),
            target[1] + d * pitch.sin(),
            target[2] + d * pitch.cos() * yaw.cos(),
        ];
        let props = self
            .props
            .iter()
            .filter(|p| t >= p.start && p.end.is_none_or(|e| t < e))
            .filter_map(|p| {
                let lt = t - p.start;
                let k = ((lt - p.enter_delay) / ENTER_TIME).clamp(0.0, 1.0);
                let s = p.scale.sample(lt);
                let mut pos = [p.x.sample(lt), p.y.sample(lt), p.z.sample(lt)];
                let mut scale = [s, s, s];
                match p.enter {
                    PropEnter::None => {}
                    PropEnter::Pop => scale = scale.map(|v| v * Easing::Back.apply(k)),
                    PropEnter::Drop => pos[1] += (1.0 - Easing::EaseOut.apply(k)) * 3.0,
                    PropEnter::Rise => scale[1] *= Easing::Back.apply(k),
                }
                if scale.iter().any(|v| *v <= 0.001) {
                    return None;
                }
                let rotation = p.rotation.sample(lt).to_radians();
                // Procedural props: flatten their tree here; the engine only sees solids.
                let tree = p.node.clone().or_else(|| p.prefab.as_ref().map(|name| Node3D { kind: crate::NodeKind::Prefab { prefab: name.clone() }, scale: [1.0; 3], ..Default::default() }));
                if let Some(tree) = tree {
                    let base = Mat4::from_scale_rotation_translation(Vec3::from(scale), Quat::from_rotation_y(rotation), Vec3::from(pos));
                    let action = p.action.as_deref().and_then(|a| serde_json::from_value::<Action>(serde_json::Value::String(a.to_owned())).ok());
                    let ctx = NodeCtx { palette, prefabs, time: lt, action };
                    let tint = p.tint.map_or(palette.surface, |c| c.resolve(palette));
                    tree.flatten(base, tint, &ctx, &mut solids, &mut placed, 0);
                    return None;
                }
                Some(DrawProp {
                    model: p.model.clone(),
                    position: pos,
                    rotation,
                    scale,
                    action: p.action.clone(),
                    action_time: lt,
                    tint: p.tint.map_or(Rgba([1.0; 4]), |c| c.resolve(palette)),
                })
            })
            .collect();
        DrawStage {
            camera: DrawCamera { kind: c.kind, eye, target, fov: c.fov, ortho: d },
            props,
            solids,
            placed,
            floor: self.floor.map(|f| f.resolve(palette)),
            ink: palette.text,
            background: palette.background,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_orbits_its_target() {
        let s = Stage { camera: Camera3D { yaw: 0.0.into(), pitch: 0.0.into(), ..Default::default() }, ..Default::default() };
        let d = s.draw(0.0, &crate::StylePreset::Clean.palette(), &BTreeMap::new());
        assert!((d.camera.eye[2] - 6.0).abs() < 1e-4 && (d.camera.eye[1] - 0.8).abs() < 1e-4);
    }

    #[test]
    fn props_enter_after_their_delay() {
        let prop: StageProp = serde_json::from_str(r#"{"id":"a","model":"furniture/desk","enter":"pop","enter_delay":0.5}"#).unwrap();
        let s = Stage { props: vec![prop], ..Default::default() };
        let p = crate::StylePreset::Clean.palette();
        let none = BTreeMap::new();
        assert!(s.draw(0.2, &p, &none).props.is_empty(), "hidden before its pop");
        assert_eq!(s.draw(2.0, &p, &none).props[0].scale, [1.0, 1.0, 1.0]);
    }
}
