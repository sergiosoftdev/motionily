//! Everything beyond flat color: gradients, strokes, soft edges, per-layer effects (blur, glow,
//! drop shadow), blend modes, track mattes, repeaters and vector paths — the After Effects toolbox
//! the agent composes freely.

use crate::{Animated, ColorRef, Easing, Palette, Rgba};
use serde::{Deserialize, Serialize};

/// One color keyframe: `{"t":0.4,"c":"#ff3d5a","ease":"expo_out"}` (t relative to the layer start).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ColorKey {
    pub t: f32,
    pub c: ColorRef,
    #[serde(default)]
    pub ease: Easing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bezier: Option<[f32; 4]>,
}

/// A color that is fixed (`"primary"`, `"#ff3d5a"`) or keyframed (`[{"t":0,"c":…},{"t":1,"c":…}]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ColorAnim {
    Static(ColorRef),
    Keys(Vec<ColorKey>),
}

impl Default for ColorAnim {
    fn default() -> Self {
        ColorAnim::Static(ColorRef::default())
    }
}

impl From<ColorRef> for ColorAnim {
    fn from(c: ColorRef) -> Self {
        ColorAnim::Static(c)
    }
}

impl ColorAnim {
    pub fn resolve(&self, t: f32, palette: &Palette) -> Rgba {
        let keys = match self {
            ColorAnim::Static(c) => return c.resolve(palette),
            ColorAnim::Keys(keys) => keys,
        };
        let (Some(first), Some(last)) = (keys.first(), keys.last()) else {
            return Rgba([1.0; 4]);
        };
        if t <= first.t {
            return first.c.resolve(palette);
        }
        if t >= last.t {
            return last.c.resolve(palette);
        }
        let i = keys.partition_point(|k| k.t <= t);
        let (a, b) = (&keys[i - 1], &keys[i]);
        let u = (t - a.t) / (b.t - a.t).max(f32::EPSILON);
        let p = a.bezier.map_or_else(|| a.ease.apply(u), |bz| crate::anim::cubic_bezier(bz, u));
        let (ca, cb) = (a.c.resolve(palette), b.c.resolve(palette));
        Rgba(std::array::from_fn(|k| ca.0[k] + (cb.0[k] - ca.0[k]) * p))
    }
}

/// Most stops a gradient can carry on the GPU.
pub const MAX_STOPS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GradientKind {
    #[default]
    Linear,
    Radial,
}

/// `{"kind":"linear","angle":90,"stops":[[0,"#ff5a5f"],[1,"#ffb347"]]}` — positions 0..1 across the
/// layer box. Linear: `angle` in degrees (0 = left→right, 90 = top→bottom). Radial: from `center`
/// (0..1 of the box) out to `radius` (fraction of the box diagonal half).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gradient {
    #[serde(default)]
    pub kind: GradientKind,
    pub stops: Vec<(f32, ColorAnim)>,
    #[serde(default)]
    pub angle: Animated,
    #[serde(default = "center")]
    pub center: [f32; 2],
    #[serde(default = "one")]
    pub radius: Animated,
}

fn center() -> [f32; 2] {
    [0.5, 0.5]
}
fn one() -> Animated {
    Animated::Static(1.0)
}

/// Resolved gradient for the GPU (layer-local box space).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawGradient {
    pub kind: GradientKind,
    pub stops: [(f32, Rgba); MAX_STOPS],
    pub count: usize,
    /// Radians (linear).
    pub angle: f32,
    pub center: [f32; 2],
    pub radius: f32,
}

impl DrawGradient {
    /// Color at `uv` (0..1 across the box), same math as the shape shader.
    pub fn color_at(&self, uv: [f32; 2]) -> Rgba {
        let t = match self.kind {
            GradientKind::Linear => {
                let dir = [self.angle.cos(), self.angle.sin()];
                let extent = 0.5 * (dir[0].abs() + dir[1].abs());
                ((uv[0] - 0.5) * dir[0] + (uv[1] - 0.5) * dir[1]) / extent.max(1e-3) * 0.5 + 0.5
            }
            GradientKind::Radial => ((uv[0] - self.center[0]).hypot(uv[1] - self.center[1])) / (self.radius * 0.7071).max(1e-3),
        }
        .clamp(0.0, 1.0);
        let mut col = self.stops[0].1;
        for i in 1..self.count {
            let (a, b) = (self.stops[i - 1].0, self.stops[i].0);
            if t >= a {
                let u = ((t - a) / (b - a).max(1e-4)).clamp(0.0, 1.0);
                col = Rgba(std::array::from_fn(|k| self.stops[i - 1].1 .0[k] + (self.stops[i].1 .0[k] - self.stops[i - 1].1 .0[k]) * u));
            }
        }
        col
    }
}

