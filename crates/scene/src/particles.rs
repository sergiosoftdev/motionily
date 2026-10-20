//! Particle systems (`"type":"particles"`): an emitter layer whose particles are a pure function
//! of time, like Trapcode Particular but seekable.
//!
//! Nothing is carried from one frame to the next, so any frame renders in any order (export seeks,
//! motion blur samples sub-frames) and always looks the same:
//! - births: the stream's cumulative count E(s) = ∫ rate is integrated on a fixed grid from the
//!   emission start (closed form for a constant rate); particle k is born when E passes k. Bursts
//!   add `count` particles at their `at`.
//! - traits: every random value of particle k comes from a hash of (seed, stream, k), drawn in a
//!   fixed order, so changing one setting never reshuffles the others.
//! - motion: closed form from the birth — gravity + linear drag, a wind drift, plus a bounded
//!   noise displacement (`wander`) sampled from a field shared by every particle.
//!
//! Particles resolve to ordinary draw items (shapes, paths, images) in one group, so effects,
//! blend modes, mattes, motion blur, camera depth and tilted planes apply unchanged, and runs of
//! shapes draw as one instanced call.

use crate::layer::{EvalCtx, Layer, PathData, Xform};
use crate::paint::{DrawGradient, DrawPath, GradientKind, ShapeStyle, MAX_STOPS};
use crate::path::Polyline;
use crate::{Animated, Bounds, ColorRef, DrawImage, DrawItem, DrawShape, ImageFit, Palette, Rgba};
use serde::{Deserialize, Serialize};

/// Live particles per layer never exceed this (preview stays smooth).
pub const MAX_PARTICLES: u32 = 2000;
/// `max` when not given.
const DEFAULT_MAX: u32 = 1000;
/// Grid (s) on which an animated rate is integrated, starting at the emission start.
const EMIT_STEP: f64 = 1.0 / 60.0;
/// Highest rate (particles/s); higher values are clamped.
pub const MAX_RATE: f32 = 20_000.0;
/// Shortest lifetime (s); shorter values are raised to it.
pub const MIN_LIFE: f32 = 0.05;
/// Births examined per frame at most (newest kept), whatever rate × life asks for.
const MAX_SCAN: usize = 60_000;
/// Path/icon particles are outlined like Lucide icons: 2 px at 24 px.
const PATH_STROKE: f32 = 2.0 / 24.0;
/// Narrowest a flipping particle gets (fraction of its width), so edge-on paper stays visible.
const FLIP_MIN: f32 = 0.08;
/// The back side of a flipping particle is drawn at this brightness.
const FLIP_BACK_SHADE: f32 = 0.8;
/// Time step (s) used to measure the travel direction (`align`).
const ALIGN_DT: f32 = 1.0 / 120.0;
/// Box (px) reported for a point emitter with nothing alive.
const EMITTER_MIN_BOX: f32 = 8.0;
/// Particles fainter or smaller than this are not drawn (still counted as live).
const MIN_ALPHA: f32 = 0.002;
const MIN_SIZE: f32 = 0.05;
/// Where the streak's tail fade reaches full color (0..1 from tail to head).
const STREAK_SOLID_FROM: f32 = 0.8;
/// Second octave of the wander field: relative frequency and weight.
const WANDER_OCTAVE: f32 = 2.03;
const WANDER_OCTAVE_WEIGHT: f32 = 0.5;

/// Where particles are born.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmitShape {
    /// The layer's position.
    #[default]
    Point,
    /// A horizontal segment `w` long, centered on the position (turned by the layer rotation).
    Line,
    /// The `w`×`h` box (inside, or its outline with `edge`).
    Rect,
    /// The ellipse inscribed in `w`×`h` (inside, or its outline with `edge`).
    Circle,
    /// Along `emit_d` (SVG path relative to the position), uniformly by length.
    Path,
}

/// What each particle looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Look {
    Circle,
    Rect,
    /// A capsule from where the particle was `trail` seconds ago to where it is, fading to its
    /// tail (sparks, speed lines, rain).
    Streak,
    /// `d` (an SVG path or a Lucide icon) fitted into the particle size.
    Path,
    /// The picture `src`, contained in the particle box.
    Image,
}

/// Which frame particles live in once born.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Space {
    /// Born where the emitter was at that moment and left there: a moving emitter leaves a trail.
    /// Gravity and wind are screen directions (the parent's space when parented).
    #[default]
    World,
    /// Carried by the emitter: moving/rotating/scaling the layer moves every particle, and
    /// gravity/wind turn with it.
    Local,
}

/// A number, or `[min, max]`: every particle draws its own value uniformly in the range.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Vary {
    Fixed(f32),
    Between([f32; 2]),
}

impl Vary {
    fn pick(self, u: f32) -> f32 {
        match self {
            Vary::Fixed(v) => v,
            Vary::Between([a, b]) => a + (b - a) * u,
        }
    }

    fn max(self) -> f32 {
        match self {
            Vary::Fixed(v) => v,
            Vary::Between([a, b]) => a.max(b),
        }
    }

    fn is(&self, v: f32) -> bool {
        *self == Vary::Fixed(v)
    }
}

/// A value over a particle's life: a number, or keys `[[age, value], …]` over its normalized age
/// (0 = born, 1 = dies), linear between keys and held before the first / after the last.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OverLife {
    Fixed(f32),
    Keys(Vec<[f32; 2]>),
}

impl<'de> Deserialize<'de> for OverLife {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Fixed(f32),
            Keys(Vec<[f32; 2]>),
        }
        Ok(match Raw::deserialize(d)? {
            Raw::Fixed(v) => OverLife::Fixed(v),
            Raw::Keys(mut keys) => {
                if keys.is_empty() {
                    return Err(serde::de::Error::custom("over-life keys need at least one [age, value]"));
                }
                keys.sort_by(|a, b| a[0].total_cmp(&b[0]));
                OverLife::Keys(keys)
            }
        })
    }
}

impl OverLife {
    pub fn at(&self, age: f32) -> f32 {
        let keys = match self {
            OverLife::Fixed(v) => return *v,
            OverLife::Keys(k) => k,
        };
        let (Some(first), Some(last)) = (keys.first(), keys.last()) else { return 0.0 };
        if age <= first[0] {
            return first[1];
        }
        if age >= last[0] {
            return last[1];
        }
        let i = keys.partition_point(|k| k[0] <= age);
        let (a, b) = (keys[i - 1], keys[i]);
        a[1] + (b[1] - a[1]) * (age - a[0]) / (b[0] - a[0]).max(f32::EPSILON)
    }
}

/// `{"at":1.2,"count":150}`: `count` particles born together at `at` (seconds from the layer start).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Burst {
    pub at: f32,
    pub count: u32,
}

/// Turbulence: each particle is pushed off its path by a smooth noise field that every particle
/// shares (neighbours swirl together). Offset = `amount` × (n(now) − n(birth)), n ∈ [−1, 1]² per
/// axis, sampled at the particle's undisturbed position / `size` and at time × `speed`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Wander {
    /// px.
    pub amount: f32,
    /// px per noise cell (bigger = broader, lazier swirls).
    #[serde(default = "wander_size")]
    pub size: f32,
    /// How fast the field itself changes (1 ≈ a new pattern every second).
    #[serde(default = "one")]
    pub speed: f32,
}

fn wander_size() -> f32 {
    200.0
}

