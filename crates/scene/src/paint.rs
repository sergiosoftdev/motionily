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
    /// Sweeps around `center` starting at `angle` (rotating rim lights, glowing borders: animate
    /// `angle`, repeat the first color last for a seamless loop).
    Conic,
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
fn is_one(v: &Animated) -> bool {
    matches!(v, Animated::Static(x) if *x == 1.0)
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
            GradientKind::Conic => ((uv[1] - self.center[1]).atan2(uv[0] - self.center[0]) - self.angle).rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU,
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
    /// Paint the outline with a gradient (a conic one makes glowing, rotating borders).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<Gradient>,
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
    /// `gradient` paints the outline instead of the fill.
    pub stroke_gradient: bool,
    /// Inner shadow / inner glow: offset, blur (px) and color (alpha = strength).
    pub inner: Option<([f32; 2], f32, Rgba)>,
    /// Light sweeping across the surface: angle (rad), position (0..1 of the sweep), width
    /// (fraction of the shape), intensity.
    pub sheen: Option<[f32; 4]>,
    /// Embossed edge: width (px), strength.
    pub bevel: Option<[f32; 2]>,
}

/// Shadow or glow painted inside a shape's edge (pressed buttons, glass rims, inset fields).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Inner {
    #[serde(default)]
    pub x: Animated,
    #[serde(default)]
    pub y: Animated,
    #[serde(default = "inner_blur")]
    pub blur: Animated,
    #[serde(default = "shadow_color")]
    pub color: ColorRef,
    #[serde(default = "shadow_opacity")]
    pub opacity: Animated,
}

fn inner_blur() -> Animated {
    Animated::Static(12.0)
}

/// A band of light sweeping across a surface (glossy cards, glass, chrome): animate `at` 0 -> 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sheen {
    #[serde(default)]
    pub at: Animated,
    /// Degrees of the band's travel direction.
    #[serde(default = "sheen_angle")]
    pub angle: Animated,
    #[serde(default = "sheen_width")]
    pub width: Animated,
    #[serde(default = "sheen_opacity")]
    pub opacity: Animated,
}

fn sheen_angle() -> Animated {
    Animated::Static(20.0)
}
fn sheen_width() -> Animated {
    Animated::Static(0.18)
}
fn sheen_opacity() -> Animated {
    Animated::Static(0.45)
}

/// Embossed edge lit from the top-left (plastic, glossy app tiles, buttons).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bevel {
    #[serde(default = "bevel_width")]
    pub width: Animated,
    #[serde(default = "bevel_strength")]
    pub strength: Animated,
}

fn bevel_width() -> Animated {
    Animated::Static(6.0)
}
fn bevel_strength() -> Animated {
    Animated::Static(0.35)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
    #[default]
    Normal,
    /// Light adds up: glows, light leaks, flares (AE "Linear Dodge" / "Add").
    Add,
    Screen,
    Multiply,
    /// Keeps the darker / lighter channel of the two.
    Darken,
    Lighten,
    /// Absolute difference of the two colors: inverts where they differ.
    Difference,
    /// Like difference but lower contrast.
    Exclusion,
    /// Multiply or screen depending on the layer's own brightness: contrast boost.
    Overlay,
    /// Gentle version of overlay: dodges and burns softly.
    SoftLight,
    /// Overlay with the layer's brightness deciding: strong light / shadow.
    HardLight,
    ColorDodge,
    ColorBurn,
    /// Subtracts the layer from what is below (darkens by the layer's brightness).
    LinearBurn,
    /// The layer's hue on the backdrop's saturation and luminosity.
    Hue,
    /// The layer's saturation on the backdrop's hue and luminosity.
    Saturation,
    /// The layer's hue and saturation on the backdrop's luminosity (tints gray images).
    Color,
    /// The layer's luminosity on the backdrop's hue and saturation.
    Luminosity,
}

impl BlendMode {
    /// Modes that read what is already on the scene. The first four blend in fixed function, so
    /// they cost one pass; the rest copy the scene and blend in a shader (see `fx.wgsl`, `fs_blend`).
    pub fn reads_backdrop(self) -> bool {
        !matches!(self, BlendMode::Normal | BlendMode::Add | BlendMode::Screen | BlendMode::Multiply)
    }

