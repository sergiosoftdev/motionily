//! Transitions between scenes, drawn on top of (or around) the frame's items.

use crate::{DrawItem, DrawShape, Easing, Palette, Rgba, Scene, TransitionKind};
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;

/// `{"at":3,"use":"transition/shape_wipe","duration":0.6}`: a cut at `at` seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitionRef {
    /// Seconds: the moment the old scene gives way to the new one.
    pub at: f32,
    #[serde(rename = "use")]
    pub key: String,
    /// Seconds, centered on `at`.
    #[serde(default = "default_duration")]
    pub duration: f32,
}

fn default_duration() -> f32 {
    0.6
}

const WHITE: Rgba = Rgba([1.0, 1.0, 1.0, 1.0]);

/// Add or reshape items for every transition active at `t`.
pub(crate) fn apply(scene: &Scene, palette: &Palette, t: f32, items: &mut Vec<DrawItem>) {
    let (w, h) = (scene.width as f32, scene.height as f32);
    for tr in &scene.transitions {
        let half = tr.duration.max(0.01) / 2.0;
        if (t - tr.at).abs() >= half {
            continue;
        }
        let Some(template) = scene.library.transitions.get(&tr.key) else { continue };
        // 0 at the start of the transition, 0.5 at the cut, 1 at the end.
        let p = (t - (tr.at - half)) / (2.0 * half);
        let full = |cx: f32, width: f32, color: Rgba| {
            DrawItem::Shape(DrawShape { center: [cx, h / 2.0], size: [width, h * 1.2], radius: 0.0, rotation: 0.0, color, style: Default::default() })
        };
        match template.kind {
            TransitionKind::ShapeWipe => {
                let e = Easing::EaseInOut.apply(p);
                items.push(full(-w * 0.6 + e * w * 2.2, w * 1.2, palette.primary));
            }
            TransitionKind::FlashCut => {
                let mut c = WHITE;
                c.0[3] = 1.0 - (p * 2.0 - 1.0).abs();
                items.push(full(w / 2.0, w, c));
            }
            TransitionKind::PageFlip => {
                // A sheet hinged on the left edge opens to cover the frame, then folds away.
                let width = w * (PI * p).sin();
                items.push(full(width / 2.0, width, palette.surface));
            }
            TransitionKind::ZoomThrough => {
                // Dive into the center before the cut, arrive from it after.
                let q = if p < 0.5 { p * 2.0 } else { (1.0 - p) * 2.0 };
                let s = 1.0 + q.powi(3) * 5.0;
                for item in items.iter_mut() {
                    item.scale_about([w / 2.0, h / 2.0], s);
                }
                let mut c = palette.background;
                c.0[3] = q.powi(4);
                items.push(full(w / 2.0, w, c));
            }
        }
    }
}

impl DrawItem {
    /// Scale the item around a point, as if the camera zoomed.
    pub fn scale_about(&mut self, origin: [f32; 2], s: f32) {
        self.affine(origin, s, [0.0, 0.0]);
    }

    /// `p -> origin + (p - origin) * s + shift` on everything the item draws.
    pub fn affine(&mut self, origin: [f32; 2], s: f32, shift: [f32; 2]) {
        self.transform(origin, s, 0.0, shift);
    }

