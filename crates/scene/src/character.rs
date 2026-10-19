//! Procedural characters: a simple skeleton posed by an action clip and drawn
//! as capsules (no hands or feet, only the clothes change). Far-side limbs are
//! darker and drawn behind the body, which reads as depth (2.5D).

use crate::{ColorRef, DrawItem, DrawShape, Palette, Rgba};
use serde::{Deserialize, Serialize};
use std::f32::consts::{PI, TAU};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CharacterKind {
    StickmanPlain,
    StickmanOutfit,
    Blob,
    Chibi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outfit {
    #[default]
    Casual,
    Doctor,
    Office,
    Sport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    #[default]
    Idle,
    Walk,
    Wave,
    Point,
    Jump,
    Sit,
    Celebrate,
    /// Hands on the head, fidgeting: overwhelmed.
    Stressed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hair {
    #[default]
    None,
    Short,
    Long,
    Bun,
}

/// Character settings carried by a `character` layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CharacterSpec {
    pub character: CharacterKind,
    #[serde(default)]
    pub outfit: Outfit,
    #[serde(default)]
    pub action: Action,
    #[serde(default)]
    pub hair: Hair,
    #[serde(default = "default_hair_color")]
    pub hair_color: ColorRef,
    /// 1 faces right, -1 faces left.
    #[serde(default = "default_facing")]
    pub facing: f32,
}

fn default_hair_color() -> ColorRef {
    ColorRef::Slot(crate::PaletteSlot::Text)
}

fn default_facing() -> f32 {
    1.0
}

/// Joint angles (radians, 0 = pointing down) and body offsets for one instant.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Pose {
    pub hip_y: f32,
    pub lean: f32,
    pub head: f32,
    /// [upper, lower] for near arm, far arm, near leg, far leg.
    pub near_arm: [f32; 2],
    pub far_arm: [f32; 2],
    pub near_leg: [f32; 2],
    pub far_leg: [f32; 2],
    /// Vertical squash (1 = rest), used by blobs and landings.
    pub squash: f32,
}

/// Loopable pose for `action` at time `t` (seconds).
pub fn pose(action: Action, t: f32) -> Pose {
    let w = |hz: f32| (t * TAU * hz).sin();
    let rest = Pose { near_arm: [0.15, 0.1], far_arm: [-0.15, -0.1], near_leg: [0.05, 0.0], far_leg: [-0.05, 0.0], squash: 1.0, ..Default::default() };
    match action {
        Action::Idle => Pose { hip_y: w(0.5) * 0.008, head: w(0.25) * 0.05, near_arm: [0.15 + w(0.5) * 0.04, 0.1], ..rest },
        Action::Walk => {
            let s = w(1.6);
            Pose {
                hip_y: (t * TAU * 3.2).sin().abs() * -0.02,
                lean: 0.06,
                near_arm: [-s * 0.6, -0.25],
                far_arm: [s * 0.6, -0.25],
                near_leg: [s * 0.55, (s.max(0.0)) * 0.6],
                far_leg: [-s * 0.55, ((-s).max(0.0)) * 0.6],
                ..rest
            }
        }
        Action::Wave => Pose { near_arm: [PI * 0.85, 0.5 + w(2.0) * 0.5], head: 0.08, ..rest },
        Action::Point => Pose { near_arm: [PI * 0.5, 0.0], lean: 0.05, head: 0.05, ..rest },
        Action::Jump => {
            let phase = (t * 1.2).fract();
            let air = (phase * PI).sin();
            Pose {
                hip_y: -air * 0.25,
                near_arm: [PI * 0.9 * air, 0.2],
                far_arm: [-PI * 0.9 * air, -0.2],
                near_leg: [0.2 * air, 0.5 * air],
                far_leg: [-0.1 * air, 0.5 * air],
                squash: if phase < 0.08 || phase > 0.92 { 0.88 } else { 1.0 + air * 0.05 },
                ..rest
            }
        }
        Action::Sit => Pose { hip_y: 0.2, near_leg: [PI * 0.5, -PI * 0.5], far_leg: [PI * 0.45, -PI * 0.45], near_arm: [0.4, -0.6], far_arm: [0.3, -0.6], ..rest },
        Action::Stressed => Pose {
            hip_y: (t * TAU * 3.0).sin().abs() * -0.006,
            lean: 0.12 + w(1.5) * 0.03,
            head: -0.1 + w(3.0) * 0.06,
            near_arm: [PI * 0.82 + w(3.0) * 0.08, -2.2],
            far_arm: [PI * 0.82 - w(3.0) * 0.08, -2.2],
            near_leg: [0.05 + w(1.5) * 0.04, 0.0],
            far_leg: [-0.05, 0.0],
            squash: 1.0,
        },
        Action::Celebrate => Pose {
            hip_y: -w(2.0).abs() * 0.05,
            near_arm: [PI * 0.8 + w(2.0) * 0.15, 0.2],
            far_arm: [-PI * 0.8 - w(2.0) * 0.15, -0.2],
            head: w(1.0) * 0.1,
            ..rest
        },
    }
}

