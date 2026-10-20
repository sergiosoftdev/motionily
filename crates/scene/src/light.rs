//! Lights for the 3D stage and for 3D object layers: one key (directional) light, a sky/ground
//! ambient, up to four point lights, key-light shadows (a shadow map on the stage) and a soft
//! contact shadow under an object layer's object. Without `lights` everything renders exactly as
//! before (a soft light that follows the camera, no shadows).

use crate::layer::DrawShape;
use crate::paint::{ColorAnim, ShapeStyle};
use crate::stage::DrawCamera;
use crate::{Animated, ColorRef, DrawSolid, Geometry, HexColor, Palette, Rgba};
use glam::{Mat4, Vec3};
use serde::{Deserialize, Serialize};

/// Point lights past this many are ignored (one uniform slot each on the GPU).
pub const MAX_POINT_LIGHTS: usize = 4;
/// Upper bound of every light intensity.
pub const MAX_INTENSITY: f32 = 8.0;
/// Key light elevation limits (degrees): straight up/down has no azimuth.
const MAX_ELEVATION: f32 = 89.0;
/// Color of the contact shadow (the drop-shadow default, a deep blue-black).
const CONTACT_COLOR: Rgba = Rgba([0.06, 0.07, 0.12, 1.0]);

/// `{"key":{…},"ambient":{…},"points":[…],"shadows":true,"softness":0.5,"contact":0.35}` on
/// `set_stage`/`set_lights` (world space, meters) or on an object layer (its own space).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lights {
    #[serde(default, skip_serializing_if = "is_default")]
    pub key: KeyLight,
    #[serde(default, skip_serializing_if = "is_default")]
    pub ambient: AmbientLight,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<PointLight>,
    /// Key-light shadows: the stage casts them on the floor and on props; object layers get a
    /// contact shadow under the object.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub shadows: bool,
    /// Shadow edge: 0 = crisp, 1 = very soft.
    #[serde(default = "half", skip_serializing_if = "is_half")]
    pub softness: Animated,
    /// Opacity of an object layer's contact shadow (0 = none). Unused on the stage.
    #[serde(default = "contact", skip_serializing_if = "is_contact")]
    pub contact: Animated,
}

impl Default for Lights {
    fn default() -> Self {
        Lights { key: KeyLight::default(), ambient: AmbientLight::default(), points: Vec::new(), shadows: true, softness: half(), contact: contact() }
    }
}

/// The sun / main studio light: parallel rays from a direction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyLight {
    /// Degrees around the vertical axis, the stage camera's yaw convention: 0 = from the front
    /// (+z), 90 = from the right (+x), -90 = from the left, 180 = from behind.
    #[serde(default = "key_azimuth")]
    pub azimuth: Animated,
    /// Degrees above the horizon (90 = from straight above; low values make long shadows).
    #[serde(default = "key_elevation")]
    pub elevation: Animated,
    #[serde(default = "white")]
    pub color: ColorAnim,
    #[serde(default = "one")]
    pub intensity: Animated,
}

impl Default for KeyLight {
    fn default() -> Self {
        KeyLight { azimuth: key_azimuth(), elevation: key_elevation(), color: white(), intensity: one() }
    }
}

/// Light from everywhere: `sky` on surfaces facing up, `ground` on surfaces facing down.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AmbientLight {
    #[serde(default = "white")]
    pub sky: ColorAnim,
    #[serde(default = "white")]
    pub ground: ColorAnim,
    #[serde(default = "one")]
    pub intensity: Animated,
}

impl Default for AmbientLight {
    fn default() -> Self {
        AmbientLight { sky: white(), ground: white(), intensity: one() }
    }
}

/// A bulb: light from a point that fades to nothing at `range` (no shadows).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PointLight {
    #[serde(default)]
    pub x: Animated,
    #[serde(default)]
    pub y: Animated,
    #[serde(default)]
    pub z: Animated,
    #[serde(default = "white")]
    pub color: ColorAnim,
    #[serde(default = "one")]
    pub intensity: Animated,
    /// Distance (same units as x/y/z) where its light reaches zero.
    #[serde(default = "range")]
    pub range: Animated,
}

fn yes() -> bool {
    true
}
fn is_true(b: &bool) -> bool {
    *b
}
fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}
fn is_half(a: &Animated) -> bool {
    *a == half()
}
fn is_contact(a: &Animated) -> bool {
    *a == contact()
}
fn half() -> Animated {
    Animated::Static(0.5)
}
fn one() -> Animated {
    Animated::Static(1.0)
}
fn contact() -> Animated {
    Animated::Static(0.35)
}
fn key_azimuth() -> Animated {
    Animated::Static(35.0)
}
fn key_elevation() -> Animated {
    Animated::Static(50.0)
}
fn range() -> Animated {
    Animated::Static(4.0)
}
fn white() -> ColorAnim {
    ColorAnim::Static(ColorRef::Hex(HexColor(Rgba([1.0; 4]))))
}

/// One point light for one frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawPointLight {
    pub position: [f32; 3],
    /// Color × intensity.
    pub color: [f32; 3],
    pub range: f32,
}