impl Gradient {
    pub fn resolve(&self, t: f32, palette: &Palette, opacity: f32) -> DrawGradient {
        let mut stops = [(0.0, Rgba([0.0; 4])); MAX_STOPS];
        let count = self.stops.len().clamp(1, MAX_STOPS);
        for (i, (pos, c)) in self.stops.iter().take(MAX_STOPS).enumerate() {
            let mut col = c.resolve(t, palette);
            col.0[3] *= opacity;
            stops[i] = (*pos, col);
        }
        if self.stops.is_empty() {
            stops[0] = (0.0, Rgba([1.0, 1.0, 1.0, opacity]));
        }
        DrawGradient { kind: self.kind, stops, count, angle: self.angle.sample(t).to_radians(), center: self.center, radius: self.radius.sample(t) }
    }
}

/// Outline. `dash` = [on, off] in pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub width: Animated,
    #[serde(default = "stroke_color")]
    pub color: ColorAnim,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash: Option<[f32; 2]>,
}

fn stroke_color() -> ColorAnim {
    ColorAnim::Static(ColorRef::Slot(crate::PaletteSlot::Text))
}

/// How a shape is painted beyond its fill color.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ShapeStyle {
    pub gradient: Option<DrawGradient>,
    /// Outline width (px) and color; with `fill_alpha == 0` it is an outline only.
    pub stroke: Option<(f32, Rgba)>,
    /// Feather in pixels: 0 = crisp edge, large = blurred blob (mesh-gradient backgrounds, glows).
    pub soft: f32,
    pub dash: Option<[f32; 2]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
    #[default]
    Normal,
    /// Light adds up: glows, light leaks, flares.
    Add,
    Screen,
    Multiply,
}

/// Per-layer effects, applied in order on the layer's own pixels (like an AE effect stack).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "fx", rename_all = "snake_case")]
pub enum Effect {
    /// Gaussian blur (depth of field, motion softness, frosted backgrounds).
    Blur { radius: Animated },
    /// Bloom around bright edges: the layer blurred and added on top.
    Glow {
        radius: Animated,
        #[serde(default = "one")]
        strength: Animated,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<ColorRef>,
    },
    /// Soft drop shadow (colored shadows look premium: tint it with the brand color).
    Shadow {
        #[serde(default)]
        x: Animated,
        #[serde(default = "shadow_y")]
        y: Animated,
        #[serde(default = "shadow_blur")]
        blur: Animated,
        #[serde(default = "shadow_color")]
        color: ColorRef,
        #[serde(default = "shadow_opacity")]
        opacity: Animated,
    },
}

fn shadow_y() -> Animated {
    Animated::Static(18.0)
}
fn shadow_blur() -> Animated {
    Animated::Static(36.0)
}
fn shadow_color() -> ColorRef {
    ColorRef::Raw(Rgba([0.06, 0.07, 0.12, 1.0]))
}
fn shadow_opacity() -> Animated {
    Animated::Static(0.25)
}

/// Resolved effect for one frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DrawEffect {
    Blur { radius: f32 },
    Glow { radius: f32, strength: f32, color: Option<Rgba> },
    Shadow { offset: [f32; 2], blur: f32, color: Rgba },
}