/// A particle emitter. Units: px, seconds, degrees (0 = right, 90 = down, −90 = up).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Particles {
    #[serde(default, skip_serializing_if = "is_default")]
    pub emit: EmitShape,
    /// Path the `path` emitter uses (relative to the layer position).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emit_d: Option<PathData>,
    /// Rect/circle emitters: born on the outline instead of inside.
    #[serde(default, skip_serializing_if = "is_default")]
    pub edge: bool,
    /// Aim away from the emitter (rect/circle: from its center; line/path: along the normal,
    /// the direction 90° counter-clockwise from the path's travel) instead of `direction`.
    #[serde(default, skip_serializing_if = "is_default")]
    pub outward: bool,
    /// Path emitter: every particle rides the path from its start (age 0) to its end (death).
    #[serde(default, skip_serializing_if = "is_default")]
    pub follow: bool,
    #[serde(default, skip_serializing_if = "is_default")]
    pub space: Space,
    /// Particles per second (animatable, over layer time).
    #[serde(default, skip_serializing_if = "is_zero_anim")]
    pub rate: Animated,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bursts: Vec<Burst>,
    /// Seconds the stream has already been running at the layer start (snow already falling).
    #[serde(default, skip_serializing_if = "is_default")]
    pub prewarm: f32,
    /// Lifetime (s).
    #[serde(default = "default_life", skip_serializing_if = "is_default_life")]
    pub life: Vary,
    /// Initial speed (px/s).
    #[serde(default = "default_speed", skip_serializing_if = "is_default_speed")]
    pub speed: Vary,
    /// Emission direction (degrees).
    #[serde(default = "default_direction", skip_serializing_if = "is_default_direction")]
    pub direction: f32,
    /// Full width of the emission cone (degrees): directions are uniform in direction ± spread/2.
    #[serde(default = "default_spread", skip_serializing_if = "is_default_spread")]
    pub spread: f32,
    /// Constant acceleration (px/s²), e.g. `[0, 900]` falls.
    #[serde(default, skip_serializing_if = "is_default")]
    pub gravity: [f32; 2],
    /// Linear drag (1/s): speed decays by e^(−drag·age); with gravity, terminal velocity = g/drag.
    #[serde(default, skip_serializing_if = "is_default")]
    pub drag: f32,
    /// Constant drift (px/s) added to every particle's motion (air carrying them).
    #[serde(default, skip_serializing_if = "is_default")]
    pub wind: [f32; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wander: Option<Wander>,
    /// Initial rotation of each particle (degrees).
    #[serde(default = "zero_vary", skip_serializing_if = "is_zero_vary")]
    pub angle: Vary,
    /// Rotation speed (degrees/s).
    #[serde(default = "zero_vary", skip_serializing_if = "is_zero_vary")]
    pub spin: Vary,
    /// Paper flip (turns/s): the particle's width × |cos(2π(flip·age + phase))|, back side darker.
    #[serde(default = "zero_vary", skip_serializing_if = "is_zero_vary")]
    pub flip: Vary,
    /// Turn each particle to its direction of travel (plus `angle` and `spin`).
    #[serde(default, skip_serializing_if = "is_default")]
    pub align: bool,
    /// Missing: `path` when `d` is set, `image` when `src` is set, else `circle`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look: Option<Look>,
    /// Particle shape for the `path` look (any size: it is fitted to the particle size).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub d: Option<PathData>,
    /// Lucide icon `d` came from (reads back as `ic=NAME`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Path look: fill closed subpaths instead of outlining.
    #[serde(default, skip_serializing_if = "is_default")]
    pub filled: bool,
    /// Picture for the `image` look.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    /// Height / width of rect and image particles.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub aspect: f32,
    /// Size over life (px): circle diameter, rect/image width, path larger side, streak thickness.
    #[serde(default = "default_size", skip_serializing_if = "is_default_size")]
    pub size: OverLife,
    /// Each particle's size × a factor uniform in [1 − size_var, 1 + size_var].
    #[serde(default, skip_serializing_if = "is_default")]
    pub size_var: f32,
    /// Opacity over life (0..1), times the layer opacity.
    #[serde(default = "default_alpha", skip_serializing_if = "is_default_alpha")]
    pub alpha: OverLife,
    /// Each particle picks one of these at random (empty: the layer fill).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub colors: Vec<ColorRef>,
    /// Color over life `[[age, color], …]`; replaces the picked color when set.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub color_life: Vec<(f32, ColorRef)>,
    /// Streak look: how far back (s) the tail reaches.
    #[serde(default = "default_trail", skip_serializing_if = "is_default_trail")]
    pub trail: f32,
    #[serde(default, skip_serializing_if = "is_default")]
    pub seed: u32,
    /// Live particles cap (1..2000); beyond it the oldest are not drawn.
    #[serde(default = "default_max", skip_serializing_if = "is_default_max")]
    pub max: u32,
}

fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}
fn one() -> f32 {
    1.0
}
fn is_one(v: &f32) -> bool {
    *v == 1.0
}
fn is_zero_anim(a: &Animated) -> bool {
    *a == Animated::Static(0.0)
}
fn zero_vary() -> Vary {
    Vary::Fixed(0.0)
}
fn is_zero_vary(v: &Vary) -> bool {
    v.is(0.0)
}
const DEFAULT_LIFE: f32 = 2.0;
fn default_life() -> Vary {
    Vary::Fixed(DEFAULT_LIFE)
}
fn is_default_life(v: &Vary) -> bool {
    v.is(DEFAULT_LIFE)
}
const DEFAULT_SPEED: f32 = 200.0;
fn default_speed() -> Vary {
    Vary::Fixed(DEFAULT_SPEED)
}
fn is_default_speed(v: &Vary) -> bool {
    v.is(DEFAULT_SPEED)
}
const DEFAULT_DIRECTION: f32 = -90.0;
fn default_direction() -> f32 {
    DEFAULT_DIRECTION
}
fn is_default_direction(v: &f32) -> bool {
    *v == DEFAULT_DIRECTION
}
const DEFAULT_SPREAD: f32 = 30.0;
fn default_spread() -> f32 {
    DEFAULT_SPREAD
}
fn is_default_spread(v: &f32) -> bool {
    *v == DEFAULT_SPREAD
}
const DEFAULT_SIZE: f32 = 12.0;
fn default_size() -> OverLife {
    OverLife::Fixed(DEFAULT_SIZE)
}
fn is_default_size(v: &OverLife) -> bool {
    *v == default_size()
}
/// Quick fade in, hold, fade out over the last 30% of the life (no popping).
const DEFAULT_ALPHA: [[f32; 2]; 4] = [[0.0, 0.0], [0.05, 1.0], [0.7, 1.0], [1.0, 0.0]];
fn default_alpha() -> OverLife {
    OverLife::Keys(DEFAULT_ALPHA.to_vec())
}
fn is_default_alpha(v: &OverLife) -> bool {
    *v == default_alpha()
}
const DEFAULT_TRAIL: f32 = 0.04;
fn default_trail() -> f32 {
    DEFAULT_TRAIL
}
fn is_default_trail(v: &f32) -> bool {
    *v == DEFAULT_TRAIL
}
fn default_max() -> u32 {
    DEFAULT_MAX
}
fn is_default_max(v: &u32) -> bool {
    *v == DEFAULT_MAX
}

