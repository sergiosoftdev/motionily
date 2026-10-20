//! 3D stage: a camera and props (glTF models: characters, furniture, buildings)
//! drawn behind the 2D layers. Models are referenced by key ("characters/
//! character-female-b"); the engine loads and renders them.

use crate::node3d::{DrawModelNode, DrawSolid, NodeCtx};
use crate::{Action, Animated, ColorRef, Easing, Node3D, Palette, Rgba};
use glam::{Mat4, Quat, Vec2, Vec3};
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
    /// Timed behaviour script (walk somewhere, sit on something, wave…), times relative to `start`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub beats: Vec<Beat>,
}

fn unit() -> Animated {
    Animated::Static(1.0)
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Stage {
    #[serde(default)]
    pub camera: Camera3D,
    /// Camera direction as a shot list. When present it drives the camera; `camera` is the fallback.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shots: Vec<Shot>,
    #[serde(default)]
    pub props: Vec<StageProp>,
    /// Floor color (palette slot); `None` = no floor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor: Option<ColorRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShotKind {
    /// Locked off.
    #[default]
    Static,
    /// Circles the target (`sweep` degrees over the shot).
    Orbit,
    /// Moves in towards the target.
    PushIn,
    /// Moves away from the target.
    PullOut,
    /// Rises from low to high.
    Crane,
    /// Keeps the target (a moving prop) in frame from a fixed angle.
    Follow,
    /// Starts tight on the target and opens up to show everything.
    Reveal,
}

/// What a shot looks at: a prop id, `"all"` (the whole set), or a point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ShotTarget {
    Point([f32; 3]),
    Named(String),
}

impl Default for ShotTarget {
    fn default() -> Self {
        ShotTarget::Named(SHOT_ALL.to_owned())
    }
}

pub const SHOT_ALL: &str = "all";

/// One step of a prop's behaviour script.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Beat {
    /// Seconds from the prop's start.
    pub at: f32,
    /// Seconds the move takes (walks); 0 = instant.
    #[serde(default)]
    pub duration: f32,
    /// Action once this beat is reached (after walking). Default idle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<Action>,
    /// Walk to [x, z].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walk_to: Option<[f32; 2]>,
    /// Walk to another prop and sit on it (y lifts to `seat_height`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sit_on: Option<String>,
    /// Walk up to another prop and stop in front of it, facing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub go_to: Option<String>,
    /// Turn to face another prop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face: Option<String>,
    #[serde(default = "seat_height")]
    pub seat_height: f32,
}

fn seat_height() -> f32 {
    0.0
}

/// Distance kept from a prop when walking up to it.
const APPROACH_GAP: f32 = 0.7;

/// Where a prop is and what it does at `lt`, after running its beats.
struct Resolved {
    pos: [f32; 3],
    yaw: Option<f32>,
    action: Option<Action>,
}

fn run_beats(p: &StageProp, lt: f32, others: &BTreeMap<&str, [f32; 2]>) -> Resolved {
    let mut at = [p.x.sample(lt), p.z.sample(lt)];
    let mut y_lift = 0.0;
    let mut yaw = None;
    let mut action = None;
    for b in p.beats.iter().filter(|b| lt >= b.at) {
        let target_of = |id: &String| others.get(id.as_str()).copied();
        let dest = b
            .walk_to
            .or_else(|| b.sit_on.as_ref().and_then(target_of))
            .or_else(|| {
                b.go_to.as_ref().and_then(target_of).map(|o| {
                    let d = Vec2::from(o) - Vec2::from(at);
                    let len = d.length();
                    if len <= APPROACH_GAP { at } else { (Vec2::from(at) + d * ((len - APPROACH_GAP) / len)).to_array() }
                })
            });
        if let Some(dest) = dest {
            let dir = Vec2::from(dest) - Vec2::from(at);
            let k = if b.duration > 0.0 { ((lt - b.at) / b.duration).clamp(0.0, 1.0) } else { 1.0 };
            if dir.length() > 1e-3 {
                yaw = Some(dir.x.atan2(dir.y));
            }
            at = (Vec2::from(at) + dir * k).to_array();
            if k < 1.0 {
                action = Some(Action::Walk);
                y_lift = 0.0;
                break;
            }
        }
        if let Some(face) = b.face.as_ref().and_then(|id| others.get(id.as_str())) {
            let d = Vec2::from(*face) - Vec2::from(at);
            yaw = Some(d.x.atan2(d.y));
        }
        y_lift = if b.sit_on.is_some() { b.seat_height } else { 0.0 };
        action = Some(b.action.unwrap_or(if b.sit_on.is_some() { Action::Sit } else { Action::Idle }));
    }
    Resolved { pos: [at[0], p.y.sample(lt) + y_lift, at[1]], yaw, action }
}

