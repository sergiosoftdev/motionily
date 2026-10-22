//! What a click on the preview lands on: every layer under the pointer, front to back, hit on
//! what it really draws (a curve on its stroke, not the empty box around it), so the editor can
//! select Figma style and click through backdrops.

use crate::{DrawItem, EvalCtx, Layer, LayerContent, Scene, ScreenMap};
use serde::Serialize;

/// Share of the frame a layer must cover to count as a backdrop or overlay when picking.
const COVER_SHARE: f32 = 0.9;
/// Screen px around a stroke that still count as clicking it.
const STROKE_SLOP: f32 = 14.0;

/// A layer under the pointer (`Scene::pick_stack`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    pub id: String,
    /// Covers most of the frame (background, grain, vignette, adjustment): the editor clicks
    /// through it to what is in front of it.
    pub cover: bool,
}

impl Scene {
    /// Every visible layer under scene point (x, y) at `t`, front to back.
    pub fn pick_stack(&self, t: f32, x: f32, y: f32) -> Vec<Hit> {
        let frame = [self.width as f32, self.height as f32];
        let solo = self.solo_mask();
        self.measuring(t, |m| {
            let mut hits: Vec<(f32, usize, Hit)> = Vec::new();
            for (idx, l) in self.layers.iter().enumerate().filter(|(i, l)| l.camera.is_none() && l.visible && solo.as_ref().is_none_or(|s| s[*i])) {
                let Some((b, map)) = self.screen_bounds(idx, t, m) else { continue };
                if !b.contains([x, y]) || !self.shape_hit(l, t, m.ctx, &map, [x, y]) {
                    continue;
                }
                let z = if m.camera.is_some() { self.draw_depth(idx, self.depth(l, t)) } else { 0.0 };
                let [x0, y0, x1, y1] = b.rect();
                let seen = (x1.min(frame[0]) - x0.max(0.0)).max(0.0) * (y1.min(frame[1]) - y0.max(0.0)).max(0.0);
                let cover = l.adjustment || seen >= COVER_SHARE * frame[0] * frame[1];
                hits.push((z, idx, Hit { id: l.id.clone(), cover }));
            }
            // Nearest to the camera first; on a tie, the later layer (drawn on top).
            hits.sort_by(|a, b| a.0.total_cmp(&b.0).then(b.1.cmp(&a.1)));
            hits.into_iter().map(|(_, _, h)| h).collect()
        })
    }

    /// Does screen point `p`, already inside `l`'s box, fall on what `l` draws? Paths count on
    /// their stroke or fill, instances on their layers, everything else on its box.
    pub(crate) fn shape_hit(&self, l: &Layer, t: f32, ctx: &EvalCtx, map: &ScreenMap, p: [f32; 2]) -> bool {
        if !matches!(l.content, LayerContent::Path { .. }) {
            return self.instance_hit(l, t, ctx, map, p);
        }
        let Some(DrawItem::Path(path)) = l.draw_in(l.local_time(t), ctx, &self.parent_xform(l, t, ctx, 0)) else { return true };
        if path.lines.iter().all(|line| line.len() < 2) && path.fills.is_empty() {
            return true; // Not drawn yet (trimmed to nothing): its box keeps it selectable.
        }
        let on_screen = |pts: &[[f32; 2]]| pts.iter().filter_map(|q| map.point(*q)).collect::<Vec<_>>();
        if path.fills.iter().any(|poly| inside(&on_screen(poly), p)) {
            return true;
        }
        let reach = path.stroke.map_or(0.0, |(w, _)| w * map.scale_at(p) / 2.0) + STROKE_SLOP;
        path.lines.iter().any(|line| on_screen(line).windows(2).any(|s| segment_distance(p, s[0], s[1]) <= reach))
    }
}

fn segment_distance(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    let ab = [b[0] - a[0], b[1] - a[1]];
    let len2 = ab[0] * ab[0] + ab[1] * ab[1];
    let u = if len2 > 0.0 { (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2).clamp(0.0, 1.0) } else { 0.0 };
    ((p[0] - a[0] - u * ab[0]).powi(2) + (p[1] - a[1] - u * ab[1]).powi(2)).sqrt()
}

/// Even-odd point in polygon.
fn inside(poly: &[[f32; 2]], p: [f32; 2]) -> bool {
    let mut odd = false;
    for (i, a) in poly.iter().enumerate() {
        let b = poly[(i + 1) % poly.len()];
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]) {
            odd = !odd;
        }
    }
    odd
}

#[cfg(test)]
mod tests {
    use crate::{Op, Scene};

    #[test]
    fn a_curve_is_hit_on_its_stroke_not_its_box() {
        let mut s = Scene::default();
        let ops = Op::parse_list(
            r##"[{"op":"add_layer","layer":{"id":"card","type":"shape","shape":"rect","x":540,"y":960,"w":300,"h":300}},
                {"op":"add_layer","layer":{"id":"thread","type":"path","d":"M 0 0 L 1000 1800","x":540,"y":960,"stroke":{"width":4,"color":"#ff0000"}}}]"##,
        )
        .unwrap();
        s.apply(&ops).unwrap();
        let ids = |x: f32, y: f32| s.pick_stack(0.0, x, y).into_iter().map(|h| h.id).collect::<Vec<_>>();
        // The diagonal crosses the frame's center; a point inside its box but far from the line is not on it.
        assert_eq!(ids(540.0, 960.0), ["thread", "card"]);
        assert_eq!(ids(640.0, 860.0), ["card"]);
        assert_eq!(s.pick(0.0, 640.0, 860.0).as_deref(), Some("card"));
    }
}
