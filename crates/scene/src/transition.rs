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
            DrawItem::Shape(DrawShape { center: [cx, h / 2.0], size: [width, h * 1.2], radius: 0.0, rotation: 0.0, color })
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
        match self {
            DrawItem::Shape(shape) => {
                shape.center = [origin[0] + (shape.center[0] - origin[0]) * s, origin[1] + (shape.center[1] - origin[1]) * s];
                shape.size = [shape.size[0] * s, shape.size[1] * s];
                shape.radius *= s;
            }
            DrawItem::Text(text) => {
                text.center = [origin[0] + (text.center[0] - origin[0]) * s, origin[1] + (text.center[1] - origin[1]) * s];
                text.size *= s;
                text.max_width *= s;
                text.max_height = text.max_height.map(|h| h * s);
            }
            DrawItem::Poly(poly) => {
                for p in &mut poly.points {
                    *p = [origin[0] + (p[0] - origin[0]) * s, origin[1] + (p[1] - origin[1]) * s];
                }
            }
            DrawItem::Group(items) => items.iter_mut().for_each(|i| i.scale_about(origin, s)),
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
