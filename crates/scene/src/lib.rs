//! Scene model shared by the engine, the editor and the agent.
//!
//! The scene is the single source of truth. Nobody edits it directly: the
//! agent (through MCP) and the user (through the editor) both send [`Op`]s,
//! which are validated and applied here. That keeps one code path for every
//! change and makes undo, sync and feedback trivial.

mod anim;
mod ops;
mod style;

pub use anim::{Animated, Easing, Keyframe};
pub use ops::{Op, OpError, Prop};
pub use style::{CaptionStyle, ColorRef, CustomPalette, HexColor, Palette, PaletteSlot, Rgba, StylePreset};

use serde::{Deserialize, Serialize};
use std::fmt::Write;

pub const SCENE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    #[serde(default = "scene_version")]
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    /// Seconds.
    pub duration: f32,
    #[serde(default)]
    pub style: StylePreset,
    #[serde(default)]
    pub caption_style: CaptionStyle,
    /// Colors from a palette brick. When set, it wins over `style`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<CustomPalette>,
    #[serde(default)]
    pub layers: Vec<Layer>,
}

fn scene_version() -> u32 {
    SCENE_VERSION
}

impl Default for Scene {
    /// Vertical 9:16, the format most short-form videos ship in.
    fn default() -> Self {
        Scene {
            version: SCENE_VERSION,
            width: 1080,
            height: 1920,
            fps: 30.0,
            duration: 6.0,
            style: StylePreset::default(),
            caption_style: CaptionStyle::default(),
            palette: None,
            layers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    Rect,
    Ellipse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub id: String,
    pub shape: Shape,
    /// Seconds. Keyframe times are relative to this.
    #[serde(default)]
    pub start: f32,
    /// Seconds. Defaults to the end of the scene.
    #[serde(default)]
    pub end: Option<f32>,
    #[serde(default)]
    pub fill: ColorRef,
    /// Center position in scene pixels.
    pub x: Animated,
    pub y: Animated,
    pub w: Animated,
    pub h: Animated,
    #[serde(default = "one")]
    pub scale: Animated,
    /// Degrees, clockwise.
    #[serde(default)]
    pub rotation: Animated,
    #[serde(default = "one")]
    pub opacity: Animated,
    /// Corner radius in pixels (rects only).
    #[serde(default)]
    pub radius: Animated,
}

fn one() -> Animated {
    Animated::Static(1.0)
}

/// One resolved shape for one frame, in scene pixels. This is all the renderer sees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawShape {
    pub center: [f32; 2],
    pub size: [f32; 2],
    pub radius: f32,
    pub rotation: f32,
    pub color: Rgba,
}

impl Scene {
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("scene always serializes")
    }

    pub fn palette(&self) -> Palette {
        self.palette.map(Palette::from).unwrap_or_else(|| self.style.palette())
    }

    pub fn layer(&self, id: &str) -> Option<&Layer> {
        self.layers.iter().find(|l| l.id == id)
    }

    pub fn layer_mut(&mut self, id: &str) -> Option<&mut Layer> {
        self.layers.iter_mut().find(|l| l.id == id)
    }

    /// Resolve every visible layer at time `t` (seconds), back to front.
    pub fn frame(&self, t: f32) -> Vec<DrawShape> {
        let palette = self.palette();
        self.layers
            .iter()
            .filter(|l| t >= l.start && t < l.end.unwrap_or(self.duration))
            .filter_map(|l| {
                let lt = t - l.start;
                let scale = l.scale.sample(lt);
                let mut color = l.fill.resolve(&palette);
                color.0[3] *= l.opacity.sample(lt).clamp(0.0, 1.0);
                if color.0[3] <= 0.0 {
                    return None;
                }
                let size = [l.w.sample(lt) * scale, l.h.sample(lt) * scale];
                let radius = match l.shape {
                    Shape::Ellipse => size[0].min(size[1]) / 2.0,
                    Shape::Rect => l.radius.sample(lt) * scale,
                };
                Some(DrawShape {
                    center: [l.x.sample(lt), l.y.sample(lt)],
                    size,
                    radius,
                    rotation: l.rotation.sample(lt).to_radians(),
                    color,
                })
            })
            .collect()
    }

    /// Compact, token-cheap description for agents. One line per layer.
    pub fn summary(&self) -> String {
        let mut s = format!(
            "{}x{} {}fps {}s style={} captions={} layers={}\n",
            self.width,
            self.height,
            self.fps,
            self.duration,
            enum_name(&self.style),
            enum_name(&self.caption_style),
            self.layers.len()
        );
        for l in &self.layers {
            let end = l.end.unwrap_or(self.duration);
            let animated: Vec<&str> = [
                ("x", &l.x),
                ("y", &l.y),
                ("w", &l.w),
                ("h", &l.h),
                ("scale", &l.scale),
                ("rotation", &l.rotation),
                ("opacity", &l.opacity),
                ("radius", &l.radius),
            ]
            .into_iter()
            .filter(|(_, a)| matches!(a, Animated::Keys(_)))
            .map(|(n, _)| n)
            .collect();
            let _ = writeln!(
                s,
                "- {} {} {:.2}-{:.2}s at ({:.0},{:.0}) {:.0}x{:.0} fill={} anim=[{}]",
                l.id,
                enum_name(&l.shape),
                l.start,
                end,
                l.x.sample(0.0),
                l.y.sample(0.0),
                l.w.sample(0.0),
                l.h.sample(0.0),
                serde_json::to_string(&l.fill).unwrap_or_default().trim_matches('"'),
                animated.join(",")
            );
        }
        s
    }
}

fn enum_name<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_default().trim_matches('"').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO: &str = include_str!("../../../examples/demo.scene.json");

    #[test]
    fn demo_scene_parses_and_renders() {
        let scene = Scene::from_json(DEMO).unwrap();
        assert!(!scene.frame(1.0).is_empty());
        assert!(scene.summary().contains("style="));
    }

    #[test]
    fn layers_outside_their_range_are_hidden() {
        let mut scene = Scene::default();
        scene.layers.push(Layer {
            id: "a".into(),
            shape: Shape::Rect,
            start: 1.0,
            end: Some(2.0),
            fill: ColorRef::default(),
            x: 0.0.into(),
            y: 0.0.into(),
            w: 10.0.into(),
            h: 10.0.into(),
            scale: one(),
            rotation: Animated::default(),
            opacity: one(),
            radius: Animated::default(),
        });
        assert!(scene.frame(0.5).is_empty());
        assert_eq!(scene.frame(1.5).len(), 1);
        assert!(scene.frame(2.0).is_empty());
    }
}
