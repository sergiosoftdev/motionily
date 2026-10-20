//! 3D text: the fonts the host registers (the same TTF/OTF bytes as 2D text) and glyph outlines laid
//! out into flat contours in meters. The scene measures them (to frame object layers) and the engine
//! extrudes them into meshes. Fonts live outside `Scene` so loading a scene never drops them.

use crate::{Geometry, TextAlign};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use ttf_parser::{Face, GlyphId, OutlineBuilder};

/// Max curve flattening error as a share of the em (≈ 0.25 px on a word 1000 px tall).
const FLATTEN_TOLERANCE_EM: f32 = 0.0025;
const MAX_CURVE_SEGMENTS: f32 = 48.0;
/// Cached layouts before the cache starts over (recipes are few; animated text is rare).
const MAX_CACHED: usize = 256;

struct FontFile {
    family: String,
    weight: u16,
    bytes: Rc<Vec<u8>>,
}

thread_local! {
    static FONTS: RefCell<Vec<FontFile>> = const { RefCell::new(Vec::new()) };
    static CACHE: RefCell<HashMap<String, Rc<TextOutline>>> = RefCell::new(HashMap::new());
}

/// One closed outline in meters. Along each edge `a -> b` the wall faces `sign * (dy, -dx)`:
/// outward from the solid, whatever winding convention the font uses.
#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    pub points: Vec<[f32; 2]>,
    pub sign: f32,
}

/// A laid-out 3D text, centered on its ink box (x right, y up, meters).
#[derive(Debug, Clone, PartialEq)]
pub struct TextOutline {
    pub contours: Vec<Contour>,
    /// Half width and half height of the ink box.
    pub half: [f32; 2],
    /// `family/weight` of the font really used (it changes when a missing font arrives).
    pub font: String,
}

/// Register a font for 3D text (call with the bytes given to the 2D text renderer).
pub fn register(family: &str, weight: u16, bytes: &[u8]) -> Result<(), String> {
    Face::parse(bytes, 0).map_err(|e| format!("font {family} {weight}: {e}"))?;
    FONTS.with(|f| {
        let mut fonts = f.borrow_mut();
        fonts.retain(|x| !(x.family == family && x.weight == weight));
        fonts.push(FontFile { family: family.to_owned(), weight, bytes: Rc::new(bytes.to_vec()) });
    });
    // A layout may have used a fallback font: measure again with the new one.
    CACHE.with(|c| c.borrow_mut().clear());
    Ok(())
}

/// Exact family + weight, else the family's closest weight, else the first font (as 2D text does).
fn pick(fonts: &[FontFile], family: Option<&str>, weight: u16) -> Option<usize> {
    fonts
        .iter()
        .enumerate()
        .filter(|(_, f)| family.is_some_and(|name| f.family == name))
        .min_by_key(|(_, f)| f.weight.abs_diff(weight))
        .map(|(i, _)| i)
        .or(if fonts.is_empty() { None } else { Some(0) })
}

/// The outline of a `Geometry::Text`, or `None` for other shapes and while no font is registered.
pub fn outline(g: &Geometry) -> Option<Rc<TextOutline>> {
    let Geometry::Text { text, size, family, weight, align, letter_spacing, line_height, .. } = g else { return None };
    let key = g.key();
    if let Some(hit) = CACHE.with(|c| c.borrow().get(&key).cloned()) {
        return Some(hit);
    }
    let (bytes, font) = FONTS.with(|f| {
        let fonts = f.borrow();
        let i = pick(&fonts, family.as_deref(), weight.unwrap_or(DEFAULT_WEIGHT))?;
        Some((fonts[i].bytes.clone(), format!("{}/{}", fonts[i].family, fonts[i].weight)))
    })?;
    let face = Face::parse(&bytes, 0).ok()?;
    let laid = Rc::new(layout(&face, text, *size, *align, *letter_spacing, *line_height, font));
    CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        if cache.len() >= MAX_CACHED {
            cache.clear();
        }
        cache.insert(key, laid.clone());
    });
    Some(laid)
}

