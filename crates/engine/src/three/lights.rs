//! Light uniforms for one frame: the stage's or object layer's `lights`, or — without them — the
//! original look (a soft white key that follows the camera, white ambient, no shadows), which
//! `mesh.wgsl` turns back into exactly the old shading.

use glam::Vec3;
use scene::{DrawLights, MAX_POINT_LIGHTS};

/// Chrome's studio soft box sat at this reflection x before lights existed.
const LEGACY_SOFTBOX_X: f32 = 0.35;

/// The light part of the frame uniforms.
pub struct LightU {
    pub light_dir: [f32; 4],
    pub key: [f32; 4],
    pub sky: [f32; 4],
    pub ground: [f32; 4],
    pub point_pos: [[f32; 4]; MAX_POINT_LIGHTS],
    pub point_color: [[f32; 4]; MAX_POINT_LIGHTS],
}

/// The camera-following key every stage and object had before `lights`.
pub fn legacy_dir(eye: Vec3, target: Vec3) -> Vec3 {
    ((eye - target).normalize_or_zero() * 0.4 + Vec3::new(0.5, 1.0, 0.35)).normalize()
}

pub fn uniforms(lights: Option<&DrawLights>, eye: Vec3, target: Vec3) -> LightU {
    let rgb = |c: [f32; 3]| [c[0], c[1], c[2], 0.0];
    let Some(l) = lights else {
        let dir = legacy_dir(eye, target);
        return LightU {
            light_dir: [dir.x, dir.y, dir.z, LEGACY_SOFTBOX_X],
            key: [1.0, 1.0, 1.0, 0.0],
            sky: [1.0, 1.0, 1.0, 0.0],
            ground: [1.0, 1.0, 1.0, 0.0],
            point_pos: [[0.0; 4]; MAX_POINT_LIGHTS],
            point_color: [[0.0; 4]; MAX_POINT_LIGHTS],
        };
    };
    let mut point_pos = [[0.0; 4]; MAX_POINT_LIGHTS];
    let mut point_color = [[0.0; 4]; MAX_POINT_LIGHTS];
    for (i, p) in l.points.iter().take(MAX_POINT_LIGHTS).enumerate() {
        point_pos[i] = [p.position[0], p.position[1], p.position[2], p.range];
        point_color[i] = rgb(p.color);
    }
    let [x, y, z] = l.key_dir;
    let mut sky = rgb(l.sky);
    sky[3] = l.points.len().min(MAX_POINT_LIGHTS) as f32;
    LightU { light_dir: [x, y, z, x], key: rgb(l.key), sky, ground: rgb(l.ground), point_pos, point_color }
}
