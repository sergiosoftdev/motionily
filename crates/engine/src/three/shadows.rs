//! Key-light shadow map for the 3D stage: depth seen from the key light in a 2048² texture,
//! fitted every frame around the props (and the floor their shadows fall on), then sampled in
//! `mesh.wgsl` with 16 hardware-filtered comparisons on a rotated grid (soft PCF). Uses only what
//! WebGL2 has too: a 24-bit depth texture, a comparison sampler and `textureSampleCompareLevel`
//! (naga writes `textureLod(sampler2DShadow, …)`, valid GLSL ES 3.0).

use glam::{Mat4, Vec3};

pub const SHADOW_SIZE: u32 = 2048;
pub const SHADOW_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;
/// Longest shadow kept (m) when the key light is low.
const MAX_REACH: f32 = 40.0;
/// Below this height of the key direction (≈1°) there are no shadows.
const MIN_LIGHT_Y: f32 = 0.02;
/// Light-space margin around casters and receivers (m).
const MARGIN: f32 = 0.25;
/// Shadow edge half-width (m) at softness 0 and its growth up to softness 1.
const PENUMBRA_MIN: f32 = 0.005;
const PENUMBRA_SOFT: f32 = 0.12;

/// A depth texture for the shadow map (`size` = 1 for the placeholder bound when off).
pub fn depth_view(device: &wgpu::Device, size: u32) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("stage shadow map"),
            size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: SHADOW_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&Default::default())
}

/// `textureSampleCompareLevel` sampler: 1 where the surface is not farther than the map.
pub fn comparison_sampler(device: &wgpu::Device) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("stage shadow sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        compare: Some(wgpu::CompareFunction::LessEqual),
        ..Default::default()
    })
}

/// Where the shadow map looks and how to sample it this frame.
#[derive(Debug, Clone, Copy)]
pub struct Fit {
    /// World -> shadow clip space.
    pub light_vp: Mat4,
    /// `frame.shadow` uniform: on, tap spacing (uv), depth bias, normal offset (m).
    pub params: [f32; 4],
}

/// Fit the key light's orthographic view around `casters` (a world box) and the floor (y = 0)
/// patch their shadows reach. `dir` points toward the light. `None` when the light is too low.
pub fn fit(dir: Vec3, casters: (Vec3, Vec3), softness: f32) -> Option<Fit> {
    let dir = dir.normalize_or_zero();
    if dir.y < MIN_LIGHT_Y {
        return None;
    }
    let (lo, hi) = casters;
    let mut points = Vec::with_capacity(16);
    for i in 0..8 {
        let c = Vec3::new([lo.x, hi.x][i & 1], [lo.y, hi.y][(i >> 1) & 1], [lo.z, hi.z][(i >> 2) & 1]);
        points.push(c);
        if c.y > 0.0 {
            // Where this corner's shadow lands on the floor.
            points.push(c - dir * (c.y / dir.y).min(MAX_REACH));
        }
    }
    let center = (lo + hi) * 0.5;
    let up = if dir.y > 0.99 { Vec3::Z } else { Vec3::Y };
    let view = super::look_at_rh(center + dir, center, up);
    let (mut a, mut b) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for p in &points {
        let q = view.transform_point3(*p);
        a = a.min(q);
        b = b.max(q);
    }
    let half = ((b.x - a.x).max(b.y - a.y) / 2.0 + MARGIN).max(0.5);
    let texel = 2.0 * half / SHADOW_SIZE as f32;
    // Snap the window to whole texels so moving props do not make the edges crawl.
    let snap = |v: f32| (v / texel).round() * texel;
    let (cx, cy) = (snap((a.x + b.x) / 2.0), snap((a.y + b.y) / 2.0));
    // The view looks down -z: depth = -z.
    let (near, far) = (-b.z - MARGIN, -a.z + MARGIN);
    let proj = ortho(cx - half, cx + half, cy - half, cy + half, near, far);
    let penumbra = PENUMBRA_MIN + PENUMBRA_SOFT * softness.clamp(0.0, 1.0);
    // 4×4 taps span 3 spacings: the edge blurs over ±penumbra.
    let spacing = (2.0 * penumbra / 3.0) / (2.0 * half);
    let bias = 1.5 * texel / (far - near);
    Some(Fit { light_vp: proj * view, params: [1.0, spacing, bias, texel * 1.5] })
}

/// Right-handed orthographic projection of a view-space box, WebGPU 0..1 depth (`near`/`far` are
/// distances along -z).
fn ortho(left: f32, right: f32, bottom: f32, top: f32, near: f32, far: f32) -> Mat4 {
    let (w, h, d) = (right - left, top - bottom, far - near);
    Mat4::from_cols(
        glam::Vec4::new(2.0 / w, 0.0, 0.0, 0.0),
        glam::Vec4::new(0.0, 2.0 / h, 0.0, 0.0),
        glam::Vec4::new(0.0, 0.0, -1.0 / d, 0.0),
        glam::Vec4::new(-(right + left) / w, -(top + bottom) / h, -near / d, 1.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fit_covers_casters_and_the_floor_their_shadow_reaches() {
        let dir = Vec3::new(-1.0, 0.3, 0.2).normalize();
        let casters = (Vec3::new(-0.5, 0.0, -0.5), Vec3::new(0.5, 2.0, 0.5));
        let fit = fit(dir, casters, 0.5).unwrap();
        let clip = |p: Vec3| fit.light_vp.project_point3(p);
        // The top of the caster and the tip of its long shadow are both inside the map.
        let top = Vec3::new(0.5, 2.0, 0.5);
        let tip = top - dir * (top.y / dir.y);
        for p in [top, tip, Vec3::new(-0.5, 0.0, -0.5)] {
            let c = clip(p);
            assert!(c.x.abs() <= 1.0 && c.y.abs() <= 1.0 && (0.0..=1.0).contains(&c.z), "{p} -> {c}");
        }
        // The caster's top is nearer the light than the floor point it shades.
        assert!(clip(top).z < clip(tip).z);
        assert!(super::fit(Vec3::new(1.0, 0.0, 0.0), casters, 0.5).is_none(), "no shadows at the horizon");
    }
}
