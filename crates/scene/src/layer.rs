//! Layers and what they resolve to for one frame.
//!
//! A layer is common timing + transform fields plus a `content` that says what
//! it is. New kinds of content (text, characters, 3D…) are new variants of
//! [`LayerContent`] and [`DrawItem`]; the renderer draws each `DrawItem` kind
//! with its own pipeline, keeping layer order.

use crate::text::{DrawText, TextAlign, TextRole, TextSpan, Typography, DEFAULT_FAMILY};
use crate::{draw_character, AnimProp, Animated, CharacterSpec, ColorRef, DrawPoly, Library, Palette, Rgba};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    Rect,
    Ellipse,
}

/// What a layer is. Serialized inline with a `type` tag: `{"type":"shape","shape":"rect",…}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LayerContent {
    Shape { shape: Shape },
    /// Text wrapped to the layer's `w`, in the typography brick's font. `size` is in scene pixels.
    Text {
        text: String,
        size: f32,
        #[serde(default)]
        role: TextRole,
        #[serde(default)]
        align: TextAlign,
        #[serde(default = "default_line_height")]
        line_height: f32,
    },
    /// A picture (brand logo, product screenshot…) by URL/key, fitted into the layer box.
    Image {
        src: String,
        #[serde(default)]
        fit: ImageFit,
    },
    /// Procedural character standing at the bottom of its box (`h` is its height).
    Character {
        #[serde(flatten)]
        spec: CharacterSpec,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFit {
    /// Fill the box, cropping the overflow.
    #[default]
    Cover,
    /// Show the whole image inside the box.
    Contain,
}

/// One image for one frame. The engine crops/fits it once it knows the pixel size.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawImage {
    pub src: String,
    pub fit: ImageFit,
    pub center: [f32; 2],
    pub size: [f32; 2],
    pub radius: f32,
    pub rotation: f32,
    pub opacity: f32,
}

fn default_line_height() -> f32 {
    1.15
}

impl LayerContent {
    /// Short name for summaries.
    pub fn kind_name(&self) -> String {
        match self {
            LayerContent::Shape { shape } => crate::enum_name(shape),
            LayerContent::Text { text, .. } => format!("text \"{}\"", text.chars().take(40).collect::<String>()),
            LayerContent::Image { src, .. } => format!("image {}", src.rsplit('/').next().unwrap_or(src)),
            LayerContent::Character { spec } => format!(
                "character {}/{}/{} hair={}",
                crate::enum_name(&spec.character),
                crate::enum_name(&spec.outfit),
                crate::enum_name(&spec.action),
                crate::enum_name(&spec.hair)
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub id: String,
    #[serde(flatten)]
    pub content: LayerContent,
    /// Seconds. Keyframe times are relative to this.
    #[serde(default)]
    pub start: f32,
    /// Seconds. Defaults to the end of the scene.
    #[serde(default)]
    pub end: Option<f32>,
    #[serde(default)]
    pub fill: ColorRef,
    /// Named point of the composition (e.g. "hero"). When set, `x`/`y` are offsets from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    /// Logical group ("dashboard", "cta"…): the user selects and edits it as one piece.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Center position in scene pixels (or offset from `anchor`).
    #[serde(default)]
    pub x: Animated,
    #[serde(default)]
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
    /// Animation bricks applied on top of the layer's own values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anims: Vec<AnimRef>,
}

/// `{"use":"animation/pop_in","at":0.2,"speed":1.5}`: play an animation brick on a layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnimRef {
    #[serde(rename = "use")]
    pub key: String,
    /// Seconds from the layer start.
    #[serde(default)]
    pub at: f32,
    #[serde(default = "unit")]
    pub speed: f32,
    /// Scales how far the animation moves away from rest (1 = as designed).
    #[serde(default = "unit")]
    pub intensity: f32,
}

fn unit() -> f32 {
    1.0
}

/// Scene-wide inputs every layer needs to resolve itself.
pub struct EvalCtx<'a> {
    pub palette: &'a Palette,
    pub typography: Option<&'a Typography>,
    pub library: &'a Library,
    pub scene_size: [f32; 2],
}

/// Accumulated effect of a layer's animation refs at one instant.
struct AnimOffsets {
    opacity: f32,
    scale: f32,
    dx: f32,
    dy: f32,
    rotation: f32,
}

fn one() -> Animated {
    Animated::Static(1.0)
}

/// One resolved shape for one frame, in scene pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawShape {
    pub center: [f32; 2],
    pub size: [f32; 2],
    pub radius: f32,
    pub rotation: f32,
    pub color: Rgba,
}

