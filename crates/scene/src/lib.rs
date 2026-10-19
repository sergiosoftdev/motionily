//! Scene model shared by the engine, the editor and the agent.
//!
//! The scene is the single source of truth. Nobody edits it directly: the
//! agent (through MCP) and the user (through the editor) both send [`Op`]s,
//! which are validated and applied here. That keeps one code path for every
//! change and makes undo, sync and feedback trivial.

mod anim;
pub mod expr;
pub mod paint;
pub mod path;
mod character;
mod scenario;
mod stage;
mod stage_presets;
mod layer;
mod library;
mod node3d;
mod ops;
mod style;
mod text;
mod transition;

pub use anim::{Animated, Easing, Keyframe};
pub use layer::{Xform, PathData, AnimRef, Bounds, DrawImage, DrawItem, DrawShape, EvalCtx, ImageFit, Layer, LayerContent, Shape};
pub use library::{AnimProp, AnimTemplate, Library, TemplateKey, TransitionKind, TransitionTemplate};
pub use text::{AudioTrack, Captions, DrawText, TextAlign, TextRole, TextSpan, Typography, Word};
pub use transition::TransitionRef;
pub use character::{draw_character, pose, Action, CharacterKind, CharacterSpec, Hair, Outfit, Pose};
pub use node3d::{DrawModelNode, DrawSolid, Garment, Geometry, HairStyle, Node3D, NodeKind, Repeat, Rig};
pub use stage_presets::{merge_preset, preset as stage_preset};
pub use stage::{Shot, ShotKind, ShotTarget, Camera3D, CameraKind, DrawCamera, DrawProp, DrawStage, PropEnter, Stage, StageProp};
pub use scenario::{draw_scenario, iso, DrawPoly, Scenario, ScenarioKind};
pub use ops::{Op, OpError, Prop};
pub use style::{RenderKind, RenderStyle, CaptionStyle, ColorRef, CustomPalette, HexColor, Palette, PaletteSlot, Rgba, StylePreset};

use serde::{Deserialize, Serialize};
use std::fmt::Write;

/// Parent chains deeper than this are cut (and cycles end there).
const MAX_PARENT_DEPTH: u8 = 8;

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
    /// 3D stage (camera + glTF props) drawn behind every layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<Stage>,
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
    /// Sound effects placed on the timeline (from the user's sound library).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sfx: Vec<SfxCue>,
}

fn scene_version() -> u32 {
    SCENE_VERSION
}

/// One sound effect at a moment of the video. The editor plays and exports it; the engine only keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SfxCue {
    pub id: String,
    /// Library sound name (for people and agents).
    pub sound: String,
    /// Media path of its WAV.
    pub src: String,
    /// Seconds from the start of the video.
    pub at: f32,
    #[serde(default = "unit_gain")]
    pub gain: f32,
}