/// One camera shot, like a director would call it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Shot {
    pub start: f32,
    pub end: f32,
    #[serde(default)]
    pub kind: ShotKind,
    #[serde(default)]
    pub target: ShotTarget,
    /// Degrees around the target (0 = from +z / the front).
    #[serde(default = "shot_yaw")]
    pub yaw: f32,
    /// Degrees above the horizon.
    #[serde(default = "shot_pitch")]
    pub pitch: f32,
    /// Framing: 1 fits the target, <1 tighter, >1 wider.
    #[serde(default = "unit_f")]
    pub framing: f32,
    /// Orbit amount in degrees.
    #[serde(default = "shot_sweep")]
    pub sweep: f32,
    #[serde(default)]
    pub ease: Easing,
    /// Seconds blending in from the previous shot (0 = hard cut).
    #[serde(default)]
    pub blend: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind_camera: Option<CameraKind>,
}

fn shot_yaw() -> f32 {
    25.0
}
fn shot_pitch() -> f32 {
    18.0
}
fn unit_f() -> f32 {
    1.0
}
fn shot_sweep() -> f32 {
    50.0
}

type Aabb = (Vec3, Vec3);

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
    /// How surfaces are shaded (the 3D stage is toon; object layers pick their finish).
    pub finish: Finish,
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

/// Surface finish of a 3D object layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Finish {
    /// Flat cartoon bands with an ink outline (the stage look).
    Toon,
    /// Glossy plastic: soft diffuse, crisp highlight, rim light (app icons, toys, 3D emoji).
    #[default]
    Glossy,
    /// Glass: tinted, bright fresnel edges, strong highlights.
    Glass,
    /// Chrome / polished metal: reflects a studio gradient (ribbons, logos, rings).
    Chrome,
    /// Soft matte clay.
    Matte,
}

/// Camera framing `solids` (seen from the front, `fov` degrees) so they fill the box.
pub fn frame_solids(solids: &[DrawSolid], fov: f32, aspect: f32) -> DrawCamera {
    let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for s in solids {
        let m = Mat4::from_cols_array_2d(&s.transform);
        let scale = m.x_axis.truncate().length().max(m.y_axis.truncate().length()).max(m.z_axis.truncate().length());
        let r = Vec3::splat(s.geometry.extent() * scale);
        let c = m.w_axis.truncate();
        lo = lo.min(c - r);
        hi = hi.max(c + r);
    }
    if lo.x > hi.x {
        (lo, hi) = (Vec3::splat(-1.0), Vec3::splat(1.0));
    }
    let target = (lo + hi) / 2.0;
    let radius = ((hi - lo).length() / 2.0).max(0.01);
    let half_v = fov.to_radians() / 2.0;
    let half_h = (half_v.tan() * aspect).atan();
    let dist = radius / half_v.min(half_h).sin() * 1.02;
    DrawCamera { kind: CameraKind::Perspective, eye: (target + Vec3::Z * dist).into(), target: target.into(), fov, ortho: radius }
}