impl Particles {
    /// The look actually drawn.
    pub fn look(&self) -> Look {
        self.look.unwrap_or(if self.d.is_some() {
            Look::Path
        } else if self.src.is_some() {
            Look::Image
        } else {
            Look::Circle
        })
    }

    /// The cap in force (1..=MAX_PARTICLES).
    pub fn cap(&self) -> u32 {
        self.max.clamp(1, MAX_PARTICLES)
    }

    /// Short description for summaries.
    pub fn describe(&self) -> String {
        let rate = match &self.rate {
            Animated::Static(r) => format!("{r}/s"),
            _ => "animated rate".into(),
        };
        format!("particles {} {} {} bursts look={}", crate::enum_name(&self.emit), rate, self.bursts.len(), crate::enum_name(&self.look()))
    }
}

/// Where the emitter is at one instant: center (scene px), rotation (rad), total scale.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Place {
    center: [f32; 2],
    rotation: f32,
    scale: f32,
}

impl Place {
    fn map(&self, q: [f32; 2]) -> [f32; 2] {
        let r = rot([q[0] * self.scale, q[1] * self.scale], self.rotation);
        [self.center[0] + r[0], self.center[1] + r[1]]
    }
}

/// The layer's paint for this frame, shared by every particle (sizes not yet scaled).
pub(crate) struct Paint {
    /// Layer fill (without the layer opacity): the color when `colors` and `color_life` are empty.
    pub fill: Rgba,
    pub opacity: f32,
    pub gradient: Option<DrawGradient>,
    /// Outline width (px, unscaled) and color, for circle/rect particles.
    pub stroke: Option<(f32, Rgba)>,
    pub soft: f32,
    pub radius: f32,
}

/// One live particle at one instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Particle {
    pub pos: [f32; 2],
    /// Where it was `trail` seconds ago (streaks).
    pub tail: [f32; 2],
    /// Radians.
    pub rotation: f32,
    /// px, scaled.
    pub size: f32,
    /// Width factor from flipping (1 = flat to the screen).
    pub width: f32,
    /// Alpha included.
    pub color: Rgba,
    /// What scales its outline, softness and corner radius.
    pub scale: f32,
    /// Normalized age 0..1.
    pub age: f32,
}

/// A birth: which stream (0 = rate, 1 + i = burst i), which particle of it, when (layer time).
#[derive(Debug, Clone, Copy)]
struct Birth {
    stream: u32,
    index: u64,
    at: f32,
}

/// Deterministic random numbers for one particle (SplitMix64).
struct Rng(u64);

