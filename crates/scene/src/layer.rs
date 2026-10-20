//! Layers and what they resolve to for one frame.
//!
//! A layer is common timing + transform fields plus a `content` that says what
//! it is. New kinds of content (text, characters, 3D…) are new variants of
//! [`LayerContent`] and [`DrawItem`]; the renderer draws each `DrawItem` kind
//! with its own pipeline, keeping layer order.

use crate::text::{DrawText, TextAlign, TextRole, TextSpan, Typography, DEFAULT_FAMILY};
use crate::paint::{Bevel, BlendMode, ColorAnim, DrawPath, Effect, Gradient, Inner, Matte, Repeater, ShapeStyle, Sheen, Stroke};
use crate::{draw_character, AnimProp, Animated, CharacterSpec, DrawPoly, Library, Palette, Rgba};
use std::sync::OnceLock;
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
        /// Per-character / word / line animation (kinetic type).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        animate: Option<crate::paint::TextAnimator>,
        /// Extra letter spacing in pixels (negative tightens big headlines).
        #[serde(default)]
        letter_spacing: f32,
        /// Text on a path: one line laid along it (path relative to the layer position).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<TextPath>,
        /// Counter: `{n}` in the text shows this number (`"{n}%"`, `"$ {n}"`), `decimals` places.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        count: Option<Animated>,
        #[serde(default, skip_serializing_if = "is_zero_u8")]
        decimals: u8,
        /// Typewriter: how many characters are typed so far (e.g. `"t*18"`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reveal: Option<Animated>,
        /// Blinking text caret after the typed characters (prompt boxes, search bars).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        caret: bool,
        /// Color of the `*marked*` words (default: the palette accent). Keep a phrase in ONE
        /// text layer and mark its key word instead of splitting words into layers.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        accent: Option<ColorAnim>,
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
    /// A 3D object drawn inside the 2D layer box (glossy icons, glass shapes, chrome ribbons):
    /// a procedural tree (same nodes as the stage: box, sphere, torus, extrude, lathe… or a
    /// prefab), framed to fill the box, turned by `spin` (degrees x, y, z).
    Object {
        node: crate::Node3D,
        #[serde(default)]
        finish: crate::stage::Finish,
        #[serde(default)]
        spin: [Animated; 3],
        /// Lens field of view (degrees): small = flat, large = dramatic perspective.
        #[serde(default = "object_fov")]
        fov: f32,
    },
    /// Vector path (SVG path data, relative to the layer position): lines, connectors, icons, light
    /// trails. Filled with `fill` when closed, outlined with `stroke`; `trim_*` draw it on.
    Path {
        d: PathData,
        #[serde(default)]
        trim_start: Animated,
        #[serde(default = "one")]
        trim_end: Animated,
        #[serde(default)]
        trim_offset: Animated,
        /// Fill closed subpaths with `fill` (false = stroke only).
        #[serde(default)]
        filled: bool,
        /// Icon this path came from (Lucide name), so it reads back as `ic=name`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
        /// Shape keyframes (morph): `[{"t":0,"d":"M…"},{"t":1,"d":"M…","ease":"expo_out"}]`. When set,
        /// they replace `d` over time (`d` stays the shape at rest, for selection).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        morph: Vec<PathKey>,
    },
}

/// `{"d":"M-600 0 C-200 -300 200 300 600 0","offset":[{"t":0,"v":-900},{"t":3,"v":0}]}` — animate
/// `offset` (px along the path) to make the text crawl along it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextPath {
    pub d: PathData,
    #[serde(default)]
    pub offset: Animated,
}

/// Camera lens: focal length in px (smaller = wider, stronger perspective) and depth of field:
/// layers away from `focus` depth blur by `aperture` px per 1000 px of distance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lens {
    #[serde(default = "focal")]
    pub focal: f32,
    #[serde(default)]
    pub focus: Animated,
    #[serde(default)]
    pub aperture: Animated,
}

fn focal() -> f32 {
    crate::paint::DEFAULT_PERSPECTIVE
}

/// A 3D object layer for one frame: its little stage, and where it lands on screen.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawObject {
    pub stage: crate::DrawStage,
    pub center: [f32; 2],
    pub size: [f32; 2],
    /// Screen rotation (rad) of the box.
    pub rotation: f32,
    pub opacity: f32,
}