    /// Mode id for the backdrop blend shader (`fs_blend` switch).
    pub fn shader_id(self) -> f32 {
        match self {
            BlendMode::Normal | BlendMode::Add | BlendMode::Screen | BlendMode::Multiply => 0.0,
            BlendMode::Darken => 4.0,
            BlendMode::Lighten => 5.0,
            BlendMode::Difference => 6.0,
            BlendMode::Exclusion => 7.0,
            BlendMode::Overlay => 8.0,
            BlendMode::SoftLight => 9.0,
            BlendMode::HardLight => 10.0,
            BlendMode::ColorDodge => 11.0,
            BlendMode::ColorBurn => 12.0,
            BlendMode::LinearBurn => 13.0,
            BlendMode::Hue => 14.0,
            BlendMode::Saturation => 15.0,
            BlendMode::Color => 16.0,
            BlendMode::Luminosity => 17.0,
        }
    }
}

/// Per-layer effects, applied in order on the layer's own pixels (like an AE effect stack).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "fx", rename_all = "snake_case")]
pub enum Effect {
    /// Gaussian blur (depth of field, motion softness, frosted backgrounds).
    Blur { radius: Animated },
    /// Bloom around bright edges: the layer blurred and added on top. `threshold` (0..1, luma) keeps
    /// only the bright parts glowing, so light and neon read as light instead of a haze on the whole layer.
    Glow {
        radius: Animated,
        #[serde(default = "one")]
        strength: Animated,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<ColorRef>,
        #[serde(default)]
        threshold: f32,
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
    /// Color correction, applied in this order: `exposure` (stops, 0 = unchanged), white balance
    /// (`temperature` -1 cool .. 1 warm, `tint` -1 green .. 1 magenta), `brightness` (-1..1, added),
    /// `contrast` (1 = unchanged, around mid grey), `shadows` and `highlights` (-1..1: lift or crush the
    /// darks, recover or push the brights), `saturation` (1 = unchanged, 0 = grey), `vibrance` (-1..1,
    /// saturates the dull colors more than the vivid ones), `hue` shift (degrees) and `vignette`
    /// (0..1, darkens the frame's corners). Every field is optional and animatable.
    Color {
        #[serde(default)]
        hue: Animated,
        #[serde(default = "one")]
        saturation: Animated,
        #[serde(default)]
        brightness: Animated,
        #[serde(default = "one")]
        contrast: Animated,
        #[serde(default, skip_serializing_if = "is_zero")]
        exposure: Animated,
        #[serde(default, skip_serializing_if = "is_zero")]
        temperature: Animated,
        #[serde(default, skip_serializing_if = "is_zero")]
        tint: Animated,
        #[serde(default, skip_serializing_if = "is_zero")]
        shadows: Animated,
        #[serde(default, skip_serializing_if = "is_zero")]
        highlights: Animated,
        #[serde(default, skip_serializing_if = "is_zero")]
        vibrance: Animated,
        #[serde(default, skip_serializing_if = "is_zero")]
        vignette: Animated,
        /// Color wheels per channel [r, g, b], as a colorist's lift/gamma/gain/offset:
        /// `out = (gain · (in + lift · (1 − in)))^(1/gamma) + offset`. Neutral: lift 0, gamma 1, gain 1, offset 0.
        #[serde(default, skip_serializing_if = "is_zero3")]
        lift: [f32; 3],
        #[serde(default = "ones3", skip_serializing_if = "is_one3")]
        gamma: [f32; 3],
        #[serde(default = "ones3", skip_serializing_if = "is_one3")]
        gain: [f32; 3],
        #[serde(default, skip_serializing_if = "is_zero3")]
        offset: [f32; 3],
        /// Curves (points `[x, y]` in 0..1, up to 6 each, straight between them): `master` on every channel, then
        /// `red`, `green`, `blue`. Applied last, before the vignette.
        #[serde(default, skip_serializing_if = "Curves::is_empty")]
        curves: Curves,
        /// A `.cube` LUT from the media pool (`/media/…`), applied after the curves; `lut_mix` 0..1 blends it in.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lut: Option<String>,
        #[serde(default = "one", skip_serializing_if = "is_one")]
        lut_mix: Animated,
    },
    /// RGB split: red and blue shifted apart by `amount` px (glitch, lens edge).
    Chromatic { amount: Animated },
    /// Wave warp: pixels pushed sideways by a travelling sine (heat haze, flags, liquid).
    Wave {
        /// Displacement in px.
        amplitude: Animated,
        /// Px between crests.
        #[serde(default = "wavelength")]
        wavelength: Animated,
        /// Crests per second.
        #[serde(default = "one")]
        speed: Animated,
    },
    /// Animated film grain (0..1).
    Grain { amount: Animated },
    /// Turbulent displacement (AE Turbulent Displace): pixels pushed around by flowing fractal
    /// noise. On big soft blobs it makes liquid, smoky, cloudy gradient backgrounds.
    Turbulence {
        /// Displacement in px.
        amount: Animated,
        /// Px per noise cell (bigger = broader swirls).
        #[serde(default = "turbulence_size")]
        size: Animated,
        /// How fast the noise flows.
        #[serde(default = "one")]
        speed: Animated,
    },
    /// Motion blur: the layer averaged over the shutter (degrees of a frame, 180 = film look).
    MotionBlur {
        #[serde(default = "shutter")]
        shutter: f32,
        #[serde(default = "blur_samples")]
        samples: u32,
    },
    /// Liquid glass on an adjustment layer over a rect or ellipse: the rim bends what is behind it by
    /// Snell's law (a convex bevel), the body is blurred and tinted, and a Fresnel rim and a specular
    /// highlight catch the light. `thickness` is how far light travels through the glass (px), `bevel`
    /// how wide the rounded rim is (px), `blur` how much the body is blurred (px), `ior` the refractive
    /// index (glass 1.5), `dispersion` the IOR spread between red, green and blue (0.02 = a faint fringe).
    Glass {
        #[serde(default = "glass_thickness")]
        thickness: f32,
        #[serde(default = "glass_bevel")]
        bevel: f32,
        #[serde(default = "glass_blur")]
        blur: f32,
        #[serde(default = "glass_ior")]
        ior: f32,
        #[serde(default)]
        dispersion: f32,
        #[serde(default = "glass_specular")]
        specular: f32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tint: Option<ColorRef>,
    },
    /// Custom GPU effect: the agent's WGSL `fn shade(uv, px) -> vec4f` rewrites every pixel,
    /// reading the layer's own pixels with `src(uv)` (on an adjustment layer: everything below).
    Shader {
        code: crate::shader::ShaderCode,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        params: Vec<Animated>,
    },
}

/// Points of a colorist's curves (see `Effect::Color`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Curves {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub master: Vec<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub red: Vec<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub green: Vec<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blue: Vec<[f32; 2]>,
}