/// Everything the renderer needs for one layer at one instant. One variant per pipeline.
#[derive(Debug, Clone, PartialEq)]
pub enum DrawItem {
    Shape(DrawShape),
    Text(DrawText),
    Poly(DrawPoly),
    /// Several items from one layer (characters), drawn in order.
    Group(Vec<DrawItem>),
    Image(DrawImage),
    /// The 3D stage (always first, behind everything).
    Stage(crate::DrawStage),
}

impl Layer {
    /// Resolve this layer at layer-local time `lt`. `None` when fully transparent.
    pub fn draw(&self, lt: f32, ctx: &EvalCtx) -> Option<DrawItem> {
        self.resolve(lt, ctx, true)
    }

    /// `animated = false` gives the layer at rest (no animation bricks, never hidden):
    /// what selection outlines and hit-tests use, so an object is selectable mid-entrance.
    fn resolve(&self, lt: f32, ctx: &EvalCtx, animated: bool) -> Option<DrawItem> {
        let anim = if animated {
            self.anim_offsets(lt, ctx.library)
        } else {
            AnimOffsets { opacity: 1.0, scale: 1.0, dx: 0.0, dy: 0.0, rotation: 0.0 }
        };
        let scale = self.scale.sample(lt) * anim.scale;
        let mut color = self.fill.resolve(ctx.palette);
        color.0[3] *= (self.opacity.sample(lt) * anim.opacity).clamp(0.0, 1.0);
        if animated && color.0[3] <= 0.0 {
            return None;
        }
        let origin = self
            .anchor
            .as_ref()
            .and_then(|a| ctx.library.anchor(a))
            .map_or([0.0, 0.0], |[ax, ay]| [ax * ctx.scene_size[0], ay * ctx.scene_size[1]]);
        let center = [origin[0] + self.x.sample(lt) + anim.dx, origin[1] + self.y.sample(lt) + anim.dy];
        let size = [self.w.sample(lt) * scale, self.h.sample(lt) * scale];
        let rotation = (self.rotation.sample(lt) + anim.rotation).to_radians();
        match &self.content {
            LayerContent::Shape { shape } => {
                let radius = match shape {
                    Shape::Ellipse => size[0].min(size[1]) / 2.0,
                    Shape::Rect => self.radius.sample(lt) * scale,
                };
                Some(DrawItem::Shape(DrawShape { center, size, radius, rotation, color }))
            }
            LayerContent::Image { src, fit } => Some(DrawItem::Image(DrawImage {
                src: src.clone(),
                fit: *fit,
                center,
                size,
                radius: self.radius.sample(lt) * scale,
                rotation,
                opacity: color.0[3],
            })),
            LayerContent::Character { spec } => {
                let feet = [center[0], center[1] + size[1] / 2.0];
                Some(DrawItem::Group(draw_character(spec, feet, size[1], lt, color.0[3], ctx.palette)))
            }
            LayerContent::Text { text, size: px, role, align, line_height } => {
                let (family, weight) = ctx
                    .typography
                    .map_or((DEFAULT_FAMILY.to_owned(), 600), |t| (t.family.clone(), t.weight(*role)));
                Some(DrawItem::Text(DrawText {
                    spans: vec![TextSpan { text: text.clone(), color, scale: 1.0, highlight: None }],
                    size: px * scale,
                    family,
                    weight,
                    align: *align,
                    line_height: *line_height,
                    center,
                    max_width: fit_width(size[0], center[0], ctx.scene_size[0]),
                    max_height: Some(size[1].max(1.0)),
                    rotation,
                }))
            }
        }
    }
}