struct Outfit3 {
    top: Rgba,
    bottom: Rgba,
    /// Small detail drawn on the chest (doctor cross, office tie…).
    detail: Option<Rgba>,
}

fn outfit_colors(spec: &CharacterSpec, p: &Palette) -> Outfit3 {
    match (spec.character, spec.outfit) {
        (CharacterKind::StickmanPlain, _) => Outfit3 { top: p.text, bottom: p.text, detail: None },
        (_, Outfit::Casual) => Outfit3 { top: p.primary, bottom: p.text, detail: None },
        (_, Outfit::Doctor) => Outfit3 { top: p.surface, bottom: p.accent, detail: Some(p.primary) },
        (_, Outfit::Office) => Outfit3 { top: p.text, bottom: p.text, detail: Some(p.accent) },
        (_, Outfit::Sport) => Outfit3 { top: p.accent, bottom: p.primary, detail: None },
    }
}

fn darker(c: Rgba, k: f32) -> Rgba {
    Rgba([c.0[0] * k, c.0[1] * k, c.0[2] * k, c.0[3]])
}

fn alpha(c: Rgba, a: f32) -> Rgba {
    Rgba([c.0[0], c.0[1], c.0[2], c.0[3] * a])
}

/// Capsule between two points.
fn bone(a: [f32; 2], b: [f32; 2], thick: f32, color: Rgba) -> DrawItem {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = (dx * dx + dy * dy).sqrt();
    DrawItem::Shape(DrawShape {
        center: [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0],
        size: [len + thick, thick],
        radius: thick / 2.0,
        rotation: dy.atan2(dx),
        color, style: Default::default(),
    })
}

fn blob(center: [f32; 2], size: [f32; 2], color: Rgba) -> DrawItem {
    DrawItem::Shape(DrawShape { center, size, radius: size[0].min(size[1]) / 2.0, rotation: 0.0, color, style: Default::default() })
}

fn limb(from: [f32; 2], angles: [f32; 2], lens: [f32; 2], facing: f32) -> ([f32; 2], [f32; 2]) {
    // Angle 0 points down; positive swings towards where the character faces.
    let dir = |a: f32| [a.sin() * facing, a.cos()];
    let d1 = dir(angles[0]);
    let mid = [from[0] + d1[0] * lens[0], from[1] + d1[1] * lens[0]];
    let d2 = dir(angles[0] + angles[1]);
    (mid, [mid[0] + d2[0] * lens[1], mid[1] + d2[1] * lens[1]])
}

/// Warm skin tone for characters with faces (chibi); stickmen stay ink-colored.
const SKIN: Rgba = Rgba([0.96, 0.8, 0.68, 1.0]);

