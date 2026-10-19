//! Mesh generation for procedural primitives (scene::Geometry). Output feeds the
//! same toon pipeline as glTF meshes (no skin, no texture).

use super::model::Vertex3D;
use glam::{Vec2, Vec3};
use scene::Geometry;
use std::f32::consts::{PI, TAU};

const SEGMENTS: usize = 28;

pub struct Mesh {
    pub vertices: Vec<Vertex3D>,
    pub indices: Vec<u32>,
}

impl Mesh {
    fn new() -> Self {
        Mesh { vertices: Vec::new(), indices: Vec::new() }
    }

    fn vertex(&mut self, p: Vec3, n: Vec3) -> u32 {
        self.vertices.push(Vertex3D { pos: p.to_array(), normal: n.normalize_or_zero().to_array(), ..Default::default() });
        self.vertices.len() as u32 - 1
    }

    fn tri(&mut self, a: u32, b: u32, c: u32) {
        self.indices.extend([a, b, c]);
    }

    /// Grid of `rows`×`cols` vertices from `f(u, v) -> (pos, normal)`, u,v in 0..1.
    fn grid(&mut self, rows: usize, cols: usize, f: impl Fn(f32, f32) -> (Vec3, Vec3)) {
        let start = self.vertices.len() as u32;
        for r in 0..=rows {
            for c in 0..=cols {
                let (p, n) = f(c as f32 / cols as f32, r as f32 / rows as f32);
                self.vertex(p, n);
            }
        }
        let w = cols as u32 + 1;
        for r in 0..rows as u32 {
            for c in 0..cols as u32 {
                let i = start + r * w + c;
                self.tri(i, i + w, i + 1);
                self.tri(i + 1, i + w, i + w + 1);
            }
        }
    }
}

pub fn build(g: &Geometry) -> Mesh {
    let mut m = Mesh::new();
    match g {
        Geometry::Box { size, radius } => rounded_box(&mut m, Vec3::from(*size) * 0.5, radius.max(0.0)),
        Geometry::Sphere { radius } => m.grid(SEGMENTS / 2, SEGMENTS, |u, v| {
            let (th, ph) = (u * TAU, v * PI);
            let n = Vec3::new(ph.sin() * th.cos(), ph.cos(), ph.sin() * th.sin());
            (n * *radius, n)
        }),
        Geometry::Capsule { radius, height } => {
            let half = (height * 0.5 - radius).max(0.0);
            m.grid(SEGMENTS / 2 + 1, SEGMENTS, |u, v| {
                // Upper hemisphere, cylinder band (at v = 0.5), lower hemisphere.
                let th = u * TAU;
                let ph = v * PI;
                let n = Vec3::new(ph.sin() * th.cos(), ph.cos(), ph.sin() * th.sin());
                let y = if v < 0.5 { half } else { -half };
                (n * *radius + Vec3::Y * y, n)
            })
        }
        Geometry::Cylinder { radius, height } => lathe(&mut m, &[[0.0, -height / 2.0], [*radius, -height / 2.0], [*radius, height / 2.0], [0.0, height / 2.0]], true),
        Geometry::Cone { radius, height } => lathe(&mut m, &[[0.0, -height / 2.0], [*radius, -height / 2.0], [0.0, height / 2.0]], true),
        Geometry::Torus { radius, tube } => m.grid(SEGMENTS / 2, SEGMENTS, |u, v| {
            let (a, b) = (u * TAU, v * TAU);
            let center = Vec3::new(a.cos(), 0.0, a.sin()) * *radius;
            let n = Vec3::new(a.cos() * b.cos(), b.sin(), a.sin() * b.cos());
            (center + n * *tube, n)
        }),
        Geometry::Plane { size } => {
            let (w, d) = (size[0] / 2.0, size[1] / 2.0);
            let i = [(-w, -d), (w, -d), (w, d), (-w, d)].map(|(x, z)| m.vertex(Vec3::new(x, 0.0, z), Vec3::Y));
            m.tri(i[0], i[2], i[1]);
            m.tri(i[0], i[3], i[2]);
        }
        Geometry::Lathe { points } => lathe(&mut m, points, true),
        Geometry::Extrude { points, depth } => extrude(&mut m, points, *depth),
    }
    orient_outwards(&mut m);
    m
}