/// Points per curve the renderer reads.
pub const CURVE_POINTS: usize = 6;

impl Curves {
    pub fn is_empty(&self) -> bool {
        self.master.is_empty() && self.red.is_empty() && self.green.is_empty() && self.blue.is_empty()
    }

    /// Each curve as sorted, clamped points (at most CURVE_POINTS) and its count.
    fn resolved(&self) -> ([[[f32; 2]; CURVE_POINTS]; 4], [u32; 4]) {
        let mut out = [[[0.0; 2]; CURVE_POINTS]; 4];
        let mut n = [0u32; 4];
        for (i, pts) in [&self.master, &self.red, &self.green, &self.blue].into_iter().enumerate() {
            let mut p: Vec<[f32; 2]> = pts.iter().map(|[x, y]| [x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)]).collect();
            p.sort_by(|a, b| a[0].total_cmp(&b[0]));
            p.truncate(CURVE_POINTS);
            for (j, q) in p.iter().enumerate() {
                out[i][j] = *q;
            }
            n[i] = p.len() as u32;
        }
        (out, n)
    }
}

fn is_zero3(v: &[f32; 3]) -> bool {
    *v == [0.0; 3]
}
fn is_one3(v: &[f32; 3]) -> bool {
    *v == [1.0; 3]
}
fn ones3() -> [f32; 3] {
    [1.0; 3]
}

/// An effect field left at its neutral 0 is not written back (scenes stay as short as they were).
fn is_zero(a: &Animated) -> bool {
    matches!(a, Animated::Static(v) if *v == 0.0)
}

fn turbulence_size() -> Animated {
    Animated::Static(320.0)
}
fn wavelength() -> Animated {
    Animated::Static(200.0)
}
fn shutter() -> f32 {
    180.0
}
fn blur_samples() -> u32 {
    8
}

/// Most sub-frame samples motion blur takes.
pub const MAX_BLUR_SAMPLES: u32 = 16;

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