impl Stage {
    pub fn draw(&self, t: f32, palette: &Palette, prefabs: &BTreeMap<String, Node3D>) -> DrawStage {
        let mut solids = Vec::new();
        let mut placed = Vec::new();
        let mut bounds: BTreeMap<String, Aabb> = BTreeMap::new();
        let others: BTreeMap<&str, [f32; 2]> = self.props.iter().map(|p| (p.id.as_str(), [p.x.sample(t - p.start), p.z.sample(t - p.start)])).collect();
        let props = self
            .props
            .iter()
            .filter(|p| t >= p.start && p.end.is_none_or(|e| t < e))
            .filter_map(|p| {
                let lt = t - p.start;
                let k = ((lt - p.enter_delay) / ENTER_TIME).clamp(0.0, 1.0);
                let s = p.scale.sample(lt);
                let beat = run_beats(p, lt, &others);
                let mut pos = beat.pos;
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
                let rotation = beat.yaw.unwrap_or_else(|| p.rotation.sample(lt).to_radians());
                // Procedural props: flatten their tree here; the engine only sees solids.
                let tree = p.node.clone().or_else(|| p.prefab.as_ref().map(|name| Node3D { kind: crate::NodeKind::Prefab { prefab: name.clone() }, scale: [1.0; 3], ..Default::default() }));
                if let Some(tree) = tree {
                    let base = Mat4::from_scale_rotation_translation(Vec3::from(scale), Quat::from_rotation_y(rotation), Vec3::from(pos));
                    let action = beat.action.or_else(|| p.action.as_deref().and_then(|a| serde_json::from_value::<Action>(serde_json::Value::String(a.to_owned())).ok()));
                    let ctx = NodeCtx { palette, prefabs, time: lt, action };
                    let tint = p.tint.map_or(palette.surface, |c| c.resolve(palette));
                    let first = solids.len();
                    tree.flatten(base, tint, &ctx, &mut solids, &mut placed, 0);
                    if let Some(b) = solids_bounds(&solids[first..]) {
                        bounds.insert(p.id.clone(), b);
                    }
                    return None;
                }
                // glTF props: approximate as a person-sized box at their position.
                let at = Vec3::from(pos);
                bounds.insert(p.id.clone(), (at - Vec3::new(0.4, 0.0, 0.4) * scale[0], at + Vec3::new(0.4, 0.9, 0.4) * scale[1]));
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
        let camera = self.camera_at(t, &bounds);
        DrawStage {
            camera,
            finish: Finish::Toon,
            props,
            solids,
            placed,
            floor: self.floor.map(|f| f.resolve(palette)),
            ink: palette.text,
            background: palette.background,
        }
    }
}

impl Stage {
    fn keyframed_camera(&self, t: f32) -> DrawCamera {
        let c = &self.camera;
        let (yaw, pitch) = (c.yaw.sample(t).to_radians(), c.pitch.sample(t).to_radians());
        let d = c.distance.sample(t).max(0.1);
        let target = [c.target_x.sample(t), c.target_y.sample(t), c.target_z.sample(t)];
        DrawCamera { kind: c.kind, eye: orbit_eye(Vec3::from(target), yaw, pitch, d).to_array(), target, fov: c.fov, ortho: d }
    }

    /// Camera from the shot list at `t` (falls back to the keyframed camera).
    fn camera_at(&self, t: f32, bounds: &BTreeMap<String, Aabb>) -> DrawCamera {
        let Some(i) = self.shots.iter().rposition(|s| t >= s.start) else {
            return self.keyframed_camera(t);
        };
        let shot = &self.shots[i];
        let cam = self.shot_camera(shot, t.min(shot.end), bounds);
        if shot.blend > 0.0 && i > 0 && t < shot.start + shot.blend {
            let prev = self.shot_camera(&self.shots[i - 1], shot.start, bounds);
            let k = Easing::EaseInOut.apply((t - shot.start) / shot.blend);
            let lerp = |a: [f32; 3], b: [f32; 3]| std::array::from_fn(|j| a[j] + (b[j] - a[j]) * k);
            return DrawCamera { eye: lerp(prev.eye, cam.eye), target: lerp(prev.target, cam.target), ortho: prev.ortho + (cam.ortho - prev.ortho) * k, ..cam };
        }
        cam
    }

    fn shot_camera(&self, s: &Shot, t: f32, bounds: &BTreeMap<String, Aabb>) -> DrawCamera {
        let u = s.ease.apply(((t - s.start) / (s.end - s.start).max(0.01)).clamp(0.0, 1.0));
        let all = || bounds.values().copied().reduce(|a, b| (a.0.min(b.0), a.1.max(b.1)));
        let aabb = match &s.target {
            ShotTarget::Point(p) => Some((Vec3::from(*p) - Vec3::splat(0.5), Vec3::from(*p) + Vec3::splat(0.5))),
            ShotTarget::Named(n) if n == SHOT_ALL => all(),
            ShotTarget::Named(n) => bounds.get(n).copied().or_else(all),
        }
        .unwrap_or((Vec3::new(-1.0, 0.0, -1.0), Vec3::new(1.0, 1.6, 1.0)));
        let center = (aabb.0 + aabb.1) * 0.5;
        let radius = ((aabb.1 - aabb.0).length() * 0.5).max(0.5);
        let fov = self.camera.fov.to_radians();
        // Bounds come from piece centers, so give the subject some air.
        let fit = radius / (fov * 0.5).sin() * s.framing * 1.3;
        let (mut yaw, mut pitch, mut d) = (s.yaw, s.pitch, fit);
        match s.kind {
            ShotKind::Static | ShotKind::Follow => {}
            ShotKind::Orbit => yaw += s.sweep * u,
            ShotKind::PushIn => d *= 1.35 - 0.5 * u,
            ShotKind::PullOut => d *= 0.85 + 0.5 * u,
            ShotKind::Crane => {
                pitch = 6.0 + (s.pitch + 24.0 - 6.0) * u;
                d *= 1.1 - 0.15 * u;
            }
            ShotKind::Reveal => {
                d *= 0.45 + 0.75 * u;
                pitch = 8.0 + (s.pitch - 8.0) * u;
            }
        }
        let kind = s.kind_camera.unwrap_or(self.camera.kind);
        DrawCamera {
            kind,
            eye: orbit_eye(center, yaw.to_radians(), pitch.to_radians(), d).to_array(),
            target: center.to_array(),
            fov: self.camera.fov,
            ortho: radius * s.framing * 1.15,
        }
    }
}

fn orbit_eye(target: Vec3, yaw: f32, pitch: f32, d: f32) -> Vec3 {
    target + Vec3::new(d * pitch.cos() * yaw.sin(), d * pitch.sin(), d * pitch.cos() * yaw.cos())
}

/// Box around a prop's pieces (their centers, padded by a typical piece size).
fn solids_bounds(solids: &[DrawSolid]) -> Option<Aabb> {
    let pts = solids.iter().map(|s| Mat4::from_cols_array_2d(&s.transform).w_axis.truncate());
    let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    let mut any = false;
    for p in pts {
        lo = lo.min(p);
        hi = hi.max(p);
        any = true;
    }
    any.then(|| (lo - Vec3::splat(0.2), hi + Vec3::splat(0.2)))
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
    fn shots_frame_their_target_and_cut_or_blend() {
        let stage: Stage = serde_json::from_str(
            r#"{"props":[{"id":"box","node":{"shape":"box","size":[1,1,1],"position":[3,0.5,0]}}],
                "shots":[{"start":0,"end":2,"kind":"orbit","target":"box"},
                         {"start":2,"end":4,"kind":"push_in","target":[0,0,0],"blend":0.5}]}"#,
        )
        .unwrap();
        let p = crate::StylePreset::Clean.palette();
        let none = BTreeMap::new();
        let a = stage.draw(0.0, &p, &none).camera;
        assert!((a.target[0] - 3.0).abs() < 0.2, "orbit looks at the box: {:?}", a.target);
        let b = stage.draw(1.0, &p, &none).camera;
        assert_ne!(a.eye, b.eye, "orbit moves");
        let mid_blend = stage.draw(2.25, &p, &none).camera;
        assert!(mid_blend.target[0] > 0.1 && mid_blend.target[0] < 2.9, "blending between targets");
        let after = stage.draw(3.0, &p, &none).camera;
        assert!(after.target[0].abs() < 1e-4);
    }

    #[test]
    fn beats_walk_then_sit() {
        let stage: Stage = serde_json::from_str(
            r#"{"props":[{"id":"silla","node":{"shape":"box","size":[0.5,0.5,0.5]},"x":2,"z":0},
                {"id":"paciente","node":{"rig":{}},"beats":[{"at":1,"duration":2,"sit_on":"silla","seat_height":0.45}]}]}"#,
        )
        .unwrap();
        let none = BTreeMap::new();
        let others: BTreeMap<&str, [f32; 2]> = [("silla", [2.0, 0.0])].into();
        let p = &stage.props[1];
        let mid = run_beats(p, 2.0, &others);
        assert_eq!(mid.action, Some(Action::Walk));
        assert!((mid.pos[0] - 1.0).abs() < 1e-4);
        let end = run_beats(p, 4.0, &others);
        assert_eq!(end.action, Some(Action::Sit));
        assert!((end.pos[0] - 2.0).abs() < 1e-4 && (end.pos[1] - 0.45).abs() < 1e-4);
        let _ = stage.draw(2.0, &crate::StylePreset::Clean.palette(), &none);
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