/// One morph keyframe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PathKey {
    pub t: f32,
    pub d: PathData,
    /// Easing to the next key.
    #[serde(default)]
    pub ease: crate::Easing,
}

/// Path shape at layer time `lt`: `d`, or the morph keys blended.
fn path_at<'a>(d: &'a PathData, morph: &'a [PathKey], lt: f32) -> Option<std::borrow::Cow<'a, [crate::path::Polyline]>> {
    use std::borrow::Cow;
    fn shape(k: &PathKey) -> Option<&[crate::path::Polyline]> {
        k.d.lines().as_ref().ok().map(|l| l.as_slice())
    }
    let (Some(first), Some(last)) = (morph.first(), morph.last()) else {
        return d.lines().as_ref().ok().map(|l| Cow::Borrowed(l.as_slice()));
    };
    if lt <= first.t {
        return shape(first).map(Cow::Borrowed);
    }
    if lt >= last.t {
        return shape(last).map(Cow::Borrowed);
    }
    let i = morph.partition_point(|k| k.t <= lt);
    let (a, b) = (&morph[i - 1], &morph[i]);
    let u = a.ease.apply((lt - a.t) / (b.t - a.t).max(f32::EPSILON));
    Some(Cow::Owned(crate::path::morph(shape(a)?, shape(b)?, u)))
}

/// SVG path data, parsed once.
#[derive(Debug, Default)]
pub struct PathData {
    pub d: String,
    parsed: OnceLock<Result<Vec<crate::path::Polyline>, String>>,
}

impl PathData {
    pub fn new(d: String) -> Self {
        PathData { d, parsed: OnceLock::new() }
    }

    pub fn lines(&self) -> &Result<Vec<crate::path::Polyline>, String> {
        self.parsed.get_or_init(|| crate::path::parse(&self.d))
    }
}

impl Clone for PathData {
    fn clone(&self) -> Self {
        PathData::new(self.d.clone())
    }
}

impl PartialEq for PathData {
    fn eq(&self, o: &Self) -> bool {
        self.d == o.d
    }
}

impl Serialize for PathData {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.d)
    }
}

impl<'de> Deserialize<'de> for PathData {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let p = PathData::new(String::deserialize(d)?);
        if let Err(e) = p.lines() {
            return Err(serde::de::Error::custom(e));
        }
        Ok(p)
    }
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
            LayerContent::Path { d, .. } => format!("path ({} chars)", d.d.len()),
            LayerContent::Object { finish, .. } => format!("object {}", crate::enum_name(finish)),
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
    /// Fixed color or color keyframes.
    #[serde(default)]
    pub fill: ColorAnim,
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
    #[serde(default)]
    pub w: Animated,
    #[serde(default)]
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
    /// Gradient fill (replaces `fill`) for shapes, text and paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<Gradient>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Stroke>,
    /// Edge feather in pixels (shapes): big values make soft blobs for mesh-gradient backgrounds.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub soft: Animated,
    /// Material (shapes): inner shadow or glow, a light sweep, an embossed edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inner: Option<Inner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheen: Option<Sheen>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bevel: Option<Bevel>,
    /// Frosted glass: blur what is behind this layer's shape by this many px.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub backdrop: Animated,
    /// Effect stack: blur, glow, shadow.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    #[serde(default, skip_serializing_if = "is_normal")]
    pub blend: BlendMode,
    /// Track matte: another layer's alpha masks this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matte: Option<Matte>,
    /// false = not drawn by itself (matte sources, parents used as nulls).
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub visible: bool,
    /// Inherit position, rotation and scale from another layer (x/y become relative to it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Point (px, relative to the center) the layer rotates and scales around.
    #[serde(default, skip_serializing_if = "is_origin")]
    pub pivot: [f32; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Repeater>,
    /// 2.5D world: `z` is depth (px, + = farther; parents' z adds up): far layers look smaller
    /// and move less when the camera moves (parallax). `rotate_x`/`rotate_y` tilt the layer and
    /// everything parented to it in perspective (a UI page lying back, a dashboard turning);
    /// top leans back with rotate_x > 0, right side goes away with rotate_y > 0. `perspective`
    /// is the lens (px) when the scene has no camera layer.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rotate_x: Animated,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rotate_y: Animated,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub z: Animated,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perspective: Option<f32>,
    /// Pinned to the screen: the camera does not move it (backgrounds, HUD, captions-like text).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fixed: bool,
    /// This (invisible) layer is the scene camera: it looks at its x/y, `z` dollies it forward
    /// (+ = closer to the world), `rotation` rolls it, `scale` zooms the lens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<Lens>,
    /// Adjustment layer: its effects change everything below it, inside this layer's shape
    /// (a full-frame rect for the whole picture).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub adjustment: bool,
    /// Time remap: the layer's own clock as a function of the time since it started, like AE's
    /// time remapping (`"t*0.5"` slow motion, `"mod(t, 2)"` loop, keys to freeze or reverse).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<Animated>,
    /// Move along a path (position comes from it; `x`/`y` add an offset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion_path: Option<MotionPath>,
}

