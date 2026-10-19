//! Layers and what they resolve to for one frame.
//!
//! A layer is common timing + transform fields plus a `content` that says what
//! it is. New kinds of content (text, characters, 3D…) are new variants of
//! [`LayerContent`] and [`DrawItem`]; the renderer draws each `DrawItem` kind
//! with its own pipeline, keeping layer order.

use crate::{AnimProp, Animated, ColorRef, Library, Palette, Rgba};
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
}

impl LayerContent {
    /// Short name for summaries.
    pub fn kind_name(&self) -> String {
        match self {
            LayerContent::Shape { shape } => crate::enum_name(shape),
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
}

impl Layer {
    /// Resolve this layer at layer-local time `lt`. `None` when fully transparent.
    pub fn draw(&self, lt: f32, ctx: &EvalCtx) -> Option<DrawItem> {
        let anim = self.anim_offsets(lt, ctx.library);
        let scale = self.scale.sample(lt) * anim.scale;
        let mut color = self.fill.resolve(ctx.palette);
        color.0[3] *= (self.opacity.sample(lt) * anim.opacity).clamp(0.0, 1.0);
        if color.0[3] <= 0.0 {
            return None;
        }
        let origin = self
            .anchor
            .as_ref()
            .and_then(|a| ctx.library.anchors.get(a))
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