impl Layer {
    fn anim_offsets(&self, lt: f32, library: &Library) -> AnimOffsets {
        let mut o = AnimOffsets { opacity: 1.0, scale: 1.0, dx: 0.0, dy: 0.0, rotation: 0.0 };
        for r in &self.anims {
            let Some(template) = library.animations.get(&r.key) else { continue };
            let t = (lt - r.at) * r.speed.max(0.01);
            for prop in template.keys.keys() {
                let Some(v) = template.sample(*prop, t) else { continue };
                if prop.is_factor() {
                    let v = 1.0 + (v - 1.0) * r.intensity;
                    match prop {
                        AnimProp::Opacity => o.opacity *= v,
                        _ => o.scale *= v,
                    }
                } else {
                    let v = v * r.intensity;
                    match prop {
                        AnimProp::Dx => o.dx += v,
                        AnimProp::Dy => o.dy += v,
                        _ => o.rotation += v,
                    }
                }
            }
        }
        o
    }
}

/// A rotated box in scene pixels, used for hit-testing.
pub struct Bounds {
    pub center: [f32; 2],
    pub size: [f32; 2],
    pub rotation: f32,
}

impl Bounds {
    pub fn contains(&self, p: [f32; 2]) -> bool {
        let (s, c) = (-self.rotation).sin_cos();
        let (dx, dy) = (p[0] - self.center[0], p[1] - self.center[1]);
        let local = [dx * c - dy * s, dx * s + dy * c];
        local[0].abs() <= self.size[0] / 2.0 && local[1].abs() <= self.size[1] / 2.0
    }
}

impl Layer {
    /// Where the layer is on screen at layer-local time `lt` (`None` if invisible).
    pub fn bounds(&self, lt: f32, ctx: &EvalCtx) -> Option<Bounds> {
        match self.resolve(lt, ctx, false)? {
            DrawItem::Shape(s) => Some(Bounds { center: s.center, size: s.size, rotation: s.rotation }),
            DrawItem::Image(i) => Some(Bounds { center: i.center, size: i.size, rotation: i.rotation }),
            DrawItem::Text(t) => {
                let scale = self.scale.sample(lt);
                Some(Bounds { center: t.center, size: [t.max_width, self.h.sample(lt) * scale], rotation: t.rotation })
            }
            DrawItem::Poly(_) | DrawItem::Group(_) | DrawItem::Stage(_) => {
                let scale = self.scale.sample(lt);
                let origin = self
                    .anchor
                    .as_ref()
                    .and_then(|a| ctx.library.anchor(a))
                    .map_or([0.0, 0.0], |[ax, ay]| [ax * ctx.scene_size[0], ay * ctx.scene_size[1]]);
                Some(Bounds {
                    center: [origin[0] + self.x.sample(lt), origin[1] + self.y.sample(lt)],
                    size: [self.w.sample(lt) * scale, self.h.sample(lt) * scale],
                    rotation: 0.0,
                })
            }
        }
    }
}

/// Margin kept between text and the frame edge, as a fraction of the width.
const TEXT_SAFE_MARGIN: f32 = 0.05;

/// Wrap width that keeps a text block centered at `cx` inside the frame.
fn fit_width(wanted: f32, cx: f32, frame_w: f32) -> f32 {
    let room = 2.0 * (cx.min(frame_w - cx) - frame_w * TEXT_SAFE_MARGIN);
    wanted.min(room).max(frame_w * 0.2)
}

/// Upgrade older scene JSON in place (layers saved before `type` existed were all shapes).
pub(crate) fn migrate(scene: &mut serde_json::Value) {
    let Some(layers) = scene.get_mut("layers").and_then(|l| l.as_array_mut()) else {
        return;
    };
    for layer in layers {
        if let Some(obj) = layer.as_object_mut() {
            if !obj.contains_key("type") && obj.contains_key("shape") {
                obj.insert("type".into(), "shape".into());
            }
        }
    }
}