impl Rng {
    fn new(seed: u32, stream: u32, index: u64) -> Rng {
        let mut r = Rng(((seed as u64) << 32 | stream as u64) ^ index.wrapping_mul(0xD1B5_4A32_D192_ED03));
        r.next_u64();
        r
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    fn next(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// The random traits of one particle, drawn in a fixed order (adding a setting never reshuffles
/// the others).
struct Traits {
    life: f32,
    at: [f32; 2],
    dir: f32,
    speed: f32,
    angle: f32,
    spin: f32,
    flip: f32,
    flip_phase: f32,
    size: f32,
    pick: f32,
}

impl Traits {
    fn draw(p: &Particles, b: &Birth) -> Traits {
        let mut r = Rng::new(p.seed, b.stream, b.index);
        let mut u = || r.next();
        Traits {
            life: p.life.pick(u()).max(MIN_LIFE),
            at: [u(), u()],
            dir: u(),
            speed: p.speed.pick(u()),
            angle: p.angle.pick(u()),
            spin: p.spin.pick(u()),
            flip: p.flip.pick(u()),
            flip_phase: u(),
            size: 1.0 + (u() - 0.5) * 2.0 * p.size_var.clamp(0.0, 1.0),
            pick: u(),
        }
    }
}

/// The stream's cumulative count E(s) from the emission start `s0`.
enum Emission {
    None,
    /// Constant rate: E(s) = rate · (s − s0).
    Constant { s0: f64, rate: f64 },
    /// E at s0 + j·EMIT_STEP for j = 0..; midpoint-integrated (rate clamped to 0..MAX_RATE).
    Grid { s0: f64, cum: Vec<f64> },
}

impl Emission {
    fn new(rate: &Animated, prewarm: f32, until: f32) -> Emission {
        let s0 = -(prewarm.max(0.0) as f64);
        match rate {
            Animated::Static(r) if *r <= 0.0 => Emission::None,
            Animated::Static(r) => Emission::Constant { s0, rate: r.min(MAX_RATE) as f64 },
            _ => {
                let steps = ((until as f64 - s0) / EMIT_STEP).ceil().max(0.0) as usize + 1;
                let mut cum = Vec::with_capacity(steps + 1);
                let mut e = 0.0f64;
                cum.push(e);
                for j in 0..steps {
                    let mid = s0 + (j as f64 + 0.5) * EMIT_STEP;
                    e += rate.sample(mid as f32).clamp(0.0, MAX_RATE) as f64 * EMIT_STEP;
                    cum.push(e);
                }
                Emission::Grid { s0, cum }
            }
        }
    }

    /// Stream births in `[lo, hi]`, newest first, at most `limit`.
    fn births(&self, lo: f32, hi: f32, limit: usize, out: &mut Vec<Birth>) {
        let (lo, hi) = (lo as f64, hi as f64);
        match self {
            Emission::None => {}
            Emission::Constant { s0, rate } => {
                if hi < *s0 {
                    return;
                }
                // Particle k is born when E reaches k: at s0 + k/rate (born at `hi` = age 0, alive).
                let k_hi = ((hi - s0) * rate).floor() as i64;
                let k_lo = (((lo - s0) * rate).ceil() as i64).max(0);
                let mut k = k_hi;
                while k >= k_lo && out.len() < limit {
                    out.push(Birth { stream: 0, index: k as u64, at: (s0 + k as f64 / rate) as f32 });
                    k -= 1;
                }
            }
            Emission::Grid { s0, cum } => {
                if hi < *s0 || cum.len() < 2 {
                    return;
                }
                let j_hi = (((hi - s0) / EMIT_STEP).floor() as usize).min(cum.len() - 2);
                let j_lo = ((lo - s0) / EMIT_STEP).floor().max(0.0) as usize;
                for j in (j_lo..=j_hi).rev() {
                    let (e0, e1) = (cum[j], cum[j + 1]);
                    if e1 <= e0 {
                        continue;
                    }
                    let mut k = e1.ceil() as i64 - 1;
                    while k as f64 >= e0 {
                        let at = s0 + EMIT_STEP * (j as f64 + (k as f64 - e0) / (e1 - e0));
                        if at <= hi && at >= lo {
                            out.push(Birth { stream: 0, index: k as u64, at: at as f32 });
                            if out.len() >= limit {
                                return;
                            }
                        }
                        k -= 1;
                    }
                }
            }
        }
    }
}

/// Uniform sampling by length along flattened subpaths.
struct PathSampler {
    /// (start, end, length before this segment).
    segs: Vec<([f32; 2], [f32; 2], f32)>,
    total: f32,
}

impl PathSampler {
    fn new(lines: &[Polyline]) -> Option<PathSampler> {
        let mut segs = Vec::new();
        let mut total = 0.0;
        for l in lines {
            for w in l.points.windows(2) {
                let len = dist(w[0], w[1]);
                if len > 0.0 {
                    segs.push((w[0], w[1], total));
                    total += len;
                }
            }
        }
        let first = lines.iter().find_map(|l| l.points.first().copied());
        if segs.is_empty() {
            // A single point still emits.
            let p = first?;
            return Some(PathSampler { segs: vec![(p, p, 0.0)], total: 0.0 });
        }
        Some(PathSampler { segs, total })
    }

    /// Point and travel direction (rad) at `u` (0..1 of the length).
    fn at(&self, u: f32) -> ([f32; 2], f32) {
        let s = u.clamp(0.0, 1.0) * self.total;
        let i = self.segs.partition_point(|seg| seg.2 <= s).saturating_sub(1);
        let (a, b, before) = self.segs[i];
        let len = dist(a, b);
        let k = if len > 0.0 { ((s - before) / len).clamp(0.0, 1.0) } else { 0.0 };
        ([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], (b[1] - a[1]).atan2(b[0] - a[0]))
    }
}

/// Everything resolved once per frame for one particle layer.
struct Frame<'a> {
    layer: &'a Layer,
    p: &'a Particles,
    ctx: &'a EvalCtx<'a>,
    xf: &'a Xform,
    animated: bool,
    lt: f32,
    now: Place,
    /// The placement when it does not change over time (skips re-evaluating it per particle).
    fixed: Option<Place>,
    emit_path: Option<PathSampler>,
    /// Layer fill: the color when `colors` and `color_life` are empty.
    fill: Rgba,
}

impl<'a> Frame<'a> {
    fn new(layer: &'a Layer, p: &'a Particles, lt: f32, ctx: &'a EvalCtx<'a>, xf: &'a Xform, animated: bool, fill: Rgba) -> Frame<'a> {
        let now = place(layer, lt, ctx, xf, animated);
        let still = [&layer.x, &layer.y, &layer.scale, &layer.rotation].iter().all(|a| matches!(a, Animated::Static(_)))
            && layer.motion_path.is_none()
            && (!animated || layer.anims.is_empty());
        let emit_path = (p.emit == EmitShape::Path).then(|| p.emit_d.as_ref()?.lines().as_ref().ok().and_then(|l| PathSampler::new(l))).flatten();
        Frame { layer, p, ctx, xf, animated, lt, now, fixed: still.then_some(now), emit_path, fill }
    }

    /// Placement at layer time `at` (the moment a world-space particle was born).
    fn place_at(&self, at: f32) -> Place {
        if let Some(p) = self.fixed {
            return p;
        }
        // Expressions reading scene time `T` see the moment of birth too.
        let gt = crate::expr::scene_time() - (self.lt - at);
        crate::expr::with_scene_time(gt, || place(self.layer, at, self.ctx, self.xf, self.animated))
    }

    /// Birth point (emitter frame, unscaled) and the outward direction (rad) there.
    fn emit_point(&self, at: f32, u: [f32; 2]) -> ([f32; 2], f32) {
        let p = self.p;
        let (w, h) = (self.layer.w.sample(at), self.layer.h.sample(at));
        let from_center = |q: [f32; 2]| if q == [0.0, 0.0] { p.direction.to_radians() } else { q[1].atan2(q[0]) };
        match p.emit {
            EmitShape::Point => ([0.0, 0.0], p.direction.to_radians()),
            EmitShape::Line => ([(u[0] - 0.5) * w, 0.0], -std::f32::consts::FRAC_PI_2),
            EmitShape::Rect if p.edge => {
                // Walk the outline clockwise from the top-left corner.
                let (w, h) = (w.abs(), h.abs());
                let mut s = u[0] * 2.0 * (w + h);
                let (hw, hh) = (w / 2.0, h / 2.0);
                use std::f32::consts::{FRAC_PI_2, PI};
                if s < w {
                    return ([-hw + s, -hh], -FRAC_PI_2);
                }
                s -= w;
                if s < h {
                    return ([hw, -hh + s], 0.0);
                }
                s -= h;
                if s < w {
                    return ([hw - s, hh], FRAC_PI_2);
                }
                s -= w;
                ([-hw, hh - s], PI)
            }
            EmitShape::Rect => {
                let q = [(u[0] - 0.5) * w, (u[1] - 0.5) * h];
                (q, from_center(q))
            }
            EmitShape::Circle => {
                let r = if p.edge { 1.0 } else { u[1].sqrt() };
                let a = u[0] * std::f32::consts::TAU;
                let q = [a.cos() * r * w / 2.0, a.sin() * r * h / 2.0];
                (q, a)
            }
            EmitShape::Path => match &self.emit_path {
                Some(path) => {
                    let (q, tangent) = path.at(u[0]);
                    (q, tangent - std::f32::consts::FRAC_PI_2)
                }
                None => ([0.0, 0.0], p.direction.to_radians()),
            },
        }
    }
}

/// The layer's own placement at layer time `lt`.
fn place(layer: &Layer, lt: f32, ctx: &EvalCtx, xf: &Xform, animated: bool) -> Place {
    let (center, _, rotation, scale) = layer.place(lt, ctx, xf, animated);
    Place { center, rotation, scale }
}

/// Displacement and velocity after `tau` seconds from velocity `v0` under gravity `g` and linear drag `k`.
fn ballistic(v0: [f32; 2], g: [f32; 2], k: f32, tau: f32) -> ([f32; 2], [f32; 2]) {
    if k <= 1e-4 {
        let d = std::array::from_fn(|i| v0[i] * tau + 0.5 * g[i] * tau * tau);
        let v = std::array::from_fn(|i| v0[i] + g[i] * tau);
        return (d, v);
    }
    // dv/dt = g − k·v  →  v = g/k + (v0 − g/k)·e^(−k·τ)
    let decay = (-k * tau).exp();
    let d = std::array::from_fn(|i| {
        let term = g[i] / k;
        term * tau + (v0[i] - term) * (1.0 - decay) / k
    });
    let v = std::array::from_fn(|i| g[i] / k + (v0[i] - g[i] / k) * decay);
    (d, v)
}

/// Integer hash of a lattice point to [−1, 1).
fn lattice(x: i32, y: i32, z: i32, salt: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8DA6_B343) ^ (y as u32).wrapping_mul(0xD816_3841) ^ (z as u32).wrapping_mul(0xCB1A_B31F) ^ salt.wrapping_mul(0x1656_67B1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297A_2D39);
    h ^= h >> 15;
    (h >> 8) as f32 / (1u32 << 23) as f32 - 1.0
}

/// Smooth 3D value noise in [−1, 1].
fn value_noise(p: [f32; 3], salt: u32) -> f32 {
    let i = p.map(|v| v.floor());
    let f: [f32; 3] = std::array::from_fn(|k| p[k] - i[k]);
    // Quintic fade: continuous velocity, so wandering particles never kink.
    let s = f.map(|t| t * t * t * (t * (t * 6.0 - 15.0) + 10.0));
    let [x, y, z] = i.map(|v| v as i32);
    let corner = |dx: i32, dy: i32, dz: i32| lattice(x + dx, y + dy, z + dz, salt);
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), s[0]);
    let x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), s[0]);
    let x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), s[0]);
    let x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), s[0]);
    lerp(lerp(x00, x10, s[1]), lerp(x01, x11, s[1]), s[2])
}