/// AE motion path: `{"d":"M100 900 C600 200 1300 1000 1800 300","progress":[{"t":0,"v":0},{"t":2,"v":1}],"orient":true}`.
/// Path coordinates are scene pixels (parent space when parented).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MotionPath {
    pub d: PathData,
    /// 0..1 along the path's length.
    #[serde(default)]
    pub progress: Animated,
    /// Rotate the layer to follow the path direction (added to `rotation`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub orient: bool,
}

/// Split `"Just *ask.*"` into spans: marked parts in the accent color.
fn marked_spans(text: &str, color: Rgba, accent: Rgba) -> Vec<TextSpan> {
    if !text.contains('*') {
        return vec![TextSpan { text: text.to_owned(), color, scale: 1.0, highlight: None }];
    }
    text.split('*')
        .enumerate()
        .filter(|(_, part)| !part.trim().is_empty())
        .map(|(k, part)| TextSpan { text: part.to_owned(), color: if k % 2 == 1 { accent } else { color }, scale: 1.0, highlight: None })
        .collect()
}

fn object_fov() -> f32 {
    28.0
}

fn is_zero_u8(n: &u8) -> bool {
    *n == 0
}

/// Caret blink rate (Hz) once typing pauses.
const CARET_BLINK_HZ: f32 = 1.1;

/// `n` with `decimals` places and thousands separators: 12,480.5
fn format_count(n: f32, decimals: u8) -> String {
    let s = format!("{:.*}", decimals as usize, n.abs());
    let (int, frac) = s.split_once('.').map_or((s.as_str(), None), |(i, f)| (i, Some(f)));
    let mut grouped = String::new();
    for (k, c) in int.chars().enumerate() {
        if k > 0 && (int.len() - k) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let sign = if n < 0.0 && s.chars().any(|c| c.is_ascii_digit() && c != '0') { "-" } else { "" };
    frac.map_or(format!("{sign}{grouped}"), |f| format!("{sign}{grouped}.{f}"))
}

fn is_zero(a: &Animated) -> bool {
    *a == Animated::Static(0.0)
}
fn is_normal(b: &BlendMode) -> bool {
    *b == BlendMode::Normal
}
fn yes() -> bool {
    true
}
fn is_true(b: &bool) -> bool {
    *b
}
fn is_origin(p: &[f32; 2]) -> bool {
    *p == [0.0, 0.0]
}

/// Where a layer sits in the world: parent transform and/or repeater copy.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Xform {
    /// World position of the local origin.
    pub origin: [f32; 2],
    /// Radians.
    pub rotation: f32,
    pub scale: f32,
    pub opacity: f32,
    /// Extra local offset (repeater copies), applied before the parent transform.
    pub offset: [f32; 2],
    /// Local rotation added (repeater), radians.
    pub spin: f32,
    /// Local scale multiplied (repeater).
    pub grow: f32,
    /// True when a parent defines the origin (anchors are ignored then).
    pub parented: bool,
}

impl Default for Xform {
    fn default() -> Self {
        Xform { origin: [0.0, 0.0], rotation: 0.0, scale: 1.0, opacity: 1.0, offset: [0.0, 0.0], spin: 0.0, grow: 1.0, parented: false }
    }
}

impl Xform {
    fn apply(&self, p: [f32; 2]) -> [f32; 2] {
        let (s, c) = self.rotation.sin_cos();
        [self.origin[0] + (p[0] * c - p[1] * s) * self.scale, self.origin[1] + (p[0] * s + p[1] * c) * self.scale]
    }
}

fn rot(p: [f32; 2], a: f32) -> [f32; 2] {
    let (s, c) = a.sin_cos();
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
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
    pub style: ShapeStyle,
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
    Path(DrawPath),
    /// A layer drawn offscreen for effects, blend modes or a matte.
    Fx(Box<crate::paint::DrawFx>),
    /// A 3D object rendered into its screen box.
    Object(Box<DrawObject>),
}