/// Lights resolved for one frame.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawLights {
    /// Unit vector pointing toward the key light.
    pub key_dir: [f32; 3],
    /// Key color × intensity.
    pub key: [f32; 3],
    /// Ambient sky and ground colors × intensity.
    pub sky: [f32; 3],
    pub ground: [f32; 3],
    pub points: Vec<DrawPointLight>,
    pub shadows: bool,
    /// 0..1.
    pub softness: f32,
    /// 0..1 (object layers).
    pub contact: f32,
}

/// Unit vector toward a light at `azimuth`/`elevation` degrees (where a stage camera with that
/// yaw and pitch would stand).
pub fn direction(azimuth: f32, elevation: f32) -> [f32; 3] {
    let (a, e) = (azimuth.to_radians(), elevation.clamp(-MAX_ELEVATION, MAX_ELEVATION).to_radians());
    [e.cos() * a.sin(), e.sin(), e.cos() * a.cos()]
}

impl Lights {
    /// The lights at time `t`; point light positions are offset by `origin`.
    pub fn resolve(&self, t: f32, palette: &Palette, origin: [f32; 3]) -> DrawLights {
        let scaled = |c: &ColorAnim, k: &Animated| {
            let rgb = c.resolve(t, palette).0;
            let k = k.sample(t).clamp(0.0, MAX_INTENSITY);
            [rgb[0] * k, rgb[1] * k, rgb[2] * k]
        };
        let amb = &self.ambient;
        DrawLights {
            key_dir: direction(self.key.azimuth.sample(t), self.key.elevation.sample(t)),
            key: scaled(&self.key.color, &self.key.intensity),
            sky: scaled(&amb.sky, &amb.intensity),
            ground: scaled(&amb.ground, &amb.intensity),
            points: self
                .points
                .iter()
                .take(MAX_POINT_LIGHTS)
                .map(|p| DrawPointLight {
                    position: [origin[0] + p.x.sample(t), origin[1] + p.y.sample(t), origin[2] + p.z.sample(t)],
                    color: scaled(&p.color, &p.intensity),
                    range: p.range.sample(t).max(0.01),
                })
                .collect(),
            shadows: self.shadows,
            softness: self.softness.sample(t).clamp(0.0, 1.0),
            contact: self.contact.sample(t).clamp(0.0, 1.0),
        }
    }
}

/// Exact box of a primitive in its own space (the meshes the engine builds).
pub fn geometry_bounds(g: &Geometry) -> ([f32; 3], [f32; 3]) {
    let span = |pts: &[[f32; 2]], k: usize| pts.iter().fold((f32::MAX, f32::MIN), |(lo, hi), p| (lo.min(p[k]), hi.max(p[k])));
    match g {
        Geometry::Box { size, .. } => ([-size[0] / 2.0, -size[1] / 2.0, -size[2] / 2.0], [size[0] / 2.0, size[1] / 2.0, size[2] / 2.0]),
        Geometry::Sphere { radius: r } => ([-r, -r, -r], [*r, *r, *r]),
        Geometry::Capsule { radius: r, height } => {
            let h = (height / 2.0).max(*r);
            ([-r, -h, -r], [*r, h, *r])
        }
        Geometry::Cylinder { radius: r, height } | Geometry::Cone { radius: r, height } => ([-r, -height / 2.0, -r], [*r, height / 2.0, *r]),
        Geometry::Torus { radius, tube } => {
            let o = radius + tube;
            ([-o, -tube, -o], [o, *tube, o])
        }
        Geometry::Plane { size } => ([-size[0] / 2.0, 0.0, -size[1] / 2.0], [size[0] / 2.0, 0.0, size[1] / 2.0]),
        Geometry::Lathe { points } => {
            let r = points.iter().fold(0.0f32, |a, p| a.max(p[0].abs()));
            let (y0, y1) = span(points, 1);
            ([-r, y0, -r], [r, y1, r])
        }
        Geometry::Extrude { points, depth } => {
            let ((x0, x1), (y0, y1)) = (span(points, 0), span(points, 1));
            ([x0, y0, -depth / 2.0], [x1, y1, depth / 2.0])
        }
        // Centered on its ink box (estimated until the font has loaded).
        Geometry::Text { .. } => {
            let [x, y, z] = g.half_extents();
            ([-x, -y, -z], [x, y, z])
        }
    }
}

/// World box around placed solids (`None` when there are none).
pub fn solids_box(solids: &[DrawSolid]) -> Option<(Vec3, Vec3)> {
    let mut out: Option<(Vec3, Vec3)> = None;
    for s in solids {
        let m = Mat4::from_cols_array_2d(&s.transform);
        let (lo, hi) = geometry_bounds(&s.geometry);
        for i in 0..8 {
            let corner = Vec3::new([lo[0], hi[0]][i & 1], [lo[1], hi[1]][(i >> 1) & 1], [lo[2], hi[2]][(i >> 2) & 1]);
            let p = m.transform_point3(corner);
            out = Some(out.map_or((p, p), |(a, b)| (a.min(p), b.max(p))));
        }
    }
    out
}