/// The shared wander field: two channels, two octaves, in [−1, 1].
fn field(p: [f32; 3]) -> [f32; 2] {
    let hi = [p[0] * WANDER_OCTAVE + 17.3, p[1] * WANDER_OCTAVE - 9.1, p[2] * WANDER_OCTAVE];
    let norm = 1.0 + WANDER_OCTAVE_WEIGHT;
    [
        (value_noise(p, 1) + WANDER_OCTAVE_WEIGHT * value_noise(hi, 3)) / norm,
        (value_noise(p, 2) + WANDER_OCTAVE_WEIGHT * value_noise(hi, 4)) / norm,
    ]
}

impl Wander {
    /// Offset of a particle whose undisturbed position is `now` at layer time `t`, born at `born`/`t0`.
    fn offset(&self, now: [f32; 2], t: f32, born: [f32; 2], t0: f32) -> [f32; 2] {
        let cell = self.size.max(1.0);
        let a = field([now[0] / cell, now[1] / cell, t * self.speed]);
        let b = field([born[0] / cell, born[1] / cell, t0 * self.speed]);
        [(a[0] - b[0]) * self.amount, (a[1] - b[1]) * self.amount]
    }
}

/// One particle's trajectory: everything fixed at birth.
struct Path1<'a> {
    f: &'a Frame<'a>,
    at: f32,
    life: f32,
    /// Birth point (emitter frame).
    start: [f32; 2],
    v0: [f32; 2],
    gravity: [f32; 2],
    wind: [f32; 2],
    /// Where the particle maps to the screen (birth placement in world space, now in local).
    place: Place,
}

impl Path1<'_> {
    /// Screen position (scene px, before the camera) at age `tau`.
    fn pos(&self, tau: f32) -> [f32; 2] {
        let p = self.f.p;
        let base = |tau: f32| {
            let (d, _) = ballistic(self.v0, self.gravity, p.drag.max(0.0), tau);
            let origin = match (&self.f.emit_path, p.follow) {
                (Some(path), true) => path.at(tau / self.life).0,
                _ => self.start,
            };
            [origin[0] + d[0] + self.wind[0] * tau, origin[1] + d[1] + self.wind[1] * tau]
        };
        let q = base(tau);
        let Some(w) = p.wander.filter(|w| w.amount != 0.0) else { return self.place.map(q) };
        match p.space {
            Space::Local => {
                let q0 = base(0.0);
                let o = w.offset(q, self.at + tau, q0, self.at);
                self.place.map([q[0] + o[0], q[1] + o[1]])
            }
            Space::World => {
                let (world, born) = (self.place.map(q), self.place.map(base(0.0)));
                let o = w.offset(world, self.at + tau, born, self.at);
                [world[0] + o[0] * self.place.scale, world[1] + o[1] * self.place.scale]
            }
        }
    }
}

impl Particles {
    /// Births whose particles may be alive at `lt`, newest first.
    fn candidates(&self, lt: f32) -> Vec<Birth> {
        let longest = self.life.max().max(MIN_LIFE);
        let lo = lt - longest;
        let mut out = Vec::new();
        Emission::new(&self.rate, self.prewarm, lt).births(lo, lt, MAX_SCAN, &mut out);
        for (i, b) in self.bursts.iter().enumerate() {
            if b.at <= lt && b.at >= lo {
                let n = b.count.min(MAX_PARTICLES) as u64;
                out.extend((0..n).map(|k| Birth { stream: 1 + i as u32, index: k, at: b.at }));
            }
        }
        // Newest first; equal times keep the stream before the bursts, then their order.
        out.sort_by(|a, b| b.at.total_cmp(&a.at));
        out
    }

    /// Live particles at layer time `lt`, oldest first (the draw order).
    fn live(&self, f: &Frame) -> Vec<Particle> {
        let lt = f.lt;
        let cap = self.cap() as usize;
        let mut out = Vec::new();
        for b in self.candidates(lt) {
            if out.len() >= cap {
                break;
            }
            let traits = Traits::draw(self, &b);
            let tau = lt - b.at;
            if tau < 0.0 || tau >= traits.life {
                continue;
            }
            out.push(self.particle(f, &b, &traits, tau));
        }
        out.reverse();
        out
    }

    fn particle(&self, f: &Frame, b: &Birth, tr: &Traits, tau: f32) -> Particle {
        let place = match self.space {
            Space::World => f.place_at(b.at),
            Space::Local => f.now,
        };
        let (start, outward) = f.emit_point(b.at, tr.at);
        let base = if self.outward { outward } else { self.direction.to_radians() };
        let dir = base + (tr.dir - 0.5) * self.spread.to_radians();
        let v0 = [dir.cos() * tr.speed, dir.sin() * tr.speed];
        // World space: gravity and wind are screen directions, so undo the emitter's turn.
        let (gravity, wind) = match self.space {
            Space::World => (rot(self.gravity, -place.rotation), rot(self.wind, -place.rotation)),
            Space::Local => (self.gravity, self.wind),
        };
        let path = Path1 { f, at: b.at, life: tr.life, start, v0, gravity, wind, place };
        let pos = path.pos(tau);
        let age = (tau / tr.life).clamp(0.0, 1.0);
        let look = self.look();
        let tail = if look == Look::Streak { path.pos((tau - self.trail.max(0.0)).max(0.0)) } else { pos };
        let own = (tr.angle + tr.spin * tau).to_radians();
        let rotation = if self.align {
            let (a, b) = if tau >= ALIGN_DT { (path.pos(tau - ALIGN_DT), pos) } else { (pos, path.pos(tau + ALIGN_DT)) };
            let travel = if dist(a, b) > 1e-4 { (b[1] - a[1]).atan2(b[0] - a[0]) } else { place.rotation + dir };
            travel + own
        } else {
            place.rotation + own
        };
        let mut width = 1.0;
        let mut back = false;
        if tr.flip != 0.0 {
            let c = (std::f32::consts::TAU * (tr.flip * tau + tr.flip_phase)).cos();
            width = c.abs().max(FLIP_MIN);
            back = c < 0.0;
        }
        let palette = f.ctx.palette;
        let mut color = if !self.color_life.is_empty() {
            color_over_life(&self.color_life, age, palette)
        } else if !self.colors.is_empty() {
            let k = ((tr.pick * self.colors.len() as f32) as usize).min(self.colors.len() - 1);
            self.colors[k].resolve(palette)
        } else {
            f.fill
        };
        if back {
            color.0[..3].iter_mut().for_each(|c| *c *= FLIP_BACK_SHADE);
        }
        Particle {
            pos,
            tail,
            rotation,
            size: (self.size.at(age) * tr.size).max(0.0) * place.scale,
            width,
            color,
            scale: place.scale,
            age,
        }
    }
}

fn color_over_life(keys: &[(f32, ColorRef)], age: f32, palette: &Palette) -> Rgba {
    let (first, last) = (keys[0], keys[keys.len() - 1]);
    if age <= first.0 {
        return first.1.resolve(palette);
    }
    if age >= last.0 {
        return last.1.resolve(palette);
    }
    let i = keys.partition_point(|k| k.0 <= age).clamp(1, keys.len() - 1);
    let (a, b) = (keys[i - 1], keys[i]);
    let u = ((age - a.0) / (b.0 - a.0).max(f32::EPSILON)).clamp(0.0, 1.0);
    let (ca, cb) = (a.1.resolve(palette), b.1.resolve(palette));
    Rgba(std::array::from_fn(|k| ca.0[k] + (cb.0[k] - ca.0[k]) * u))
}