impl Layer {
    /// Tilted in perspective (drawn offscreen with its children, then projected).
    pub fn is_3d(&self) -> bool {
        !is_zero(&self.rotate_x) || !is_zero(&self.rotate_y)
    }

    /// Layer-local time at scene time `t`, after time remapping.
    pub fn local_time(&self, t: f32) -> f32 {
        let lt = t - self.start;
        self.time.as_ref().map_or(lt, |remap| remap.sample(lt))
    }

    /// Resolve this layer at layer-local time `lt`. `None` when fully transparent.
    pub fn draw(&self, lt: f32, ctx: &EvalCtx) -> Option<DrawItem> {
        self.resolve(lt, ctx, true, &Xform::default())
    }

    /// Resolve inside a parent / repeater transform.
    pub fn draw_in(&self, lt: f32, ctx: &EvalCtx, xf: &Xform) -> Option<DrawItem> {
        self.resolve(lt, ctx, true, xf)
    }

    /// This layer's own world transform at `lt` (what its children inherit).
    pub fn world(&self, lt: f32, ctx: &EvalCtx, parent: &Xform) -> Xform {
        let (center, _, rotation, scale) = self.place(lt, ctx, parent, true);
        Xform { origin: center, rotation, scale, opacity: 1.0, offset: [0.0, 0.0], spin: 0.0, grow: 1.0, parented: true }
    }

    /// World center, size, rotation (rad) and total scale of the layer.
    fn place(&self, lt: f32, ctx: &EvalCtx, xf: &Xform, animated: bool) -> ([f32; 2], [f32; 2], f32, f32) {
        let anim = if animated { self.anim_offsets(lt, ctx.library) } else { AnimOffsets { opacity: 1.0, scale: 1.0, dx: 0.0, dy: 0.0, rotation: 0.0 } };
        let scale = self.scale.sample(lt) * anim.scale * xf.grow;
        let origin = if xf.parented {
            [0.0, 0.0]
        } else {
            self.anchor
                .as_ref()
                .and_then(|a| ctx.library.anchor(a))
                .map_or([0.0, 0.0], |[ax, ay]| [ax * ctx.scene_size[0], ay * ctx.scene_size[1]])
        };
        let along = self.motion_path.as_ref().and_then(|m| {
            let lines = m.d.lines().as_ref().ok()?;
            crate::path::point_at(lines, m.progress.sample(lt)).map(|(p, a)| (p, if m.orient { a } else { 0.0 }))
        });
        let (path_pos, path_rot) = along.unwrap_or(([0.0, 0.0], 0.0));
        let origin = [origin[0] + path_pos[0], origin[1] + path_pos[1]];
        let local_rot = (self.rotation.sample(lt) + anim.rotation).to_radians() + path_rot + xf.spin;
        let mut center = [origin[0] + self.x.sample(lt) + anim.dx + xf.offset[0], origin[1] + self.y.sample(lt) + anim.dy + xf.offset[1]];
        // Rotate/scale around the pivot instead of the center.
        if self.pivot != [0.0, 0.0] {
            let p = self.pivot;
            let moved = rot([p[0] * scale, p[1] * scale], local_rot);
            center = [center[0] + p[0] - moved[0], center[1] + p[1] - moved[1]];
        }
        let world = xf.apply(center);
        let size = [self.w.sample(lt) * scale * xf.scale, self.h.sample(lt) * scale * xf.scale];
        (world, size, local_rot + xf.rotation, scale * xf.scale)
    }

