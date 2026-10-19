//! Scenario backdrops built from primitives: a perspective room (studio, clinic,
//! office) or an isometric city whose blocks rise from the ground.

use crate::{DrawItem, DrawShape, Easing, Palette, Rgba};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioKind {
    EmptyStudio,
    ClinicRoom,
    Office,
    IsoCity,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Scenario {
    pub kind: ScenarioKind,
    /// Seconds the iso city takes to build itself (0 = already built).
    #[serde(default = "default_rise")]
    pub rise: f32,
}

fn default_rise() -> f32 {
    1.6
}

/// A filled convex quad (corners clockwise), in scene pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawPoly {
    pub points: [[f32; 2]; 4],
    pub color: Rgba,
}

fn shade(c: Rgba, k: f32) -> Rgba {
    Rgba([(c.0[0] * k).min(1.0), (c.0[1] * k).min(1.0), (c.0[2] * k).min(1.0), c.0[3]])
}

fn mix(a: Rgba, b: Rgba, t: f32) -> Rgba {
    Rgba(std::array::from_fn(|i| a.0[i] + (b.0[i] - a.0[i]) * t))
}

fn quad(points: [[f32; 2]; 4], color: Rgba) -> DrawItem {
    DrawItem::Poly(DrawPoly { points, color })
}

fn rect(x: f32, y: f32, w: f32, h: f32, radius: f32, color: Rgba) -> DrawItem {
    DrawItem::Shape(DrawShape { center: [x + w / 2.0, y + h / 2.0], size: [w, h], radius, rotation: 0.0, color })
}

/// Isometric projection: world (x, y on the ground, z up) to screen, 30° axes.
pub fn iso(origin: [f32; 2], unit: f32, x: f32, y: f32, z: f32) -> [f32; 2] {
    const COS30: f32 = 0.866_025_4;
    [origin[0] + (x - y) * COS30 * unit, origin[1] + (x + y) * 0.5 * unit - z * unit]
}

/// Box on the iso grid: top, left and right faces in three tones.
fn iso_box(o: [f32; 2], unit: f32, x: f32, y: f32, w: f32, d: f32, h: f32, color: Rgba) -> [DrawItem; 3] {
    let p = |a: f32, b: f32, c: f32| iso(o, unit, a, b, c);
    [
        quad([p(x, y + d, 0.0), p(x + w, y + d, 0.0), p(x + w, y + d, h), p(x, y + d, h)], shade(color, 0.82)),
        quad([p(x + w, y, 0.0), p(x + w, y + d, 0.0), p(x + w, y + d, h), p(x + w, y, h)], shade(color, 0.66)),
        quad([p(x, y, h), p(x + w, y, h), p(x + w, y + d, h), p(x, y + d, h)], shade(color, 1.12)),
    ]
}

/// Back wall + perspective floor shared by the room scenarios. Returns the floor line y.
fn room(out: &mut Vec<DrawItem>, w: f32, h: f32, p: &Palette, wall: Rgba, floor: Rgba) -> f32 {
    let horizon = h * 0.62;
    out.push(rect(0.0, 0.0, w, horizon, 0.0, wall));
    out.push(quad([[-w * 0.6, h], [w * 1.6, h], [w, horizon], [0.0, horizon]], floor));
    // Skirting board for depth.
    out.push(rect(0.0, horizon - h * 0.012, w, h * 0.012, 0.0, shade(wall, 0.85)));
    let _ = p;
    horizon
}