/// The grading half of `Effect::Color` for one frame (neutral = all zeros).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorGrade {
    pub exposure: f32,
    pub temperature: f32,
    pub tint: f32,
    pub shadows: f32,
    pub highlights: f32,
    pub vibrance: f32,
    pub vignette: f32,
    pub lift: [f32; 3],
    pub gamma: [f32; 3],
    pub gain: [f32; 3],
    pub offset: [f32; 3],
    /// Curves (master, red, green, blue) and how many points each has (0 = none).
    pub curves: [[[f32; 2]; CURVE_POINTS]; 4],
    pub curve_points: [u32; 4],
    /// `lut_key` of the LUT (0 = none) and how much of it shows.
    pub lut: u64,
    pub lut_mix: f32,
}

impl Default for ColorGrade {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            temperature: 0.0,
            tint: 0.0,
            shadows: 0.0,
            highlights: 0.0,
            vibrance: 0.0,
            vignette: 0.0,
            lift: [0.0; 3],
            gamma: [1.0; 3],
            gain: [1.0; 3],
            offset: [0.0; 3],
            curves: [[[0.0; 2]; CURVE_POINTS]; 4],
            curve_points: [0; 4],
            lut: 0,
            lut_mix: 0.0,
        }
    }
}

impl ColorGrade {
    /// Two effects in a stack add up (exposure, white balance, tone, vibrance), like stacked adjustments.
    pub fn add(&mut self, o: &ColorGrade) {
        self.exposure += o.exposure;
        self.temperature += o.temperature;
        self.tint += o.tint;
        self.shadows += o.shadows;
        self.highlights += o.highlights;
        self.vibrance += o.vibrance;
        self.vignette = (self.vignette + o.vignette).min(1.0);
        for c in 0..3 {
            self.lift[c] += o.lift[c];
            self.gamma[c] *= o.gamma[c];
            self.gain[c] *= o.gain[c];
            self.offset[c] += o.offset[c];
        }
        // One LUT per layer: the last effect that has one.
        if o.lut != 0 {
            self.lut = o.lut;
            self.lut_mix = o.lut_mix;
        }
        // Curves do not add up: the last effect with a curve wins for that curve.
        for i in 0..4 {
            if o.curve_points[i] > 0 {
                self.curves[i] = o.curves[i];
                self.curve_points[i] = o.curve_points[i];
            }
        }
    }
}

/// Resolved effect for one frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DrawEffect {
    Blur { radius: f32 },
    Glow { radius: f32, strength: f32, color: Option<Rgba>, threshold: f32 },
    /// Liquid glass (see `Effect::Glass`); `shape` is the layer's own box, filled in when its pass is built.
    Glass { thickness: f32, bevel: f32, blur: f32, ior: f32, dispersion: f32, specular: f32, tint: Option<Rgba>, shape: Option<GlassShape> },
    Shadow { offset: [f32; 2], blur: f32, color: Rgba },
    Color { hue: f32, saturation: f32, brightness: f32, contrast: f32, grade: ColorGrade },
    Chromatic { amount: f32 },
    /// `phase` in radians.
    Wave { amplitude: f32, wavelength: f32, phase: f32 },
    /// `seed` changes every frame so the grain moves.
    Grain { amount: f32, seed: f32 },
    /// `phase` = flow time.
    Turbulence { amount: f32, size: f32, phase: f32 },
    /// Custom shader (code by `hash`, see `Scene::shader_codes`) at layer time `time`; `zoom`
    /// = screen px per layer px (camera depth).
    Shader { hash: u64, params: [f32; crate::shader::MAX_PARAMS], time: f32, scene_time: f32, zoom: f32 },
}

impl DrawEffect {
    /// Sizes in pixels follow a zoom.
    pub fn scale(&mut self, s: f32) {
        match self {
            DrawEffect::Blur { radius } | DrawEffect::Glow { radius, .. } => *radius *= s,
            DrawEffect::Glass { thickness, bevel, blur, .. } => {
                *thickness *= s;
                *bevel *= s;
                *blur *= s;
            }
            DrawEffect::Shadow { offset, blur, .. } => {
                *offset = [offset[0] * s, offset[1] * s];
                *blur *= s;
            }
            DrawEffect::Chromatic { amount } => *amount *= s,
            DrawEffect::Wave { amplitude, wavelength, .. } => {
                *amplitude *= s;
                *wavelength *= s;
            }
            DrawEffect::Turbulence { amount, size, .. } => {
                *amount *= s;
                *size *= s;
            }
            DrawEffect::Shader { zoom, .. } => *zoom *= s,
            DrawEffect::Color { .. } | DrawEffect::Grain { .. } => {}
        }
    }
}