/// A particle path fitted into a unit box (larger side 1, centered), plus its height/width.
struct UnitPath {
    lines: Vec<Polyline>,
}

impl UnitPath {
    fn new(d: &PathData) -> Option<UnitPath> {
        let lines = d.lines().as_ref().ok()?;
        let pts = lines.iter().flat_map(|l| &l.points);
        let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
        for p in pts {
            lo = [lo[0].min(p[0]), lo[1].min(p[1])];
            hi = [hi[0].max(p[0]), hi[1].max(p[1])];
        }
        if lo[0] > hi[0] {
            return None;
        }
        let c = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0];
        let k = 1.0 / (hi[0] - lo[0]).max(hi[1] - lo[1]).max(1e-3);
        let lines = lines
            .iter()
            .map(|l| Polyline { points: l.points.iter().map(|p| [(p[0] - c[0]) * k, (p[1] - c[1]) * k]).collect(), closed: l.closed })
            .collect();
        Some(UnitPath { lines })
    }
}

/// Gradient with every stop's alpha × `a`.
fn faded(g: &DrawGradient, a: f32) -> DrawGradient {
    let mut g = *g;
    g.stops.iter_mut().for_each(|s| s.1 .0[3] *= a);
    g
}

impl Particles {
    /// Draw items for layer time `lt` (empty when nothing is alive or visible).
    pub(crate) fn draw(&self, layer: &Layer, lt: f32, ctx: &EvalCtx, xf: &Xform, animated: bool, paint: &Paint) -> Vec<DrawItem> {
        let f = Frame::new(layer, self, lt, ctx, xf, animated, paint.fill);
        let live = self.live(&f);
        let look = self.look();
        let unit = match look {
            Look::Path => self.d.as_ref().and_then(UnitPath::new),
            _ => None,
        };
        let mut out = Vec::with_capacity(live.len());
        for p in &live {
            let alpha = self.alpha.at(p.age).clamp(0.0, 1.0) * paint.opacity;
            let mut color = p.color;
            color.0[3] *= alpha;
            if color.0[3] <= MIN_ALPHA || p.size <= MIN_SIZE {
                continue;
            }
            let fade = color.0[3];
            let style = |soft: bool| ShapeStyle {
                gradient: paint.gradient.as_ref().map(|g| faded(g, alpha)),
                stroke: paint.stroke.map(|(w, mut c)| {
                    c.0[3] *= alpha;
                    (w * p.scale, c)
                }),
                soft: if soft { paint.soft * p.scale } else { 0.0 },
                ..Default::default()
            };
            match look {
                Look::Circle => {
                    let size = [p.size * p.width, p.size];
                    out.push(DrawItem::Shape(DrawShape { center: p.pos, size, radius: size[0].min(size[1]) / 2.0, rotation: p.rotation, color, style: style(true) }));
                }
                Look::Rect => {
                    let size = [p.size * p.width, p.size * self.aspect];
                    let radius = (paint.radius * p.scale).min(size[0].min(size[1]) / 2.0);
                    out.push(DrawItem::Shape(DrawShape { center: p.pos, size, radius, rotation: p.rotation, color, style: style(true) }));
                }
                Look::Streak => {
                    let d = [p.pos[0] - p.tail[0], p.pos[1] - p.tail[1]];
                    let len = d[0].hypot(d[1]);
                    let rotation = if len > 1e-3 { d[1].atan2(d[0]) } else { p.rotation };
                    let mut st = style(true);
                    if st.gradient.is_none() {
                        // Transparent tail → full color at the head.
                        let mut stops = [(0.0, Rgba([0.0; 4])); MAX_STOPS];
                        let clear = Rgba([color.0[0], color.0[1], color.0[2], 0.0]);
                        stops[0] = (0.0, clear);
                        stops[1] = (STREAK_SOLID_FROM, color);
                        stops[2] = (1.0, color);
                        st.gradient = Some(DrawGradient { kind: GradientKind::Linear, stops, count: 3, angle: 0.0, center: [0.5, 0.5], radius: 1.0 });
                    }
                    out.push(DrawItem::Shape(DrawShape {
                        center: [(p.pos[0] + p.tail[0]) / 2.0, (p.pos[1] + p.tail[1]) / 2.0],
                        size: [len + p.size, p.size],
                        radius: p.size / 2.0,
                        rotation,
                        color,
                        style: st,
                    }));
                }
                Look::Path => {
                    let Some(unit) = &unit else { continue };
                    let (s, c) = p.rotation.sin_cos();
                    let k = [p.size * p.width, p.size];
                    let to_world = |q: &[f32; 2]| {
                        let (x, y) = (q[0] * k[0], q[1] * k[1]);
                        [p.pos[0] + x * c - y * s, p.pos[1] + x * s + y * c]
                    };
                    let lines: Vec<Vec<[f32; 2]>> = unit.lines.iter().map(|l| l.points.iter().map(to_world).collect()).collect();
                    let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
                    for q in lines.iter().flatten() {
                        lo = [lo[0].min(q[0]), lo[1].min(q[1])];
                        hi = [hi[0].max(q[0]), hi[1].max(q[1])];
                    }
                    // Like SVG fills, open subpaths are closed implicitly (most Lucide icons are open).
                    let fills = if self.filled { lines.iter().filter(|l| l.len() > 2).cloned().collect() } else { Vec::new() };
                    out.push(DrawItem::Path(DrawPath {
                        stroke: (!self.filled).then_some((p.size * PATH_STROKE, color)),
                        fill: self.filled.then_some(color),
                        lines: if self.filled { Vec::new() } else { lines },
                        fills,
                        stroke_end: None,
                        dash: None,
                        bounds: (lo, hi),
                        gradient: paint.gradient.as_ref().map(|g| faded(g, alpha)),
                    }));
                }
                Look::Image => {
                    let Some(src) = &self.src else { continue };
                    out.push(DrawItem::Image(DrawImage {
                        src: src.clone(),
                        fit: ImageFit::Contain,
                        center: p.pos,
                        size: [p.size * p.width, p.size * self.aspect],
                        radius: 0.0,
                        rotation: p.rotation,
                        opacity: fade,
                    }));
                }
            }
        }
        out
    }

    /// Screen boxes (upright, flat scene px) of the live particles at `lt`, and the emitter box.
    pub(crate) fn measure(&self, layer: &Layer, lt: f32, ctx: &EvalCtx, xf: &Xform) -> Measured {
        let f = Frame::new(layer, self, lt, ctx, xf, false, Rgba([1.0; 4]));
        let look = self.look();
        let path_aspect = match look {
            Look::Path => self.d.as_ref().and_then(UnitPath::new).map(|u| {
                let ys = u.lines.iter().flat_map(|l| l.points.iter().map(|p| p[1]));
                let (lo, hi) = ys.fold((f32::MAX, f32::MIN), |(lo, hi), y| (lo.min(y), hi.max(y)));
                (hi - lo).max(0.0)
            }),
            _ => None,
        };
        let boxes = self
            .live(&f)
            .iter()
            .map(|p| {
                if look == Look::Streak {
                    let r = p.size / 2.0;
                    return [p.pos[0].min(p.tail[0]) - r, p.pos[1].min(p.tail[1]) - r, p.pos[0].max(p.tail[0]) + r, p.pos[1].max(p.tail[1]) + r];
                }
                let h = match look {
                    Look::Rect | Look::Image => self.aspect,
                    Look::Path => path_aspect.unwrap_or(1.0),
                    _ => 1.0,
                };
                let (w, h) = (p.size * p.width / 2.0, p.size * h / 2.0);
                let (s, c) = p.rotation.sin_cos();
                let (ex, ey) = (w * c.abs() + h * s.abs(), w * s.abs() + h * c.abs());
                [p.pos[0] - ex, p.pos[1] - ey, p.pos[0] + ex, p.pos[1] + ey]
            })
            .collect();
        Measured { boxes, emitter: self.emitter_box(&f), cap: self.cap() }
    }