fn unit_gain() -> f32 {
    1.0
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
            stage: None,
            scenario: None,
            render_style: None,
            audio: None,
            captions: None,
            transitions: Vec::new(),
            sfx: Vec::new(),
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
        let mut items: Vec<DrawItem> = self.stage.iter().map(|s| DrawItem::Stage(s.draw(t, &palette, &self.library.prefabs))).collect();
        items.extend(self
            .scenario
            .filter(|_| self.stage.is_none())
            .map(|s| draw_scenario(&s, ctx.scene_size, t, &palette))
            .unwrap_or_default());
        expr::set_scene_time(t);
        for l in self.layers.iter().filter(|l| l.visible && self.active(l, t)) {
            let mut drawn = self.layer_items(l, t, &ctx);
            if drawn.is_empty() {
                continue;
            }
            let needs_fx = !l.effects.is_empty() || l.blend != paint::BlendMode::Normal || l.matte.is_some();
            if needs_fx {
                let lt = t - l.start;
                let matte = l.matte.as_ref().and_then(|m| {
                    let src = self.layers.iter().find(|x| x.id == m.layer)?;
                    Some((if self.active(src, t) { self.layer_items(src, t, &ctx) } else { Vec::new() }, m.mode))
                });
                items.push(DrawItem::Fx(Box::new(paint::DrawFx {
                    items: std::mem::take(&mut drawn),
                    effects: l.effects.iter().map(|e| e.resolve(lt, &palette)).collect(),
                    blend: l.blend,
                    matte,
                })));
            } else {
                items.append(&mut drawn);
            }
        }
        items.extend(text::caption_frame(self, &palette, t).map(DrawItem::Text));
        transition::apply(self, &palette, t, &mut items);
        items
    }

    fn active(&self, l: &Layer, t: f32) -> bool {
        t >= l.start && t < l.end.unwrap_or(self.duration)
    }

    /// World transform a layer's `parent` chain gives it at scene time `t`.
    fn parent_xform(&self, l: &Layer, t: f32, ctx: &EvalCtx, depth: u8) -> Xform {
        let Some(pid) = &l.parent else { return Xform::default() };
        let Some(p) = self.layers.iter().find(|x| &x.id == pid) else { return Xform::default() };
        if depth > MAX_PARENT_DEPTH || p.id == l.id {
            return Xform::default();
        }
        let up = self.parent_xform(p, t, ctx, depth + 1);
        p.world(t - p.start, ctx, &up)
    }

    /// One layer's draw items at scene time `t`: all its repeater copies, inside its parent chain.
    fn layer_items(&self, l: &Layer, t: f32, ctx: &EvalCtx) -> Vec<DrawItem> {
        let lt = t - l.start;
        let base = self.parent_xform(l, t, ctx, 0);
        let Some(rep) = &l.repeat else {
            return expr::with_vars(t, 0.0, 1.0, || l.draw_in(lt, ctx, &base)).into_iter().collect();
        };
        let n = rep.count.min(paint::MAX_REPEAT);
        (0..n)
            .filter_map(|i| {
                let lt_i = lt - rep.delay * i as f32;
                if lt_i < 0.0 {
                    return None;
                }
                let (col, row) = rep.columns.filter(|c| *c > 0).map_or((i as f32, i as f32), |c| ((i % c) as f32, (i / c) as f32));
                let offset = if rep.columns.is_some() { [col * rep.x, row * rep.y] } else { [i as f32 * rep.x, i as f32 * rep.y] };
                let xf = Xform {
                    offset,
                    spin: (rep.rotation * i as f32).to_radians(),
                    grow: rep.scale.powi(i as i32),
                    opacity: base.opacity * rep.opacity.powi(i as i32),
                    ..base
                };
                expr::with_vars(t, i as f32, n as f32, || l.draw_in(lt_i, ctx, &xf))
            })
            .collect()
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

    /// Image sources the layers use (for the host to load).
    pub fn image_sources(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .layers
            .iter()
            .filter_map(|l| match &l.content {
                LayerContent::Image { src, .. } => Some(src.clone()),
                _ => None,
            })
            .collect();
        v.sort();
        v.dedup();
        v
    }

    /// One layer as JSON, for agents that only need to touch that object.
    pub fn layer_json(&self, id: &str) -> Option<String> {
        self.layer(id).map(|l| serde_json::to_string(l).expect("layer always serializes"))
    }

    /// Compact, token-cheap description for agents. One line per layer.
    pub fn summary(&self) -> String {
        let mut s = format!(
            "{}x{} {}fps {}s palette={} captions={} layers={} sfx={}\n",
            self.width,
            self.height,
            self.fps,
            self.duration,
            if self.palette.is_some() { "brick".to_owned() } else { enum_name(&self.style) },
            enum_name(&self.caption_style),
            self.layers.len(),
            self.sfx.iter().map(|c| format!("{}@{:.2}", c.sound, c.at)).collect::<Vec<_>>().join(",")
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
            let anchor = l.anchor.as_ref().map(|a| format!(" anchor={a}")).unwrap_or_default()
                + &l.group.as_ref().map(|g| format!(" group={g}")).unwrap_or_default();
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
        if let Some(st) = &self.stage {
            let props: Vec<String> = st
                .props
                .iter()
                .map(|p| {
                    let what = p.prefab.clone().map(|n| format!("prefab:{n}")).unwrap_or_else(|| if p.node.is_some() { "node".into() } else { p.model.clone() });
                    format!("{}={}{}", p.id, what, p.action.as_ref().map(|a| format!(":{a}")).unwrap_or_default())
                })
                .collect();
            let _ = writeln!(s, "stage: camera={} props=[{}]", enum_name(&st.camera.kind), props.join(", "));
            for sh in &st.shots {
                let _ = writeln!(s, "shot {:.1}-{:.1}s {} -> {}", sh.start, sh.end, enum_name(&sh.kind), serde_json::to_string(&sh.target).unwrap_or_default());
            }
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
    fn sfx_cues_replace_by_id_and_stay_sorted() {
        let mut scene = Scene::default();
        let cue = |id: &str, at: f32| Op::PutSfx { cue: SfxCue { id: id.into(), sound: "pop".into(), src: "/media/x.wav".into(), at, gain: 1.0 } };
        scene.apply(&[cue("a", 2.0), cue("b", 1.0), cue("a", 0.5)]).unwrap();
        assert_eq!(scene.sfx.iter().map(|c| (c.id.as_str(), c.at)).collect::<Vec<_>>(), [("a", 0.5), ("b", 1.0)]);
        assert!(scene.summary().contains("sfx=pop@0.50,pop@1.00"));
    }

    #[test]
    fn layers_outside_their_range_are_hidden() {
        let mut scene = Scene::default();
        scene.layers.push(serde_json::from_str(r#"{"id":"a","type":"shape","shape":"rect","start":1,"end":2,"w":10,"h":10}"#).unwrap());
        assert!(scene.frame(0.5).is_empty());
        assert_eq!(scene.frame(1.5).len(), 1);
        assert!(scene.frame(2.0).is_empty());
    }
}