/// Weight when neither the node nor the typography names one.
pub const DEFAULT_WEIGHT: u16 = 700;

fn kerning(face: &Face, left: GlyphId, right: GlyphId) -> f32 {
    face.tables()
        .kern
        .and_then(|t| t.subtables.into_iter().filter(|s| s.horizontal && !s.variable).find_map(|s| s.glyphs_kerning(left, right)))
        .map_or(0.0, f32::from)
}

fn layout(face: &Face, text: &str, size: f32, align: TextAlign, letter_spacing: f32, line_height: f32, font: String) -> TextOutline {
    let upem = f32::from(face.units_per_em().max(1));
    let k = size / upem;
    let tolerance = FLATTEN_TOLERANCE_EM * upem;
    let mut contours = Vec::new();
    for (row, line) in text.split('\n').enumerate() {
        // Pen positions in font units, then the line is aligned around x = 0.
        let mut placed: Vec<(GlyphId, f32)> = Vec::new();
        let mut pen = 0.0;
        let mut prev: Option<GlyphId> = None;
        for ch in line.chars() {
            let Some(id) = face.glyph_index(ch) else { continue };
            if let Some(p) = prev {
                pen += kerning(face, p, id);
            }
            placed.push((id, pen));
            pen += f32::from(face.glyph_hor_advance(id).unwrap_or(0)) + letter_spacing * upem;
            prev = Some(id);
        }
        let width = (pen - if placed.is_empty() { 0.0 } else { letter_spacing * upem }) * k;
        let shift = match align {
            TextAlign::Left => 0.0,
            TextAlign::Center => -width / 2.0,
            TextAlign::Right => -width,
        };
        let baseline = -(row as f32) * line_height * size;
        for (id, x) in placed {
            let mut flat = Flatten { tolerance, ..Flatten::default() };
            if face.outline_glyph(id, &mut flat).is_none() {
                continue;
            }
            flat.finish();
            // The glyph's biggest contour is solid: its winding tells which side the font fills.
            let area = |c: &[[f32; 2]]| c.iter().zip(c.iter().cycle().skip(1)).map(|(a, b)| a[0] * b[1] - b[0] * a[1]).sum::<f32>();
            let Some(sign) = flat.contours.iter().map(|c| area(c)).max_by(|a, b| a.abs().total_cmp(&b.abs())).map(f32::signum) else { continue };
            for c in flat.contours {
                let points = c.iter().map(|p| [(x + p[0]) * k + shift, p[1] * k + baseline]).collect();
                contours.push(Contour { points, sign });
            }
        }
    }
    // Center on the ink box.
    let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
    for p in contours.iter().flat_map(|c| &c.points) {
        lo = [lo[0].min(p[0]), lo[1].min(p[1])];
        hi = [hi[0].max(p[0]), hi[1].max(p[1])];
    }
    if contours.is_empty() {
        return TextOutline { contours, half: [0.0, 0.0], font };
    }
    let center = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0];
    for c in &mut contours {
        c.points.iter_mut().for_each(|p| *p = [p[0] - center[0], p[1] - center[1]]);
    }
    TextOutline { contours, half: [(hi[0] - lo[0]) / 2.0, (hi[1] - lo[1]) / 2.0], font }
}

/// Collects a glyph outline as closed polylines (font units), curves flattened within `tolerance`.
#[derive(Default)]
struct Flatten {
    tolerance: f32,
    contours: Vec<Vec<[f32; 2]>>,
    current: Vec<[f32; 2]>,
}

impl Flatten {
    fn last(&self) -> [f32; 2] {
        self.current.last().copied().unwrap_or([0.0, 0.0])
    }

    fn push(&mut self, p: [f32; 2]) {
        if self.current.last() != Some(&p) {
            self.current.push(p);
        }
    }