    /// The emitter's own box now (path: the path's extent; point: a small square).
    fn emitter_box(&self, f: &Frame) -> Bounds {
        let now = f.now;
        let (w, h) = (f.layer.w.sample(f.lt).abs(), f.layer.h.sample(f.lt).abs());
        let size = match self.emit {
            EmitShape::Point => [0.0, 0.0],
            EmitShape::Line => [w, 0.0],
            EmitShape::Rect | EmitShape::Circle => [w, h],
            EmitShape::Path => {
                if let Some(path) = &f.emit_path {
                    let pts: Vec<[f32; 2]> = path.segs.iter().flat_map(|s| [now.map(s.0), now.map(s.1)]).collect();
                    let b = Bounds::enclosing(&pts);
                    return Bounds { size: [b.size[0].max(EMITTER_MIN_BOX), b.size[1].max(EMITTER_MIN_BOX)], ..b };
                }
                [0.0, 0.0]
            }
        };
        Bounds { center: now.center, size: [(size[0] * now.scale).max(EMITTER_MIN_BOX), (size[1] * now.scale).max(EMITTER_MIN_BOX)], rotation: now.rotation }
    }
}

/// What a particle layer covers at one instant.
pub(crate) struct Measured {
    /// `[x0, y0, x1, y1]` per live particle (flat scene px).
    pub boxes: Vec<[f32; 4]>,
    pub emitter: Bounds,
    pub cap: u32,
}

impl Measured {
    /// The live particles' extent, or the emitter box when none is alive.
    pub fn bounds(&self) -> Bounds {
        if self.boxes.is_empty() {
            return self.emitter;
        }
        let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
        for b in &self.boxes {
            lo = [lo[0].min(b[0]), lo[1].min(b[1])];
            hi = [hi[0].max(b[2]), hi[1].max(b[3])];
        }
        Bounds { center: [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0], size: [hi[0] - lo[0], hi[1] - lo[1]], rotation: 0.0 }
    }
}