/// Backdrop items for `scenario` at scene time `t`.
pub fn draw_scenario(s: &Scenario, size: [f32; 2], t: f32, p: &Palette) -> Vec<DrawItem> {
    let [w, h] = size;
    let mut out = Vec::new();
    match s.kind {
        ScenarioKind::EmptyStudio => {
            // Infinite cyclorama: soft floor glow and a hint of the curve.
            out.push(rect(0.0, 0.0, w, h, 0.0, p.background));
            out.push(DrawItem::Shape(DrawShape { center: [w / 2.0, h * 0.86], size: [w * 1.6, h * 0.5], radius: h * 0.25, rotation: 0.0, color: mix(p.background, p.surface, 0.6) }));
        }
        ScenarioKind::ClinicRoom => {
            let wall = mix(p.background, p.surface, 0.5);
            let floor_y = room(&mut out, w, h, p, wall, shade(p.background, 0.9));
            // Window with light.
            out.push(rect(w * 0.08, h * 0.12, w * 0.32, h * 0.22, w * 0.01, mix(p.accent, p.surface, 0.7)));
            out.push(rect(w * 0.235, h * 0.12, w * 0.012, h * 0.22, 0.0, wall));
            // Treatment bed (camilla): mattress, pillow, legs.
            let bed_y = floor_y + h * 0.04;
            out.push(rect(w * 0.42, bed_y + h * 0.05, w * 0.015, h * 0.09, 0.0, shade(p.text, 0.9)));
            out.push(rect(w * 0.88, bed_y + h * 0.05, w * 0.015, h * 0.09, 0.0, shade(p.text, 0.9)));
            out.push(rect(w * 0.38, bed_y, w * 0.56, h * 0.06, w * 0.02, p.primary));
            out.push(rect(w * 0.82, bed_y - h * 0.018, w * 0.1, h * 0.03, w * 0.015, p.surface));
            // Wall poster: body map.
            out.push(rect(w * 0.62, h * 0.14, w * 0.2, h * 0.26, w * 0.008, p.surface));
            out.push(DrawItem::Shape(DrawShape { center: [w * 0.72, h * 0.2], size: [w * 0.05, w * 0.05], radius: w * 0.025, rotation: 0.0, color: shade(p.primary, 0.9) }));
            out.push(rect(w * 0.705, h * 0.225, w * 0.03, h * 0.12, w * 0.015, shade(p.primary, 0.9)));
        }
        ScenarioKind::Office => {
            let wall = mix(p.background, p.surface, 0.35);
            let floor_y = room(&mut out, w, h, p, wall, shade(p.background, 0.88));
            // Desk with monitor, plant.
            out.push(rect(w * 0.1, floor_y + h * 0.02, w * 0.6, h * 0.025, w * 0.005, shade(p.text, 1.0)));
            out.push(rect(w * 0.14, floor_y + h * 0.045, w * 0.02, h * 0.11, 0.0, shade(p.text, 0.9)));
            out.push(rect(w * 0.64, floor_y + h * 0.045, w * 0.02, h * 0.11, 0.0, shade(p.text, 0.9)));
            out.push(rect(w * 0.28, floor_y - h * 0.11, w * 0.26, h * 0.13, w * 0.012, p.text));
            out.push(rect(w * 0.295, floor_y - h * 0.1, w * 0.23, h * 0.105, w * 0.006, mix(p.accent, p.surface, 0.4)));
            out.push(rect(w * 0.4, floor_y - h * 0.0, w * 0.02, h * 0.02, 0.0, p.text));
            out.push(rect(w * 0.8, floor_y - h * 0.02, w * 0.1, h * 0.09, w * 0.02, shade(p.accent, 0.8)));
            for (dx, dy, r) in [(0.82, -0.08, 0.05), (0.88, -0.1, 0.045), (0.85, -0.13, 0.04)] {
                out.push(DrawItem::Shape(DrawShape { center: [w * dx, floor_y + h * dy], size: [w * r * 2.0, w * r * 2.0], radius: w * r, rotation: 0.0, color: p.primary }));
            }
        }
        ScenarioKind::IsoCity => {
            out.push(rect(0.0, 0.0, w, h, 0.0, p.background));
            let unit = w * 0.085;
            let origin = [w / 2.0, h * 0.36];
            // Ground plate.
            let g = |x: f32, y: f32| iso(origin, unit, x, y, 0.0);
            out.push(quad([g(-0.5, -0.5), g(6.5, -0.5), g(6.5, 6.5), g(-0.5, 6.5)], shade(p.surface, 0.95)));
            // Blocks back to front so nearer ones overlap farther ones.
            const HEIGHTS: [[f32; 6]; 6] = [
                [3.0, 1.5, 0.0, 2.2, 1.0, 2.8],
                [1.2, 0.0, 2.6, 0.0, 1.8, 0.0],
                [0.0, 2.0, 1.0, 3.4, 0.0, 1.4],
                [2.4, 0.0, 0.0, 1.2, 2.0, 0.8],
                [1.0, 1.6, 2.8, 0.0, 1.1, 0.0],
                [0.0, 0.9, 0.0, 1.7, 0.0, 2.2],
            ];
            let palette = [p.primary, p.accent, p.surface, mix(p.primary, p.accent, 0.5)];
            for (iy, row) in HEIGHTS.iter().enumerate() {
                for (ix, &height) in row.iter().enumerate() {
                    if height == 0.0 {
                        continue;
                    }
                    let delay = (ix + iy) as f32 * 0.06;
                    let grow = if s.rise <= 0.0 { 1.0 } else { Easing::Back.apply(((t - delay) / (s.rise * 0.5)).clamp(0.0, 1.0)) };
                    if grow <= 0.0 {
                        continue;
                    }
                    let color = palette[(ix * 3 + iy) % palette.len()];
                    out.extend(iso_box(origin, unit, ix as f32 + 0.1, iy as f32 + 0.1, 0.8, 0.8, height * grow, color));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_projection_axes() {
        let o = [100.0, 100.0];
        assert_eq!(iso(o, 10.0, 0.0, 0.0, 0.0), o);
        let x = iso(o, 10.0, 1.0, 0.0, 0.0);
        let y = iso(o, 10.0, 0.0, 1.0, 0.0);
        assert!(x[0] > o[0] && y[0] < o[0], "x goes right, y goes left");
        assert_eq!(x[1], y[1]);
        assert_eq!(iso(o, 10.0, 0.0, 0.0, 1.0), [100.0, 90.0]);
    }

    #[test]
    fn iso_city_builds_up_over_time() {
        let s = Scenario { kind: ScenarioKind::IsoCity, rise: 1.6 };
        let p = crate::StylePreset::Clean.palette();
        let early = draw_scenario(&s, [1080.0, 1920.0], 0.0, &p).len();
        let late = draw_scenario(&s, [1080.0, 1920.0], 3.0, &p).len();
        assert!(late > early);
    }
}