/// Where an object layer is drawn: its screen box and the lens framing it.
pub struct ObjectBox<'a> {
    pub camera: &'a DrawCamera,
    pub center: [f32; 2],
    pub size: [f32; 2],
    /// Screen rotation (rad).
    pub rotation: f32,
}

impl ObjectBox<'_> {
    /// Screen point of an object-space point (`None` behind the lens).
    fn project(&self, p: Vec3) -> Option<[f32; 2]> {
        let v = p - Vec3::from(self.camera.eye);
        // The framing lens looks down -z from straight in front (`frame_solids`).
        let depth = -v.z;
        if depth < 1e-3 {
            return None;
        }
        let tan = (self.camera.fov.to_radians() / 2.0).tan();
        let aspect = self.size[0] / self.size[1].max(1.0);
        let local = [v.x / depth / (tan * aspect) * self.size[0] / 2.0, -v.y / depth / tan * self.size[1] / 2.0];
        let (s, c) = self.rotation.sin_cos();
        Some([self.center[0] + local[0] * c - local[1] * s, self.center[1] + local[0] * s + local[1] * c])
    }
}

/// Soft ellipse under an object layer's object: as wide as the object's base on screen, widened
/// by `1 + 0.3·(1 − Ly)`, `0.18 × width` tall, centered on the lowest point and pushed
/// `−Lx × 0.2 × width` away from the key light, feathered `width × (0.06 + 0.24·softness)`.
pub fn contact_shadow(solids: &[DrawSolid], at: &ObjectBox, lights: &DrawLights, opacity: f32) -> Option<DrawShape> {
    let alpha = lights.contact * opacity;
    if !lights.shadows || alpha <= 0.0 {
        return None;
    }
    let (lo, hi) = solids_box(solids)?;
    let mid_z = (lo.z + hi.z) / 2.0;
    let bottom = at.project(Vec3::new((lo.x + hi.x) / 2.0, lo.y, mid_z))?;
    let (left, right) = (at.project(Vec3::new(lo.x, lo.y, mid_z))?, at.project(Vec3::new(hi.x, lo.y, mid_z))?);
    let base = (right[0] - left[0]).hypot(right[1] - left[1]);
    if base < 1.0 {
        return None;
    }
    let [lx, ly, _] = lights.key_dir;
    let width = base * (1.0 + 0.3 * (1.0 - ly.max(0.0)));
    let (s, c) = at.rotation.sin_cos();
    let push = -lx * 0.2 * width;
    let mut color = CONTACT_COLOR;
    color.0[3] = alpha;
    Some(DrawShape {
        center: [bottom[0] + push * c, bottom[1] + push * s],
        size: [width, width * 0.18],
        radius: width * 0.09,
        rotation: at.rotation,
        color,
        style: ShapeStyle { soft: width * (0.06 + 0.24 * lights.softness), ..Default::default() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directions_follow_the_camera_yaw_convention() {
        let front = direction(0.0, 0.0);
        assert!((front[2] - 1.0).abs() < 1e-6);
        let right = direction(90.0, 0.0);
        assert!((right[0] - 1.0).abs() < 1e-6);
        let above = direction(0.0, 90.0);
        assert!(above[1] > 0.999 && above[1] < 1.0, "elevation is clamped below 90°");
    }

    #[test]
    fn empty_lights_take_documented_defaults() {
        let l: Lights = serde_json::from_str("{}").unwrap();
        assert_eq!(l, Lights::default());
        assert_eq!(serde_json::to_string(&l).unwrap(), "{}", "defaults are left out when read back");
        let d = l.resolve(0.0, &crate::StylePreset::Clean.palette(), [0.0; 3]);
        assert_eq!((d.key, d.sky, d.ground), ([1.0; 3], [1.0; 3], [1.0; 3]));
        assert!(d.shadows && d.softness == 0.5 && d.contact == 0.35 && d.points.is_empty());
        let warm: Lights = serde_json::from_str(r##"{"key":{"color":"#ff8000","intensity":2},"points":[{"x":1,"range":3},{},{},{},{}]}"##).unwrap();
        let d = warm.resolve(0.0, &crate::StylePreset::Clean.palette(), [0.0, 1.0, 0.0]);
        assert_eq!(d.key, [2.0, 1.0039216, 0.0]);
        assert_eq!(d.points.len(), MAX_POINT_LIGHTS);
        assert_eq!(d.points[0].position, [1.0, 1.0, 0.0]);
    }

    #[test]
    fn primitive_boxes_match_their_meshes() {
        assert_eq!(geometry_bounds(&Geometry::Lathe { points: vec![[0.0, 0.2], [0.5, 1.0]] }), ([-0.5, 0.2, -0.5], [0.5, 1.0, 0.5]));
        let solids = [DrawSolid { geometry: Geometry::Box { size: [2.0, 1.0, 1.0], radius: 0.0 }, transform: Mat4::from_translation(Vec3::Y).to_cols_array_2d(), color: Rgba([1.0; 4]) }];
        let (lo, hi) = solids_box(&solids).unwrap();
        assert_eq!((lo, hi), (Vec3::new(-1.0, 0.5, -0.5), Vec3::new(1.0, 1.5, 0.5)));
    }
}