/// Make every triangle counter-clockwise seen from outside (the side its normals point to),
/// whatever order the generators emitted. Front faces render; the outline pass uses back faces.
fn orient_outwards(m: &mut Mesh) {
    for tri in m.indices.chunks_exact_mut(3) {
        let [a, b, c] = [tri[0], tri[1], tri[2]].map(|i| m.vertices[i as usize]);
        let (pa, pb, pc) = (Vec3::from(a.pos), Vec3::from(b.pos), Vec3::from(c.pos));
        let face = (pb - pa).cross(pc - pa);
        let normal = Vec3::from(a.normal) + Vec3::from(b.normal) + Vec3::from(c.normal);
        if face.dot(normal) < 0.0 {
            tri.swap(1, 2);
        }
    }
}

/// Rounded box: a subdivided cube whose points are pulled onto an inner box + radius.
fn rounded_box(m: &mut Mesh, half: Vec3, radius: f32) {
    let r = radius.min(half.min_element());
    let inner = half - Vec3::splat(r);
    let n = if r > 0.0 { 6 } else { 1 };
    let faces = [
        (Vec3::X, Vec3::Z, Vec3::Y),
        (-Vec3::X, Vec3::Y, Vec3::Z),
        (Vec3::Y, Vec3::X, Vec3::Z),
        (-Vec3::Y, Vec3::Z, Vec3::X),
        (Vec3::Z, Vec3::Y, Vec3::X),
        (-Vec3::Z, Vec3::X, Vec3::Y),
    ];
    for (normal, a, b) in faces {
        // Orient (a, b) so triangles face outwards.
        let (a, b) = if a.cross(b).dot(normal) < 0.0 { (b, a) } else { (a, b) };
        m.grid(n, n, |u, v| {
            let p = (normal + a * (u * 2.0 - 1.0) + b * (v * 2.0 - 1.0)) * half;
            if r <= 0.0 {
                return (p, normal);
            }
            let core = p.clamp(-inner, inner);
            let dir = (p - core).normalize_or(normal);
            (core + dir * r, dir)
        });
    }
}

/// Spin a (radius, y) profile around y. `cap` closes ends that sit on the axis.
fn lathe(m: &mut Mesh, points: &[[f32; 2]], _cap: bool) {
    if points.len() < 2 {
        return;
    }
    let pts: Vec<Vec2> = points.iter().map(|p| Vec2::from(*p)).collect();
    // Flat shading per segment keeps edges crisp for toon lighting.
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let d = b - a;
        let n2 = Vec2::new(d.y, -d.x).normalize_or_zero();
        let start = m.vertices.len() as u32;
        for i in 0..=SEGMENTS {
            let th = i as f32 / SEGMENTS as f32 * TAU;
            let (c, s) = (th.cos(), th.sin());
            let n = Vec3::new(n2.x * c, n2.y, n2.x * s);
            m.vertex(Vec3::new(a.x * c, a.y, a.x * s), n);
            m.vertex(Vec3::new(b.x * c, b.y, b.x * s), n);
        }
        for i in 0..SEGMENTS as u32 {
            let k = start + i * 2;
            m.tri(k, k + 2, k + 1);
            m.tri(k + 1, k + 2, k + 3);
        }
    }
}

/// Outline extruded along z (centered), with ear-clipped caps.
fn extrude(m: &mut Mesh, points: &[[f32; 2]], depth: f32) {
    if points.len() < 3 {
        return;
    }
    let mut pts: Vec<Vec2> = points.iter().map(|p| Vec2::from(*p)).collect();
    let area: f32 = pts.iter().zip(pts.iter().cycle().skip(1)).map(|(a, b)| a.x * b.y - b.x * a.y).sum();
    if area < 0.0 {
        pts.reverse();
    }
    let z = depth / 2.0;
    for (zz, normal, flip) in [(z, Vec3::Z, false), (-z, -Vec3::Z, true)] {
        let base = m.vertices.len() as u32;
        for p in &pts {
            m.vertex(Vec3::new(p.x, p.y, zz), normal);
        }
        for [a, b, c] in ear_clip(&pts) {
            if flip {
                m.tri(base + a, base + c, base + b);
            } else {
                m.tri(base + a, base + b, base + c);
            }
        }
    }
    for i in 0..pts.len() {
        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
        let d = b - a;
        let n = Vec3::new(d.y, -d.x, 0.0);
        let q = [Vec3::new(a.x, a.y, z), Vec3::new(b.x, b.y, z), Vec3::new(b.x, b.y, -z), Vec3::new(a.x, a.y, -z)].map(|p| m.vertex(p, n));
        m.tri(q[0], q[2], q[1]);
        m.tri(q[0], q[3], q[2]);
    }
}