impl Effect {
    /// The `.cube` file a color effect maps through.
    pub fn lut_src(&self) -> Option<&str> {
        match self {
            Effect::Color { lut, .. } => lut.as_deref(),
            _ => None,
        }
    }

    /// The effect at layer time `t`; `None` for motion blur, which the scene applies itself.
    pub fn resolve(&self, t: f32, palette: &Palette) -> Option<DrawEffect> {
        Some(match self {
            Effect::Blur { radius } => DrawEffect::Blur { radius: radius.sample(t).max(0.0) },
            Effect::Glass { thickness, bevel, blur, ior, dispersion, specular, tint } => DrawEffect::Glass {
                thickness: *thickness,
                bevel: *bevel,
                blur: *blur,
                ior: *ior,
                dispersion: *dispersion,
                specular: *specular,
                tint: tint.as_ref().map(|c| c.resolve(palette)),
                shape: None,
            },
            Effect::Glow { radius, strength, color, threshold } => DrawEffect::Glow {
                radius: radius.sample(t).max(0.0),
                strength: strength.sample(t).max(0.0),
                color: color.map(|c| c.resolve(palette)),
                threshold: threshold.clamp(0.0, 1.0),
            },
            Effect::Shadow { x, y, blur, color, opacity } => {
                let mut c = color.resolve(palette);
                c.0[3] *= opacity.sample(t).clamp(0.0, 1.0);
                DrawEffect::Shadow { offset: [x.sample(t), y.sample(t)], blur: blur.sample(t).max(0.0), color: c }
            }
            Effect::Color { hue, saturation, brightness, contrast, exposure, temperature, tint, shadows, highlights, vibrance, vignette, lift, gamma, gain, offset, curves, lut, lut_mix } => DrawEffect::Color {
                hue: hue.sample(t),
                saturation: saturation.sample(t).max(0.0),
                brightness: brightness.sample(t),
                contrast: contrast.sample(t).max(0.0),
                grade: ColorGrade {
                    exposure: exposure.sample(t).clamp(-5.0, 5.0),
                    temperature: temperature.sample(t).clamp(-1.0, 1.0),
                    tint: tint.sample(t).clamp(-1.0, 1.0),
                    shadows: shadows.sample(t).clamp(-1.0, 1.0),
                    highlights: highlights.sample(t).clamp(-1.0, 1.0),
                    vibrance: vibrance.sample(t).clamp(-1.0, 1.0),
                    vignette: vignette.sample(t).clamp(0.0, 1.0),
                    lift: lift.map(|v| v.clamp(-1.0, 1.0)),
                    gamma: gamma.map(|v| v.clamp(0.1, 10.0)),
                    gain: gain.map(|v| v.clamp(0.0, 4.0)),
                    offset: offset.map(|v| v.clamp(-1.0, 1.0)),
                    curves: curves.resolved().0,
                    curve_points: curves.resolved().1,
                    lut: lut.as_deref().map_or(0, crate::lut::lut_key),
                    lut_mix: if lut.is_some() { lut_mix.sample(t).clamp(0.0, 1.0) } else { 0.0 },
                },
            },
            Effect::Chromatic { amount } => DrawEffect::Chromatic { amount: amount.sample(t) },
            Effect::Wave { amplitude, wavelength, speed } => DrawEffect::Wave {
                amplitude: amplitude.sample(t),
                wavelength: wavelength.sample(t).max(1.0),
                phase: speed.sample(t) * t * std::f32::consts::TAU,
            },
            Effect::Grain { amount } => DrawEffect::Grain { amount: amount.sample(t).clamp(0.0, 1.0), seed: (t * 24.0).floor() },
            Effect::Turbulence { amount, size, speed } => DrawEffect::Turbulence { amount: amount.sample(t), size: size.sample(t).max(4.0), phase: speed.sample(t) * t },
            Effect::MotionBlur { .. } => return None,
            Effect::Shader { code, params } => DrawEffect::Shader {
                hash: code.hash(),
                params: crate::shader::sample_params(params, t),
                time: t,
                scene_time: crate::expr::scene_time(),
                zoom: 1.0,
            },
        })
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
    /// Show it where the matte is bright (luma matte).
    Luma,
    LumaInverted,
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
    /// Blur in px at the start (words that come into focus).
    #[serde(default)]
    pub blur: f32,
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
/// The rounded box a glass effect covers: a rect with corner `radius` (a circle when `radius` is half
/// the short side, a pill between). Ellipses are drawn as such boxes too.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlassShape {
    pub center: [f32; 2],
    pub half: [f32; 2],
    pub radius: f32,
    pub rotation: f32,
}

impl GlassShape {
    /// The box after a transition moves and scales its layer (same map as the layer's own items).
    pub fn transformed(self, origin: [f32; 2], s: f32, angle: f32, shift: [f32; 2]) -> GlassShape {
        let (sin, cos) = angle.sin_cos();
        let q = [self.center[0] - origin[0], self.center[1] - origin[1]];
        let turned = [q[0] * cos - q[1] * sin, q[0] * sin + q[1] * cos];
        GlassShape {
            center: [origin[0] + turned[0] * s + shift[0], origin[1] + turned[1] * s + shift[1]],
            half: [self.half[0] * s, self.half[1] * s],
            radius: self.radius * s,
            rotation: self.rotation + angle,
        }
    }
}

fn glass_thickness() -> f32 {
    40.0
}
fn glass_bevel() -> f32 {
    60.0
}
fn glass_blur() -> f32 {
    12.0
}
fn glass_ior() -> f32 {
    1.5
}
fn glass_specular() -> f32 {
    1.0
}

#[derive(Debug, Clone, PartialEq)]
pub struct DrawFx {
    pub items: Vec<crate::DrawItem>,
    pub effects: Vec<DrawEffect>,
    pub blend: BlendMode,
    pub matte: Option<(Vec<crate::DrawItem>, MatteMode)>,
    /// Motion blur: the layer at other instants of the shutter, averaged with `items`.
    pub samples: Vec<Vec<crate::DrawItem>>,
    /// Adjustment layer: the effects apply to everything drawn below, inside the matte.
    pub adjust: bool,
    /// 3D layer: the flat result is projected through this inverse homography (row-major, scene
    /// px of the screen -> scene px of the flat layer).
    pub perspective: Option<[f32; 9]>,
    /// Tilted plane: the flat space its offscreen pass covers starts here (scene px). The plane
    /// is drawn shifted by −origin, so content up to half a frame from the plane's center is never
    /// cut at the scene edges. `[0, 0]` for everything else.
    pub plane_origin: [f32; 2],
}

/// Camera distance (px) for 3D layers when none is given: a natural, slightly wide lens.
pub const DEFAULT_PERSPECTIVE: f32 = 1800.0;

/// Largest side (px) of a tilted plane's flat window: the texture limit most GPUs share.
pub const PLANE_WINDOW_MAX: f32 = 4096.0;

/// Flat window (px) of a tilted plane's offscreen pass: twice the frame in each direction, capped,
/// centered on the plane. Content inside it paints at any camera position.
pub fn plane_window(frame: [f32; 2]) -> [f32; 2] {
    [(frame[0] * 2.0).min(PLANE_WINDOW_MAX), (frame[1] * 2.0).min(PLANE_WINDOW_MAX)]
}

/// The 2.5D camera for one frame: it looks at `look` (scene px) from `focal` px in front of the
/// depth-0 plane, moved forward by `dolly`; `screen` is where `look` lands (the frame center).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    pub look: [f32; 2],
    pub dolly: f32,
    pub focal: f32,
    pub screen: [f32; 2],
    /// Camera roll (radians, clockwise like layer rotation): the picture turns the other way,
    /// around `screen`.
    pub roll: f32,
}