    fn finish(&mut self) {
        let mut c = std::mem::take(&mut self.current);
        if c.len() > 1 && c.first() == c.last() {
            c.pop();
        }
        if c.len() >= 3 {
            self.contours.push(c);
        }
    }

    /// Segments so a curve with second difference `dd` deviates less than the tolerance.
    fn segments(&self, dd: f32, factor: f32) -> usize {
        (factor * dd / self.tolerance.max(1e-3)).sqrt().ceil().clamp(1.0, MAX_CURVE_SEGMENTS) as usize
    }
}

impl OutlineBuilder for Flatten {
    fn move_to(&mut self, x: f32, y: f32) {
        self.finish();
        self.current.push([x, y]);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.push([x, y]);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let [x0, y0] = self.last();
        let dd = (x0 - 2.0 * x1 + x).hypot(y0 - 2.0 * y1 + y);
        let n = self.segments(dd, 0.125);
        for i in 1..=n {
            let t = i as f32 / n as f32;
            let u = 1.0 - t;
            self.push([u * u * x0 + 2.0 * u * t * x1 + t * t * x, u * u * y0 + 2.0 * u * t * y1 + t * t * y]);
        }
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let [x0, y0] = self.last();
        let dd = (x0 - 2.0 * x1 + x2).hypot(y0 - 2.0 * y1 + y2).max((x1 - 2.0 * x2 + x).hypot(y1 - 2.0 * y2 + y));
        let n = self.segments(dd, 0.75);
        for i in 1..=n {
            let t = i as f32 / n as f32;
            let u = 1.0 - t;
            let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            self.push([a * x0 + b * x1 + c * x2 + d * x, a * y0 + b * y1 + c * y2 + d * y]);
        }
    }

    fn close(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTER_700: &[u8] = include_bytes!("../../../apps/web/public/fonts/Inter-700.ttf");

    fn word(text: &str) -> Geometry {
        Geometry::Text { text: text.to_owned(), size: 1.0, depth: 0.2, family: Some("Inter".into()), weight: Some(700), align: TextAlign::Center, letter_spacing: 0.0, line_height: 1.2 }
    }

    #[test]
    fn lays_out_a_word_centered_on_its_ink() {
        register("Inter", 700, INTER_700).unwrap();
        let o = outline(&word("Lumen")).unwrap();
        assert_eq!(o.font, "Inter/700");
        // A 5-letter bold word is a few ems wide and about one cap-height tall.
        assert!(o.half[0] > 1.0 && o.half[0] < 2.0, "{:?}", o.half);
        assert!(o.half[1] > 0.3 && o.half[1] < 0.45, "{:?}", o.half);
        let (lo, hi) = o.contours.iter().flat_map(|c| &c.points).fold(([f32::MAX; 2], [f32::MIN; 2]), |(lo, hi), p| ([lo[0].min(p[0]), lo[1].min(p[1])], [hi[0].max(p[0]), hi[1].max(p[1])]));
        assert!((lo[0] + hi[0]).abs() < 1e-3 && (lo[1] + hi[1]).abs() < 1e-3);
        assert_eq!(o.contours.len(), 5, "one contour per letter (Inter draws e as one)");
        // "o" is a solid plus its counter; both walls face out of the solid with the glyph's sign.
        let o2 = outline(&word("o")).unwrap();
        assert_eq!(o2.contours.len(), 2);
        assert!(o2.contours.iter().all(|c| c.sign == o2.contours[0].sign));
    }

    #[test]
    fn lines_stack_down_and_unknown_fonts_fall_back() {
        register("Inter", 700, INTER_700).unwrap();
        let one = outline(&word("Hi")).unwrap();
        let two = outline(&word("Hi\nHi")).unwrap();
        assert!(two.half[1] > one.half[1] * 2.0);
        let mut other = word("Hi");
        if let Geometry::Text { family, .. } = &mut other {
            *family = Some("Nope".into());
        }
        assert_eq!(outline(&other).unwrap().font, "Inter/700");
    }
}
