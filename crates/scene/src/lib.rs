//! Scene model shared by the engine, the editor and the agent.
//!
//! The scene is the single source of truth. Nobody edits it directly: the
//! agent (through MCP) and the user (through the editor) both send [`Op`]s,
//! which are validated and applied here. That keeps one code path for every
//! change and makes undo, sync and feedback trivial.

mod anim;
mod character;
mod scenario;
mod layer;
mod library;
mod ops;
mod style;
mod text;
mod transition;

pub use anim::{Animated, Easing, Keyframe};
pub use layer::{AnimRef, Bounds, DrawItem, DrawShape, EvalCtx, Layer, LayerContent, Shape};
pub use library::{AnimProp, AnimTemplate, Library, TemplateKey, TransitionKind, TransitionTemplate};
pub use text::{AudioTrack, Captions, DrawText, TextAlign, TextRole, TextSpan, Typography, Word};
pub use transition::TransitionRef;
pub use character::{draw_character, pose, Action, CharacterKind, CharacterSpec, Hair, Outfit, Pose};
pub use scenario::{draw_scenario, iso, DrawPoly, Scenario, ScenarioKind};
pub use ops::{Op, OpError, Prop};
pub use style::{RenderKind, RenderStyle, CaptionStyle, ColorRef, CustomPalette, HexColor, Palette, PaletteSlot, Rgba, StylePreset};

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
    /// Brick data the engine needs (animations, anchors, transitions). Filled by the editor.
    #[serde(default, skip_serializing_if = "Library::is_empty")]
    pub library: Library,
    /// Font from the typography brick. Missing: the engine's default font.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typography: Option<Typography>,
    /// Backdrop drawn behind every layer (scenario brick).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<Scenario>,
    /// Finish of the whole frame (render style brick).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_style: Option<RenderStyle>,
    /// Placement and trim of the project's audio file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioTrack>,
    /// Timed words, drawn in `caption_style`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captions: Option<Captions>,
    /// Cuts between scenes, each drawn with a transition brick.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transitions: Vec<TransitionRef>,
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
            library: Library::default(),
            typography: None,
            scenario: None,
            render_style: None,
            audio: None,
            captions: None,
            transitions: Vec::new(),
        }
    }
}

impl Scene {
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        let mut value: serde_json::Value = serde_json::from_str(json)?;
        layer::migrate(&mut value);
        serde_json::from_value(value)
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
    pub fn frame(&self, t: f32) -> Vec<DrawItem> {
        let palette = self.palette();
        let ctx = EvalCtx {
            palette: &palette,
            typography: self.typography.as_ref(),
            library: &self.library,
            scene_size: [self.width as f32, self.height as f32],
        };
        let mut items: Vec<DrawItem> = self
            .scenario
            .map(|s| draw_scenario(&s, ctx.scene_size, t, &palette))
            .unwrap_or_default();
        items.extend(
            self.layers
                .iter()
                .filter(|l| t >= l.start && t < l.end.unwrap_or(self.duration))
                .filter_map(|l| l.draw(t - l.start, &ctx)),
        );
        items.extend(text::caption_frame(self, &palette, t).map(DrawItem::Text));
        transition::apply(self, &palette, t, &mut items);
        items
    }

    /// Id of the top-most layer under scene point `(x, y)` at time `t`, for click-to-select.
    pub fn pick(&self, t: f32, x: f32, y: f32) -> Option<String> {
        let palette = self.palette();
        let ctx = EvalCtx {
            palette: &palette,
            typography: self.typography.as_ref(),
            library: &self.library,
            scene_size: [self.width as f32, self.height as f32],
        };
        self.layers
            .iter()
            .rev()
            .filter(|l| t >= l.start && t < l.end.unwrap_or(self.duration))
            .find(|l| l.bounds(t - l.start, &ctx).is_some_and(|b| b.contains([x, y])))
            .map(|l| l.id.clone())
    }

    /// On-screen box of a layer at time `t` (for the selection outline).
    pub fn layer_bounds(&self, id: &str, t: f32) -> Option<Bounds> {
        let palette = self.palette();
        let ctx = EvalCtx {
            palette: &palette,
            typography: self.typography.as_ref(),
            library: &self.library,
            scene_size: [self.width as f32, self.height as f32],
        };
        let l = self.layer(id)?;
        if t < l.start || t >= l.end.unwrap_or(self.duration) {
            return None;
        }
        l.bounds(t - l.start, &ctx)
    }