/// Triangulate a simple counter-clockwise polygon.
fn ear_clip(pts: &[Vec2]) -> Vec<[u32; 3]> {
    let mut idx: Vec<usize> = (0..pts.len()).collect();
    let mut out = Vec::new();
    let cross = |a: Vec2, b: Vec2, c: Vec2| (b - a).perp_dot(c - a);
    let mut guard = 0;
    while idx.len() > 3 && guard < 10_000 {
        guard += 1;
        let n = idx.len();
        let mut clipped = false;
        for i in 0..n {
            let (ia, ib, ic) = (idx[(i + n - 1) % n], idx[i], idx[(i + 1) % n]);
            let (a, b, c) = (pts[ia], pts[ib], pts[ic]);
            if cross(a, b, c) <= 0.0 {
                continue;
            }
            let inside = idx.iter().any(|&j| {
                j != ia && j != ib && j != ic && {
                    let p = pts[j];
                    cross(a, b, p) > 0.0 && cross(b, c, p) > 0.0 && cross(c, a, p) > 0.0
                }
            });
            if inside {
                continue;
            }
            out.push([ia as u32, ib as u32, ic as u32]);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break;
        }
    }
    if idx.len() == 3 {
        out.push([idx[0] as u32, idx[1] as u32, idx[2] as u32]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_primitive_makes_a_closed_mesh() {
        let shapes = [
            Geometry::Box { size: [1.0, 0.5, 2.0], radius: 0.1 },
            Geometry::Box { size: [1.0, 1.0, 1.0], radius: 0.0 },
            Geometry::Sphere { radius: 0.5 },
            Geometry::Capsule { radius: 0.1, height: 0.8 },
            Geometry::Cylinder { radius: 0.3, height: 1.0 },
            Geometry::Cone { radius: 0.3, height: 1.0 },
            Geometry::Torus { radius: 0.5, tube: 0.1 },
            Geometry::Plane { size: [2.0, 2.0] },
            Geometry::Lathe { points: vec![[0.0, 0.0], [0.3, 0.1], [0.2, 0.6], [0.0, 0.7]] },
            Geometry::Extrude { points: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 0.4], [0.0, 1.0]], depth: 0.2 },
        ];
        for g in shapes {
            let m = build(&g);
            assert!(!m.indices.is_empty() && m.indices.len() % 3 == 0, "{g:?}");
            assert!(m.indices.iter().all(|&i| (i as usize) < m.vertices.len()));
        }
    }

    #[test]
    fn triangles_face_their_normals() {
        for g in [Geometry::Sphere { radius: 1.0 }, Geometry::Box { size: [1.0, 1.0, 1.0], radius: 0.2 }, Geometry::Cylinder { radius: 0.5, height: 1.0 }] {
            let m = build(&g);
            for t in m.indices.chunks_exact(3) {
                let [a, b, c] = [t[0], t[1], t[2]].map(|i| m.vertices[i as usize]);
                let face = (Vec3::from(b.pos) - Vec3::from(a.pos)).cross(Vec3::from(c.pos) - Vec3::from(a.pos));
                assert!(face.dot(Vec3::from(a.normal) + Vec3::from(b.normal) + Vec3::from(c.normal)) >= 0.0);
            }
        }
    }

    #[test]
    fn rounded_box_stays_inside_its_size() {
        let m = build(&Geometry::Box { size: [2.0, 1.0, 1.0], radius: 0.2 });
        let max = m.vertices.iter().map(|v| v.pos[0].abs()).fold(0.0, f32::max);
        assert!((max - 1.0).abs() < 1e-4, "{max}");
    }
}