impl Effect {
    pub fn resolve(&self, t: f32, palette: &Palette) -> DrawEffect {
        match self {
            Effect::Blur { radius } => DrawEffect::Blur { radius: radius.sample(t).max(0.0) },
            Effect::Glow { radius, strength, color } => DrawEffect::Glow {
                radius: radius.sample(t).max(0.0),
                strength: strength.sample(t).max(0.0),
                color: color.map(|c| c.resolve(palette)),
            },
            Effect::Shadow { x, y, blur, color, opacity } => {
                let mut c = color.resolve(palette);
                c.0[3] *= opacity.sample(t).clamp(0.0, 1.0);
                DrawEffect::Shadow { offset: [x.sample(t), y.sample(t)], blur: blur.sample(t).max(0.0), color: c }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatteMode {
    /// Show this layer only where the matte layer is opaque (reveals, text masks).
    #[default]
    Alpha,
    /// Show it where the matte is transparent (cut-outs).
    AlphaInverted,
}

/// Track matte: another layer's alpha masks this one. Matte layers usually set `"visible": false`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Matte {
    pub layer: String,
    #[serde(default)]
    pub mode: MatteMode,
}

/// Copies of a layer in a row or grid, each offset a bit more (and optionally later): grids,
/// particle fields, staggered lists, radial bursts — one line instead of dozens of layers.
/// Inside expressions `i` is the copy index and `n` the count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Repeater {
    pub count: u32,
    /// Offset per copy (px) along x/y; with `columns`, x is the column step and y the row step.
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    /// Degrees added per copy (around the layer's pivot).
    #[serde(default)]
    pub rotation: f32,
    /// Scale multiplied per copy.
    #[serde(default = "unit")]
    pub scale: f32,
    /// Opacity multiplied per copy.
    #[serde(default = "unit")]
    pub opacity: f32,
    /// Seconds each copy starts after the previous one.
    #[serde(default)]
    pub delay: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u32>,
}

fn unit() -> f32 {
    1.0
}

pub const MAX_REPEAT: u32 = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextUnit {
    #[default]
    Char,
    Word,
    Line,
}

/// Where each unit starts from (it animates to its rest pose).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct UnitOffset {
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    /// Scale factor at the start (1 = none).
    #[serde(default = "unit")]
    pub scale: f32,
    /// Degrees.
    #[serde(default)]
    pub rotation: f32,
    /// Opacity at the start.
    #[serde(default)]
    pub opacity: f32,
}

/// Per-character / word / line animation (AE text animator with a range selector): every unit
/// moves from `from` to rest, one after another.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextAnimator {
    #[serde(default)]
    pub by: TextUnit,
    /// Seconds between consecutive units.
    #[serde(default = "stagger")]
    pub stagger: f32,
    /// Seconds each unit takes.
    #[serde(default = "unit_duration")]
    pub duration: f32,
    /// Seconds from the layer start before the first unit moves.
    #[serde(default)]
    pub delay: f32,
    #[serde(default = "expo")]
    pub ease: crate::Easing,
    pub from: UnitOffset,
    /// Animate units from the last one backwards.
    #[serde(default)]
    pub reverse: bool,
}

fn stagger() -> f32 {
    0.04
}
fn unit_duration() -> f32 {
    0.5
}
fn expo() -> crate::Easing {
    crate::Easing::ExpoOut
}

/// Resolved animator for one frame (`time` = seconds since the layer started).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawTextAnim {
    pub anim: (TextUnit, f32, f32, f32, crate::Easing, UnitOffset, bool),
    pub time: f32,
}

impl DrawTextAnim {
    /// Progress 0..1 (eased) of unit `k` of `count`.
    pub fn progress(&self, k: usize, count: usize) -> f32 {
        let (_, stagger, duration, delay, ease, _, reverse) = self.anim;
        let idx = if reverse { count.saturating_sub(1 + k) } else { k };
        let u = ((self.time - delay - stagger * idx as f32) / duration.max(1e-3)).clamp(0.0, 1.0);
        ease.apply(u)
    }
}

impl TextAnimator {
    pub fn resolve(&self, time: f32) -> DrawTextAnim {
        DrawTextAnim { anim: (self.by, self.stagger, self.duration, self.delay, self.ease, self.from, self.reverse), time }
    }
}

/// A layer that needs its own offscreen pass (effects, blend mode, matte).
#[derive(Debug, Clone, PartialEq)]
pub struct DrawFx {
    pub items: Vec<crate::DrawItem>,
    pub effects: Vec<DrawEffect>,
    pub blend: BlendMode,
    pub matte: Option<(Vec<crate::DrawItem>, MatteMode)>,
}

/// One stroked/filled vector path for one frame, already flattened to polylines in scene pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawPath {
    /// Each subpath as a polyline (trimmed).
    pub lines: Vec<Vec<[f32; 2]>>,
    /// Closed untrimmed subpaths to fill, as polygons.
    pub fills: Vec<Vec<[f32; 2]>>,
    pub fill: Option<Rgba>,
    pub stroke: Option<(f32, Rgba)>,
    /// Stroke color varying along the path (start, end).
    pub stroke_end: Option<Rgba>,
    pub dash: Option<[f32; 2]>,
    /// Bounding box of the untrimmed geometry, for gradients and hit-tests.
    pub bounds: ([f32; 2], [f32; 2]),
    pub gradient: Option<DrawGradient>,
}