    /// One layer as JSON, for agents that only need to touch that object.
    pub fn layer_json(&self, id: &str) -> Option<String> {
        self.layer(id).map(|l| serde_json::to_string(l).expect("layer always serializes"))
    }

    /// Compact, token-cheap description for agents. One line per layer.
    pub fn summary(&self) -> String {
        let mut s = format!(
            "{}x{} {}fps {}s palette={} captions={} layers={}\n",
            self.width,
            self.height,
            self.fps,
            self.duration,
            if self.palette.is_some() { "brick".to_owned() } else { enum_name(&self.style) },
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
            let uses: Vec<String> = l.anims.iter().map(|a| format!("{}@{}", a.key.trim_start_matches("animation/"), a.at)).collect();
            let anchor = l.anchor.as_ref().map(|a| format!(" anchor={a}")).unwrap_or_default();
            let _ = writeln!(
                s,
                "- {} {} {:.2}-{:.2}s at ({:.0},{:.0}){} {:.0}x{:.0} fill={} keys=[{}] uses=[{}]",
                l.id,
                l.content.kind_name(),
                l.start,
                end,
                l.x.sample(0.0),
                l.y.sample(0.0),
                anchor,
                l.w.sample(0.0),
                l.h.sample(0.0),
                serde_json::to_string(&l.fill).unwrap_or_default().trim_matches('"'),
                animated.join(","),
                uses.join(",")
            );
        }
        if let Some(sc) = &self.scenario {
            let _ = writeln!(s, "scenario: {}", enum_name(&sc.kind));
        }
        if let Some(r) = &self.render_style {
            let _ = writeln!(s, "finish: {} x{}", enum_name(&r.kind), r.amount);
        }
        if let Some(a) = &self.audio {
            let out = a.trim_out.map(|o| format!("{o:.2}")).unwrap_or_else(|| "end".into());
            let _ = writeln!(s, "audio: plays from {:.2}s, file {:.2}-{}", a.start, a.trim_in, out);
        }
        if let Some(c) = &self.captions {
            let shown: Vec<&str> = c.words.iter().take(12).map(|w| w.text.as_str()).collect();
            let _ = writeln!(s, "captions: {} words \"{}…\" style={}", c.words.len(), shown.join(" "), enum_name(&self.caption_style));
        }
        for tr in &self.transitions {
            let _ = writeln!(s, "cut @{:.2}s {} {:.2}s", tr.at, tr.key.trim_start_matches("transition/"), tr.duration);
        }
        if !self.library.is_empty() {
            let _ = writeln!(
                s,
                "library: {} animations, {} transitions, anchors=[{}]",
                self.library.animations.len(),
                self.library.transitions.len(),
                self.library.anchors.keys().cloned().collect::<Vec<_>>().join(",")
            );
        }
        s
    }
}

pub(crate) fn enum_name<T: Serialize>(v: &T) -> String {
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
        assert!(scene.summary().contains("palette="));
    }

    #[test]
    fn old_layers_without_type_still_load() {
        let scene = Scene::from_json(r#"{"width":10,"height":10,"fps":30,"duration":1,
            "layers":[{"id":"a","shape":"ellipse","x":0,"y":0,"w":4,"h":4}]}"#)
        .unwrap();
        assert_eq!(scene.layers[0].content, LayerContent::Shape { shape: Shape::Ellipse });
    }

    #[test]
    fn layers_outside_their_range_are_hidden() {
        let mut scene = Scene::default();
        scene.layers.push(Layer {
            id: "a".into(),
            content: LayerContent::Shape { shape: Shape::Rect },
            start: 1.0,
            end: Some(2.0),
            fill: ColorRef::default(),
            anchor: None,
            x: 0.0.into(),
            y: 0.0.into(),
            w: 10.0.into(),
            h: 10.0.into(),
            scale: 1.0.into(),
            rotation: Animated::default(),
            opacity: 1.0.into(),
            radius: Animated::default(),
            anims: Vec::new(),
        });
        assert!(scene.frame(0.5).is_empty());
        assert_eq!(scene.frame(1.5).len(), 1);
        assert!(scene.frame(2.0).is_empty());
    }
}