/// Draw a character standing on `feet` (bottom center), `height` px tall, at time `t`.
pub fn draw_character(spec: &CharacterSpec, feet: [f32; 2], height: f32, t: f32, opacity: f32, p: &Palette) -> Vec<DrawItem> {
    let pose = pose(spec.action, t);
    let f = if spec.facing < 0.0 { -1.0 } else { 1.0 };
    let o = outfit_colors(spec, p);
    let has_face = spec.character == CharacterKind::Chibi;
    let skin = alpha(if has_face { SKIN } else { p.text }, opacity);
    let mut out = Vec::new();

    if spec.character == CharacterKind::Blob {
        let sq = pose.squash * (1.0 + (t * TAU * 0.5).sin() * 0.03);
        let (w, h) = (height * 0.8 / sq.sqrt(), height * sq);
        let c = [feet[0], feet[1] - h / 2.0 + pose.hip_y * height];
        out.push(blob([feet[0], feet[1]], [w * 0.9, height * 0.08], alpha(darker(p.background, 0.8), opacity * 0.6)));
        out.push(blob(c, [w, h], alpha(o.top, opacity)));
        for side in [-1.0, 1.0] {
            let eye = [c[0] + (side * 0.16 + 0.06 * f) * w, c[1] - h * 0.12];
            out.push(blob(eye, [w * 0.2, w * 0.24], alpha(p.surface, opacity)));
            out.push(blob([eye[0] + 0.03 * w * f, eye[1]], [w * 0.09, w * 0.11], skin));
        }
        return out;
    }

    let chibi = spec.character == CharacterKind::Chibi;
    let unit = height;
    let head_r = unit * if chibi { 0.22 } else { 0.11 };
    let thick = unit * if chibi { 0.08 } else { 0.055 };
    let (leg_len, arm_len, torso_len) = if chibi { ([0.12, 0.1], [0.11, 0.09], 0.2) } else { ([0.22, 0.21], [0.17, 0.16], 0.3) };
    let hip = [feet[0], feet[1] - (leg_len[0] + leg_len[1]) * unit + pose.hip_y * unit];
    let neck = [hip[0] + pose.lean.sin() * torso_len * unit * f, hip[1] - torso_len * unit * pose.lean.cos()];
    let shoulder = [neck[0], neck[1] + thick * 0.6];
    let head = [neck[0] + pose.head.sin() * head_r * 0.3 * f, neck[1] - head_r * 0.95];
    let lens = |l: [f32; 2]| [l[0] * unit, l[1] * unit];

    // Shadow on the floor.
    out.push(blob([feet[0], feet[1]], [unit * 0.32, unit * 0.04], alpha(darker(p.background, 0.75), opacity * 0.5)));

    // Far side first (behind the body), slightly darker.
    let far_k = 0.78;
    let (fk, ff) = limb(hip, pose.far_leg, lens(leg_len), f);
    out.push(bone(hip, fk, thick, alpha(darker(o.bottom, far_k), opacity)));
    out.push(bone(fk, ff, thick, alpha(darker(o.bottom, far_k), opacity)));
    let (fe, fh) = limb(shoulder, pose.far_arm, lens(arm_len), f);
    out.push(bone(shoulder, fe, thick * 0.9, alpha(darker(o.top, far_k), opacity)));
    out.push(bone(fe, fh, thick * 0.9, alpha(darker(skin, 1.0), opacity)));

    // Body.
    out.push(bone(hip, neck, thick * 1.9, alpha(o.top, opacity)));
    if let Some(d) = o.detail {
        let mid = [(hip[0] + neck[0]) / 2.0, neck[1] + (hip[1] - neck[1]) * 0.35];
        out.push(blob(mid, [thick * 0.5, thick * 0.5], alpha(d, opacity)));
    }

    // Near side.
    let (nk, nf) = limb(hip, pose.near_leg, lens(leg_len), f);
    out.push(bone(hip, nk, thick, alpha(o.bottom, opacity)));
    out.push(bone(nk, nf, thick, alpha(o.bottom, opacity)));

    // Head and hair.
    let hair = alpha(spec.hair_color.resolve(p), opacity);
    let hair_style = if chibi && spec.hair == Hair::None { Hair::Short } else { spec.hair };
    if hair_style == Hair::Long {
        out.push(DrawItem::Shape(DrawShape { center: [head[0] - head_r * 0.25 * f, head[1] + head_r * 0.35], size: [head_r * 2.1, head_r * 2.4], radius: head_r, rotation: 0.0, color: hair, style: Default::default() }));
    }
    out.push(blob(head, [head_r * 2.0, head_r * 2.0], skin));
    match hair_style {
        Hair::None => {}
        Hair::Short | Hair::Long => {
            out.push(DrawItem::Shape(DrawShape { center: [head[0] - head_r * 0.1 * f, head[1] - head_r * 0.55], size: [head_r * 2.15, head_r * 1.05], radius: head_r * 0.52, rotation: -0.12 * f, color: hair, style: Default::default() }));
        }
        Hair::Bun => {
            out.push(DrawItem::Shape(DrawShape { center: [head[0], head[1] - head_r * 0.6], size: [head_r * 2.05, head_r * 0.95], radius: head_r * 0.47, rotation: 0.0, color: hair, style: Default::default() }));
            out.push(blob([head[0] - head_r * 0.7 * f, head[1] - head_r * 0.95], [head_r * 0.9, head_r * 0.9], hair));
        }
    }
    if chibi {
        // Big anime eyes with a highlight, and a small blush.
        for side in [-0.38, 0.38] {
            let eye = [head[0] + (side + 0.22 * f) * head_r, head[1] + head_r * 0.12];
            out.push(blob(eye, [head_r * 0.26, head_r * 0.4], alpha(p.text, opacity)));
            out.push(blob([eye[0] + head_r * 0.05, eye[1] - head_r * 0.1], [head_r * 0.1, head_r * 0.12], alpha(p.surface, opacity)));
            out.push(blob([eye[0], eye[1] + head_r * 0.32], [head_r * 0.22, head_r * 0.08], alpha(darker(p.accent, 1.0), opacity * 0.45)));
        }
    }

    let (ne, nh) = limb(shoulder, pose.near_arm, lens(arm_len), f);
    out.push(bone(shoulder, ne, thick * 0.9, alpha(o.top, opacity)));
    out.push(bone(ne, nh, thick * 0.9, skin));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_loops_without_jumps() {
        for a in [Action::Idle, Action::Walk, Action::Wave, Action::Celebrate] {
            let (p0, p1) = (pose(a, 0.0), pose(a, 10.0));
            assert!((p0.near_arm[0] - p1.near_arm[0]).abs() < 0.05, "{a:?} should loop");
        }
    }

    #[test]
    fn characters_stand_on_their_feet() {
        let spec = CharacterSpec {
            character: CharacterKind::StickmanOutfit,
            outfit: Outfit::Doctor,
            action: Action::Idle,
            hair: Hair::Short,
            hair_color: default_hair_color(),
            facing: 1.0,
        };
        let items = draw_character(&spec, [500.0, 1000.0], 400.0, 0.0, 1.0, &crate::StylePreset::Clean.palette());
        let lowest = items
            .iter()
            .filter_map(|i| match i {
                DrawItem::Shape(s) => Some(s.center[1] + s.size[1].min(s.size[0]) / 2.0),
                _ => None,
            })
            .fold(0.0, f32::max);
        assert!((lowest - 1000.0).abs() < 40.0, "feet near the ground, got {lowest}");
        assert!(items.len() > 10);
    }
}