fn rot(p: [f32; 2], a: f32) -> [f32; 2] {
    let (s, c) = a.sin_cos();
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    (b[0] - a[0]).hypot(b[1] - a[1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Scene;

    fn scene(layers: &[&str]) -> Scene {
        let mut s = Scene::default();
        s.width = 1000;
        s.height = 1000;
        s.duration = 10.0;
        for l in layers {
            s.layers.push(serde_json::from_str(l).unwrap());
        }
        s
    }

    fn items(s: &Scene, t: f32) -> Vec<DrawItem> {
        match s.frame(t).into_iter().next() {
            Some(DrawItem::Group(g)) => g,
            None => Vec::new(),
            Some(other) => panic!("expected a group, got {other:?}"),
        }
    }

    fn centers(s: &Scene, t: f32) -> Vec<[f32; 2]> {
        items(s, t)
            .iter()
            .map(|i| match i {
                DrawItem::Shape(s) => s.center,
                DrawItem::Path(p) => [(p.bounds.0[0] + p.bounds.1[0]) / 2.0, (p.bounds.0[1] + p.bounds.1[1]) / 2.0],
                DrawItem::Image(im) => im.center,
                other => panic!("unexpected {other:?}"),
            })
            .collect()
    }

    /// Live count at `t` as the layout reports it.
    fn live(s: &Scene, id: &str, t: f32) -> u32 {
        s.layout(t).layers.iter().find(|r| r.id == id).and_then(|r| r.particles).map_or(0, |p| p.live)
    }

    const FOUNTAIN: &str = r#"{"id":"p","type":"particles","x":500,"y":800,"rate":40,"life":[0.8,1.6],"speed":[300,500],
        "spread":50,"gravity":[0,600],"drag":0.4,"wind":[30,0],"wander":{"amount":30,"size":120},"spin":[-90,90],"seed":7}"#;

    #[test]
    fn any_frame_in_any_order_is_the_same() {
        let a = scene(&[FOUNTAIN]);
        let b = scene(&[FOUNTAIN]);
        let times = [2.4, 0.3, 5.1, 1.0];
        let first: Vec<_> = times.iter().map(|t| a.frame(*t)).collect();
        // Another scene, evaluated in reverse with other frames in between.
        let _ = b.frame(9.0);
        for (k, t) in times.iter().enumerate().rev() {
            let _ = b.frame(t + 0.37);
            assert_eq!(b.frame(*t), first[k], "frame at {t}s changed with evaluation order");
        }
        assert!(!items(&a, 2.4).is_empty());
    }

    #[test]
    fn a_constant_rate_keeps_rate_times_life_alive() {
        let s = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":10,"life":1}"#]);
        // Births at k/10 s; alive while younger than 1 s: (1.5, 2.5] → 10 particles.
        assert_eq!(live(&s, "p", 2.5), 10);
        assert_eq!(live(&s, "p", 0.05), 1, "the first particle is born at the very start");
        // Prewarm: already running for 3 s at the layer start.
        let warm = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":10,"life":1,"prewarm":3}"#]);
        assert_eq!(live(&warm, "p", 0.0), 10);
    }

    #[test]
    fn animated_rates_integrate_and_bursts_add_their_count() {
        // Rate ramps 0 → 100 over 1 s: 50 particles by then (life long enough to keep them all).
        let s = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"life":5,
            "rate":[{"t":0,"v":0,"ease":"linear"},{"t":1,"v":100}]}"#]);
        let n = live(&s, "p", 1.0);
        assert!((49..=51).contains(&n), "{n}");
        let b = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"life":2,"bursts":[{"at":1,"count":50},{"at":1.5,"count":20}]}"#]);
        assert_eq!(live(&b, "p", 0.9), 0);
        assert_eq!(live(&b, "p", 1.2), 50);
        assert_eq!(live(&b, "p", 2.0), 70);
        assert_eq!(live(&b, "p", 3.2), 20);
        assert_eq!(live(&b, "p", 3.6), 0);
    }

    #[test]
    fn lifetimes_vary_per_particle_and_the_cap_keeps_the_newest() {
        let s = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":100,"life":[0.5,1.5],"seed":3}"#]);
        let n = live(&s, "p", 4.0);
        // Expected ≈ rate × mean life = 100.
        assert!((80..=120).contains(&n), "{n}");
        let capped = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":5000,"life":2,"max":300}"#]);
        assert_eq!(live(&capped, "p", 3.0), 300);
        assert_eq!(capped.layout(3.0).layers[0].particles.unwrap().max, 300);
        let huge = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":5000,"life":2,"max":99999}"#]);
        assert_eq!(live(&huge, "p", 3.0), MAX_PARTICLES);
    }

    #[test]
    fn gravity_and_drag_follow_their_closed_form() {
        // One particle, no spread, straight right at 100 px/s, falling at 200 px/s².
        let s = scene(&[r#"{"id":"p","type":"particles","x":100,"y":100,"bursts":[{"at":0,"count":1}],"life":5,
            "speed":100,"direction":0,"spread":0,"gravity":[0,200],"alpha":1}"#]);
        let c = centers(&s, 2.0)[0];
        assert!((c[0] - 300.0).abs() < 1e-2 && (c[1] - 500.0).abs() < 1e-2, "{c:?}");
        let d = scene(&[r#"{"id":"p","type":"particles","x":0,"y":0,"bursts":[{"at":0,"count":1}],"life":5,
            "speed":100,"direction":0,"spread":0,"drag":1,"wind":[0,10],"alpha":1}"#]);
        let c = centers(&d, 1.0)[0];
        assert!((c[0] - 100.0 * (1.0 - (-1.0f32).exp())).abs() < 1e-2 && (c[1] - 10.0).abs() < 1e-3, "{c:?}");
    }

    #[test]
    fn world_space_leaves_a_trail_and_local_space_carries_particles() {
        let moving = |space: &str| {
            scene(&[&format!(
                r#"{{"id":"p","type":"particles","space":"{space}","y":500,"x":[{{"t":0,"v":100,"ease":"linear"}},{{"t":1,"v":900}}],
                "bursts":[{{"at":0,"count":1}}],"life":5,"speed":0,"alpha":1}}"#
            )])
        };
        assert!((centers(&moving("world"), 1.0)[0][0] - 100.0).abs() < 1e-3);
        assert!((centers(&moving("local"), 1.0)[0][0] - 900.0).abs() < 1e-3);
    }

    #[test]
    fn emitters_place_births_on_their_shape() {
        let ring = scene(&[r#"{"id":"p","type":"particles","emit":"circle","edge":true,"outward":true,"x":500,"y":500,"w":200,"h":200,
            "bursts":[{"at":0,"count":64}],"speed":100,"spread":0,"life":2,"alpha":1}"#]);
        for c in centers(&ring, 0.5) {
            // Born on the r=100 ring, flown 50 px outward.
            let r = (c[0] - 500.0).hypot(c[1] - 500.0);
            assert!((r - 150.0).abs() < 0.05, "{r}");
        }
        let flow = scene(&[r#"{"id":"p","type":"particles","emit":"path","emit_d":"M0 0 L400 0","follow":true,"x":100,"y":100,
            "bursts":[{"at":0,"count":3}],"speed":0,"life":2,"alpha":1}"#]);
        for c in centers(&flow, 1.0) {
            assert!((c[0] - 300.0).abs() < 1e-3 && (c[1] - 100.0).abs() < 1e-3, "{c:?}");
        }
    }

    #[test]
    fn streaks_reach_back_trail_seconds_and_looks_resolve() {
        let s = scene(&[r#"{"id":"p","type":"particles","x":0,"y":0,"bursts":[{"at":0,"count":1}],"life":5,"look":"streak",
            "speed":1000,"direction":0,"spread":0,"trail":0.05,"size":4,"alpha":1}"#]);
        let Some(DrawItem::Shape(sh)) = items(&s, 1.0).first().cloned() else { panic!() };
        assert!((sh.size[0] - 54.0).abs() < 1e-2 && (sh.size[1] - 4.0).abs() < 1e-3, "{:?}", sh.size);
        assert!((sh.center[0] - 975.0).abs() < 1e-2);
        assert!(sh.style.gradient.is_some(), "the tail fades");
        let icons = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":20,"d":"M0 0 L24 24","size":20}"#]);
        assert!(items(&icons, 1.0).iter().all(|i| matches!(i, DrawItem::Path(_))));
        // filled: an open outline (most Lucide icons) is closed implicitly, like an SVG fill.
        let hearts = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":20,"filled":true,"size":40,
            "d":"M-10 -2.5A5.5 5.5 0 0 1 -0.41 -6.18A0.56 0.56 0 0 0 0.41 -6.18A5.49 5.49 0 0 1 10 -2.5C10 -0.21 8.5 1.5 7 3L1.51 8.31A2 2 0 0 1 -1.49 8.33L-7 3C-8.5 1.5 -10 -0.2 -10 -2.5"}"#]);
        let drawn = items(&hearts, 1.0);
        assert!(!drawn.is_empty() && drawn.iter().all(|i| matches!(i, DrawItem::Path(p) if p.fills.len() == 1 && p.fill.is_some() && p.stroke.is_none())));
        let images = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":20,"src":"/media/logo.png"}"#]);
        assert!(items(&images, 1.0).iter().all(|i| matches!(i, DrawItem::Image(_))));
        assert_eq!(images.image_sources(), vec!["/media/logo.png".to_owned()]);
    }

    #[test]
    fn bounds_cover_live_particles_or_the_emitter() {
        let s = scene(&[r#"{"id":"p","type":"particles","emit":"rect","x":500,"y":500,"w":300,"h":100,
            "bursts":[{"at":1,"count":40}],"life":1,"speed":200,"spread":360,"size":10}"#]);
        let idle = s.layer_bounds("p", 0.5).unwrap();
        assert_eq!((idle.center, idle.size), ([500.0, 500.0], [300.0, 100.0]));
        let busy = s.layer_bounds("p", 1.5).unwrap();
        let pts = centers(&s, 1.5);
        assert!(pts.len() > 30);
        for c in pts {
            assert!(busy.contains(c), "{c:?} outside {busy:?}");
        }
        assert!(s.layout(1.5).layers[0].particles.is_some_and(|p| p.live == 40 && p.on_screen == 40));
    }

    #[test]
    fn effects_motion_blur_and_depth_still_apply() {
        let s = scene(&[r#"{"id":"p","type":"particles","x":500,"y":500,"rate":30,"life":1,"blend":"add",
            "effects":[{"fx":"glow","radius":12},{"fx":"motion_blur","samples":4}],"z":1800}"#]);
        let Some(DrawItem::Fx(fx)) = s.frame(1.0).into_iter().next() else { panic!("expected an offscreen pass") };
        assert_eq!(fx.samples.len(), 3);
        let Some(DrawItem::Group(g)) = fx.items.first() else { panic!() };
        // z = focal → half size around the frame center.
        let DrawItem::Shape(sh) = &g[g.len() / 2] else { panic!() };
        assert!((sh.size[0] - 6.0).abs() < 1e-3, "{:?}", sh.size);
    }

    #[test]
    fn json_round_trips_with_defaults_left_out() {
        let json = r##"{"id":"p","type":"particles","x":10,"emit":"circle","rate":12,"life":[1,2],"colors":["accent","#ffcc00"],
            "size":[[0,4],[0.3,12],[1,0]],"color_life":[[0,"#ffffff"],[1,"primary"]],"bursts":[{"at":1,"count":5}]}"##;
        let l: Layer = serde_json::from_str(json).unwrap();
        let back = serde_json::to_value(&l).unwrap();
        assert_eq!(back["emit"], "circle");
        assert_eq!(back["life"], serde_json::json!([1.0, 2.0]));
        assert!(back.get("speed").is_none() && back.get("alpha").is_none() && back.get("max").is_none());
        let again: Layer = serde_json::from_value(back).unwrap();
        assert_eq!(again, l);
    }
}