    /// `p -> origin + rot(p - origin, angle) * s + shift` on everything the item draws (`angle` in
    /// radians, clockwise like layer rotation): the 2.5D camera's depth scale and roll.
    pub fn transform(&mut self, origin: [f32; 2], s: f32, angle: f32, shift: [f32; 2]) {
        let (sin, cos) = angle.sin_cos();
        let turn = |v: [f32; 2]| [v[0] * cos - v[1] * sin, v[0] * sin + v[1] * cos];
        let map = |p: [f32; 2]| {
            let q = turn([p[0] - origin[0], p[1] - origin[1]]);
            [origin[0] + q[0] * s + shift[0], origin[1] + q[1] * s + shift[1]]
        };
        match self {
            DrawItem::Shape(shape) => {
                shape.center = map(shape.center);
                shape.rotation += angle;
                shape.size = [shape.size[0] * s, shape.size[1] * s];
                shape.radius *= s;
                shape.style.soft *= s;
                shape.style.stroke = shape.style.stroke.map(|(w, c)| (w * s, c));
                shape.style.inner = shape.style.inner.map(|(o, b, c)| ([o[0] * s, o[1] * s], b * s, c));
                shape.style.bevel = shape.style.bevel.map(|[w, k]| [w * s, k]);
            }
            DrawItem::Text(text) => {
                text.center = map(text.center);
                text.rotation += angle;
                text.size *= s;
                text.max_width *= s;
                text.letter_spacing *= s;
                text.max_height = text.max_height.map(|h| h * s);
                if let Some((points, offset)) = &mut text.path {
                    points.iter_mut().for_each(|p| *p = map(*p));
                    *offset *= s;
                }
            }
            DrawItem::Image(img) => {
                img.center = map(img.center);
                img.rotation += angle;
                img.size = [img.size[0] * s, img.size[1] * s];
                img.radius *= s;
            }
            DrawItem::Poly(poly) => {
                for p in &mut poly.points {
                    *p = map(*p);
                }
            }
            DrawItem::Group(items) => items.iter_mut().for_each(|i| i.transform(origin, s, angle, shift)),
            DrawItem::Path(path) => {
                path.lines.iter_mut().chain(path.fills.iter_mut()).flatten().for_each(|p| *p = map(*p));
                let (lo, hi) = path.bounds;
                path.bounds = if angle == 0.0 {
                    (map(lo), map(hi))
                } else {
                    // The box around the turned corners (gradients and hit-tests stay upright).
                    let corners = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]].map(map);
                    let fold = |f: fn(f32, f32) -> f32, k: usize| corners.iter().map(|c| c[k]).reduce(f).unwrap_or_default();
                    ([fold(f32::min, 0), fold(f32::min, 1)], [fold(f32::max, 0), fold(f32::max, 1)])
                };
                if let Some(g) = &mut path.gradient {
                    g.angle += angle;
                }
                path.stroke = path.stroke.map(|(w, c)| (w * s, c));
            }
            DrawItem::Object(o) => {
                o.center = map(o.center);
                o.rotation += angle;
                o.size = [o.size[0] * s, o.size[1] * s];
                if let Some(shadow) = &mut o.contact {
                    shadow.center = map(shadow.center);
                    shadow.rotation += angle;
                    shadow.size = [shadow.size[0] * s, shadow.size[1] * s];
                    shadow.style.soft *= s;
                }
            }
            DrawItem::Fx(fx) => {
                fx.items.iter_mut().chain(fx.samples.iter_mut().flatten()).for_each(|i| i.transform(origin, s, angle, shift));
                if let Some((m, _)) = &mut fx.matte {
                    m.iter_mut().for_each(|i| i.transform(origin, s, angle, shift));
                }
                for e in &mut fx.effects {
                    e.scale(s);
                    // Drop shadows fall the same way in the rolled picture.
                    if let crate::paint::DrawEffect::Shadow { offset, .. } = e {
                        *offset = turn(*offset);
                    }
                }
            }
            // Zoom the 3D camera in: shrink the view distance.
            DrawItem::Stage(stage) => {
                let c = &mut stage.camera;
                let k = 1.0 / s;
                c.eye = std::array::from_fn(|i| c.target[i] + (c.eye[i] - c.target[i]) * k);
                c.ortho *= k;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Library, TransitionTemplate};

    fn scene_with(kind: TransitionKind) -> Scene {
        let mut s = Scene::default();
        s.library = Library::default();
        s.library.transitions.insert("transition/x".into(), TransitionTemplate { kind });
        s.transitions.push(TransitionRef { at: 2.0, key: "transition/x".into(), duration: 0.6 });
        s
    }

    #[test]
    fn transitions_only_draw_inside_their_window() {
        let s = scene_with(TransitionKind::FlashCut);
        assert!(s.frame(1.0).is_empty());
        assert_eq!(s.frame(2.0).len(), 1);
        assert!(s.frame(2.4).is_empty());
    }

    #[test]
    fn flash_peaks_at_the_cut() {
        let s = scene_with(TransitionKind::FlashCut);
        let DrawItem::Shape(at_cut) = &s.frame(2.0)[0] else { panic!() };
        let DrawItem::Shape(early) = &s.frame(1.8)[0] else { panic!() };
        assert!(at_cut.color.0[3] > 0.99);
        assert!(early.color.0[3] < at_cut.color.0[3]);
    }
}