impl View {
    /// A lens centered on `center` that does not move or roll (no camera layer, fixed layers,
    /// planes without a camera).
    pub fn still(center: [f32; 2], focal: f32) -> View {
        View { look: center, dolly: 0.0, focal, screen: center, roll: 0.0 }
    }

    /// Screen scale of a plane at depth `z` (`None` when it is behind the camera).
    pub fn scale_at(&self, z: f32) -> Option<f32> {
        let d = self.focal + z - self.dolly;
        (d > 1.0).then(|| self.focal / d)
    }

    /// Where a flat point drawn at depth scale `k` lands: `screen + rot(p − look, −roll) × k`.
    pub fn place(&self, p: [f32; 2], k: f32) -> [f32; 2] {
        let (s, c) = self.roll.sin_cos();
        let [dx, dy] = [p[0] - self.look[0], p[1] - self.look[1]];
        [self.screen[0] + (dx * c + dy * s) * k, self.screen[1] + (dy * c - dx * s) * k]
    }
}

/// Inverse homography (screen px -> flat layer px) of a flat layer centered at `center`, at depth
/// `z`, rotated `rx` (top leans back) and `ry` (right side goes away) degrees, seen through `view`.
pub fn perspective_inverse(center: [f32; 2], rx: f32, ry: f32, z: f32, view: &View) -> Option<[f32; 9]> {
    let m = perspective_forward(center, rx, ry, z, view);
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-9 {
        return None;
    }
    Some([
        (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det,
        -(m[0][1] * m[2][2] - m[0][2] * m[2][1]) / det,
        (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det,
        -(m[1][0] * m[2][2] - m[1][2] * m[2][0]) / det,
        (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det,
        -(m[0][0] * m[1][2] - m[0][2] * m[1][0]) / det,
        (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det,
        -(m[0][0] * m[2][1] - m[0][1] * m[2][0]) / det,
        (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det,
    ])
}

/// Forward homography (flat layer px -> screen px) of the same projection, rows of a 3×3 matrix.
pub fn perspective_forward(center: [f32; 2], rx: f32, ry: f32, z: f32, view: &View) -> [[f32; 3]; 3] {
    let (sa, ca) = rx.to_radians().sin_cos();
    let (sb, cb) = ry.to_radians().sin_cos();
    let f = view.focal.max(1.0);
    let [cx, cy] = center;
    let [lx, ly] = view.look;
    let [sx, sy] = view.screen;
    let depth = f + z - view.dolly;
    // Columns of the rotation applied to (x, y, 0) relative to the center.
    let (r00, r01, r10, r11, r20, r21) = (cb, sa * sb, 0.0, ca, sb, -sa * cb);
    // Forward map for (x - cx, y - cy, 1), then shifted to take plain (x, y, 1).
    let h = [
        [sx * r20 + f * r00, sx * r21 + f * r01, sx * depth + f * (cx - lx)],
        [sy * r20 + f * r10, sy * r21 + f * r11, sy * depth + f * (cy - ly)],
        [r20, r21, depth],
    ];
    let m: [[f32; 3]; 3] = std::array::from_fn(|r| [h[r][0], h[r][1], h[r][2] - h[r][0] * cx - h[r][1] * cy]);
    if view.roll == 0.0 {
        return m;
    }
    // Camera roll: the projected picture turns by −roll around the screen center
    // (`screen' = S + rot(screen − S, −roll)`), the same map `View::place` applies to flat layers.
    let (s, c) = view.roll.sin_cos();
    let roll = [[c, s, sx - c * sx - s * sy], [-s, c, sy + s * sx - c * sy], [0.0, 0.0, 1.0]];
    std::array::from_fn(|r| std::array::from_fn(|col| (0..3).map(|k| roll[r][k] * m[k][col]).sum()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(h: &[f32; 9], p: [f32; 2]) -> [f32; 2] {
        let w = h[6] * p[0] + h[7] * p[1] + h[8];
        [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w]
    }

    fn forward(h: &[[f32; 3]; 3], p: [f32; 2]) -> [f32; 2] {
        let w = h[2][0] * p[0] + h[2][1] * p[1] + h[2][2];
        [(h[0][0] * p[0] + h[0][1] * p[1] + h[0][2]) / w, (h[1][0] * p[0] + h[1][1] * p[1] + h[1][2]) / w]
    }

    #[test]
    fn roll_turns_plane_corners_around_the_frame_center() {
        let still = View::still([500.0, 400.0], 1800.0);
        let rolled = View { look: [600.0, 400.0], roll: 30f32.to_radians(), ..still };
        let unrolled = View { roll: 0.0, ..rolled };
        let flat = perspective_forward([700.0, 500.0], 40.0, -20.0, 300.0, &unrolled);
        let roll = perspective_forward([700.0, 500.0], 40.0, -20.0, 300.0, &rolled);
        let inv = perspective_inverse([700.0, 500.0], 40.0, -20.0, 300.0, &rolled).unwrap();
        for corner in [[600.0, 450.0], [800.0, 450.0], [800.0, 550.0], [600.0, 550.0]] {
            let a = forward(&flat, corner);
            let b = forward(&roll, corner);
            // Same distance from the frame center, turned 30° counter-clockwise (y down).
            let (da, db) = ([a[0] - 500.0, a[1] - 400.0], [b[0] - 500.0, b[1] - 400.0]);
            assert!((da[0].hypot(da[1]) - db[0].hypot(db[1])).abs() < 1e-2, "{a:?} {b:?}");
            let turned = (db[1].atan2(db[0]) - da[1].atan2(da[0])).to_degrees();
            assert!((turned.rem_euclid(360.0) - 330.0).abs() < 1e-2, "{turned}");
            // The inverse used to draw maps the rolled corner back onto the flat layer.
            let back = apply(&inv, b);
            assert!((back[0] - corner[0]).abs() < 1e-2 && (back[1] - corner[1]).abs() < 1e-2, "{back:?}");
        }
        // A flat point (no tilt) goes where `View::place` puts it.
        let k = rolled.scale_at(300.0).unwrap();
        let plain = perspective_forward([700.0, 500.0], 0.0, 0.0, 300.0, &rolled);
        let (p, q) = (forward(&plain, [650.0, 520.0]), rolled.place([650.0, 520.0], k));
        assert!((p[0] - q[0]).abs() < 1e-2 && (p[1] - q[1]).abs() < 1e-2, "{p:?} {q:?}");
    }

    #[test]
    fn perspective_keeps_the_center_and_shrinks_the_far_edge() {
        let view = View::still([500.0, 400.0], 1800.0);
        let inv = perspective_inverse([500.0, 400.0], 50.0, 0.0, 0.0, &view).unwrap();
        let c = apply(&inv, [500.0, 400.0]);
        assert!((c[0] - 500.0).abs() < 1e-2 && (c[1] - 400.0).abs() < 1e-2, "{c:?}");
        // The top leans back: a screen point near the top maps to a flat point further out
        // (the far half is squeezed), the bottom to one closer in.
        let top = apply(&inv, [500.0, 300.0]);
        let bottom = apply(&inv, [500.0, 500.0]);
        assert!(400.0 - top[1] > bottom[1] - 400.0, "{top:?} {bottom:?}");
        // Pushed away = smaller on screen = a screen offset covers more of the flat layer.
        let far = perspective_inverse([500.0, 400.0], 0.0, 0.0, 1800.0, &view).unwrap();
        assert!((apply(&far, [600.0, 400.0])[0] - 700.0).abs() < 1e-2);
        // A layer off the camera axis is seen from the camera, not from its own center.
        let side = perspective_inverse([900.0, 400.0], 0.0, 0.0, 1800.0, &view).unwrap();
        assert!((apply(&side, [700.0, 400.0])[0] - 900.0).abs() < 1e-2);
    }

    #[test]
    fn blend_modes_parse_by_name_and_ids_match_the_shader() {
        let all = [
            "normal", "add", "screen", "multiply", "darken", "lighten", "difference", "exclusion", "overlay", "soft_light",
            "hard_light", "color_dodge", "color_burn", "linear_burn", "hue", "saturation", "color", "luminosity",
        ];
        let mut ids = Vec::new();
        for name in all {
            let mode: BlendMode = serde_json::from_str(&format!("\"{name}\"")).unwrap_or_else(|e| panic!("{name}: {e}"));
            if mode.reads_backdrop() {
                ids.push(mode.shader_id() as u32);
            }
        }
        // fx.wgsl's `blend_color` switch covers 4..=17 with no gaps or repeats.
        assert_eq!(ids, (4..=17).collect::<Vec<u32>>());
        assert!(serde_json::from_str::<BlendMode>("\"dissolve\"").is_err());
    }

    #[test]
    fn glow_threshold_defaults_to_everything_glowing() {
        let plain: Effect = serde_json::from_str(r#"{"fx":"glow","radius":40}"#).unwrap();
        let bloom: Effect = serde_json::from_str(r#"{"fx":"glow","radius":40,"threshold":0.7}"#).unwrap();
        assert!(matches!(plain, Effect::Glow { threshold, .. } if threshold == 0.0));
        assert!(matches!(bloom, Effect::Glow { threshold, .. } if threshold == 0.7));
    }

}

/// One stroked/filled vector path for one frame, already flattened to polylines in scene pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawPath {
    /// Each subpath as a polyline (trimmed).
    pub lines: Vec<Vec<[f32; 2]>>,
    /// Closed untrimmed subpaths to fill, as polygons.
    pub fills: Vec<Vec<[f32; 2]>>,
    pub fill: Option<Rgba>,
    /// Nonzero winding for `fills` (false = even-odd).
    pub nonzero: bool,
    pub stroke: Option<(f32, Rgba)>,
    /// Stroke color varying along the path (start, end).
    pub stroke_end: Option<Rgba>,
    pub dash: Option<[f32; 2]>,
    /// Bounding box of the untrimmed geometry, for gradients and hit-tests.
    pub bounds: ([f32; 2], [f32; 2]),
    pub gradient: Option<DrawGradient>,

}