    /// `animated = false` gives the layer at rest (no animation bricks, never hidden):
    /// what selection outlines and hit-tests use, so an object is selectable mid-entrance.
    fn resolve(&self, lt: f32, ctx: &EvalCtx, animated: bool, xf: &Xform) -> Option<DrawItem> {
        let anim_opacity = if animated { self.anim_offsets(lt, ctx.library).opacity } else { 1.0 };
        let opacity = (self.opacity.sample(lt) * anim_opacity * xf.opacity).clamp(0.0, 1.0);
        let mut color = self.fill.resolve(lt, ctx.palette);
        color.0[3] *= opacity;
        if animated && opacity <= 0.0 {
            return None;
        }
        let (center, size, rotation, scale) = self.place(lt, ctx, xf, animated);
        let stroke_gradient = self.stroke.as_ref().and_then(|s| s.gradient.as_ref()).map(|g| g.resolve(lt, ctx.palette, opacity));
        let fill_gradient = self.gradient.as_ref().map(|g| g.resolve(lt, ctx.palette, opacity));
        let stroke = self.stroke.as_ref().map(|s| {
            let mut c = s.color.resolve(lt, ctx.palette);
            c.0[3] *= opacity;
            (s.width.sample(lt) * scale, c)
        });
        match &self.content {
            LayerContent::Shape { shape } => {
                let radius = match shape {
                    Shape::Ellipse => size[0].min(size[1]) / 2.0,
                    Shape::Rect => self.radius.sample(lt) * scale,
                };
                // One gradient per shape on the GPU: an outline gradient wins over a fill one.
                let style = ShapeStyle {
                    gradient: stroke_gradient.or(fill_gradient),
                    stroke_gradient: stroke_gradient.is_some(),
                    stroke,
                    soft: self.soft.sample(lt).max(0.0) * scale,
                    dash: self.stroke.as_ref().and_then(|s| s.dash),
                    inner: self.inner.as_ref().map(|i| {
                        let mut c = i.color.resolve(ctx.palette);
                        c.0[3] *= i.opacity.sample(lt).clamp(0.0, 1.0) * opacity;
                        ([i.x.sample(lt) * scale, i.y.sample(lt) * scale], i.blur.sample(lt).max(0.0) * scale, c)
                    }),
                    sheen: self.sheen.as_ref().map(|s| [s.angle.sample(lt).to_radians(), s.at.sample(lt), s.width.sample(lt).max(0.01), s.opacity.sample(lt) * opacity]),
                    bevel: self.bevel.as_ref().map(|b| [b.width.sample(lt).max(0.0) * scale, b.strength.sample(lt) * opacity]),
                };
                Some(DrawItem::Shape(DrawShape { center, size, radius, rotation, color, style }))
            }
            LayerContent::Path { d, trim_start, trim_end, trim_offset, filled, morph, .. } => {
                let lines = path_at(d, if animated { morph } else { &[] }, lt)?;
                let lines = lines.as_ref();
                let to_world = |p: [f32; 2]| {
                    let q = rot([p[0] * scale, p[1] * scale], rotation);
                    [center[0] + q[0], center[1] + q[1]]
                };
                let mut lo = [f32::MAX; 2];
                let mut hi = [f32::MIN; 2];
                for p in lines.iter().flat_map(|l| &l.points) {
                    let w = to_world(*p);
                    lo = [lo[0].min(w[0]), lo[1].min(w[1])];
                    hi = [hi[0].max(w[0]), hi[1].max(w[1])];
                }
                let (ts, te) = (trim_start.sample(lt), trim_end.sample(lt));
                let trimmed = crate::path::trim(lines, ts, te, trim_offset.sample(lt));
                let full = (te - ts).abs() >= 0.9999;
                Some(DrawItem::Path(DrawPath {
                    lines: trimmed.into_iter().map(|l| l.into_iter().map(to_world).collect()).collect(),
                    fills: if *filled && full { lines.iter().filter(|l| l.closed).map(|l| l.points.iter().copied().map(to_world).collect()).collect() } else { Vec::new() },
                    fill: (*filled).then_some(color),
                    stroke,
                    stroke_end: None,
                    dash: self.stroke.as_ref().and_then(|s| s.dash),
                    bounds: (lo, hi),
                    gradient: fill_gradient.or(stroke_gradient),
                }))
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
            LayerContent::Object { node, finish, spin, fov } => {
                use glam::{Mat4, Quat};
                let [rx, ry, rz] = [spin[0].sample(lt), spin[1].sample(lt), spin[2].sample(lt)].map(f32::to_radians);
                let base = Mat4::from_quat(Quat::from_euler(glam::EulerRot::YXZ, ry, rx, rz));
                let nctx = crate::node3d::NodeCtx { palette: ctx.palette, prefabs: &ctx.library.prefabs, time: lt, action: None };
                let (mut solids, mut placed) = (Vec::new(), Vec::new());
                // The object's color comes from its nodes; `fill` tints parts without one.
                let mut tint = color;
                tint.0[3] = 1.0;
                node.flatten(base, tint, &nctx, &mut solids, &mut placed, 0);
                // Framed at rest (unspun) so turning does not breathe the size.
                let (mut rest, mut rest_placed) = (Vec::new(), Vec::new());
                node.flatten(Mat4::IDENTITY, tint, &nctx, &mut rest, &mut rest_placed, 0);
                let camera = crate::stage::frame_solids(&rest, *fov, size[0] / size[1].max(1.0));
                let stage = crate::DrawStage {
                    camera,
                    finish: *finish,
                    props: Vec::new(),
                    solids,
                    placed,
                    floor: None,
                    ink: ctx.palette.text,
                    background: Rgba([0.0; 4]),
                };
                Some(DrawItem::Object(Box::new(DrawObject { stage, center, size, rotation, opacity })))
            }
            LayerContent::Character { spec } => {
                let feet = [center[0], center[1] + size[1] / 2.0];
                Some(DrawItem::Group(draw_character(spec, feet, size[1], lt, color.0[3], ctx.palette)))
            }
            LayerContent::Text { text, size: px, role, align, line_height, animate, letter_spacing, path, count, decimals, reveal, caret, accent } => {
                let text = match count {
                    Some(n) => std::borrow::Cow::Owned(text.replace("{n}", &format_count(n.sample(lt), *decimals))),
                    None => std::borrow::Cow::Borrowed(text.as_str()),
                };
                let shown = reveal.as_ref().map(|r| r.sample(lt).max(0.0));
                let caret = caret.then(|| {
                    let typing = reveal.as_ref().is_some_and(|r| (r.sample(lt) - r.sample(lt - 0.08)).abs() > 1e-3);
                    if typing || (lt * CARET_BLINK_HZ).fract() < 0.5 { 1.0 } else { 0.0 }
                });
                let (family, weight) = ctx
                    .typography
                    .map_or((DEFAULT_FAMILY.to_owned(), 600), |t| (t.family.clone(), t.weight(*role)));
                Some(DrawItem::Text(DrawText {
                    gradient: fill_gradient,
                    animator: animate.as_ref().map(|a| a.resolve(lt)),
                    letter_spacing: *letter_spacing * scale,
                    path: path.as_ref().and_then(|p| {
                        let lines = p.d.lines().as_ref().ok()?;
                        let points = lines.iter().flat_map(|l| &l.points).map(|q| {
                            let r = rot([q[0] * scale, q[1] * scale], rotation);
                            [center[0] + r[0], center[1] + r[1]]
                        });
                        Some((points.collect(), p.offset.sample(lt) * scale))
                    }),
                    reveal: shown,
                    caret,
                    spans: {
                        let mut accent_color = accent.as_ref().map_or(ctx.palette.accent, |a| a.resolve(lt, ctx.palette));
                        accent_color.0[3] *= opacity;
                        marked_spans(&text, color, accent_color)
                    },
                    size: px * scale,
                    family,
                    weight,
                    align: *align,
                    line_height: *line_height,
                    center,
                    // On a path the text is one line of its full size.
                    max_width: if path.is_some() { f32::MAX } else { fit_width(size[0], center[0], ctx.scene_size[0]) },
                    max_height: if path.is_some() { None } else { Some(size[1].max(1.0)) },
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
    /// Box of the layer at rest at `lt`, inside its parent chain `xf`.
    pub fn bounds(&self, lt: f32, ctx: &EvalCtx, xf: &Xform) -> Option<Bounds> {
        match self.resolve(lt, ctx, false, xf)? {
            DrawItem::Shape(s) => Some(Bounds { center: s.center, size: s.size, rotation: s.rotation }),
            DrawItem::Image(i) => Some(Bounds { center: i.center, size: i.size, rotation: i.rotation }),
            DrawItem::Object(o) => Some(Bounds { center: o.center, size: o.size, rotation: o.rotation }),
            DrawItem::Text(t) => {
                let scale = self.scale.sample(lt);
                Some(Bounds { center: t.center, size: [t.max_width, self.h.sample(lt) * scale * xf.scale], rotation: t.rotation })
            }
            DrawItem::Path(p) => {
                let (lo, hi) = p.bounds;
                Some(Bounds { center: [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0], size: [(hi[0] - lo[0]).max(8.0), (hi[1] - lo[1]).max(8.0)], rotation: 0.0 })
            }
            DrawItem::Poly(_) | DrawItem::Group(_) | DrawItem::Stage(_) | DrawItem::Fx(_) => {
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
