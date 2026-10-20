//! Text: font registry, glyph atlas, layout (wrapping, alignment, spans) and quads.

use crate::{Ctx, ITEM_CAPACITY};
use bytemuck::{Pod, Zeroable};
use scene::{DrawText, Rgba, TextAlign};
use std::collections::HashMap;
use std::ops::Range;
use wgpu::util::DeviceExt;

const ATLAS_SIZE: u32 = 2048;
/// Glyphs are rasterized at sizes rounded to this step, then scaled.
const PX_STEP: f32 = 8.0;
const PX_MIN: f32 = 8.0;
const PX_MAX: f32 = 256.0;
const GLYPH_PAD: u32 = 2;
/// A tiny opaque square in the atlas, used for highlight blocks behind words.
const WHITE: [u32; 2] = [0, 0];
const WHITE_SIZE: u32 = 4;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Quad {
    pos: [f32; 2],
    size: [f32; 2],
    uv: [f32; 4],
    color: [f32; 4],
    pivot: [f32; 2],
    rotation: f32,
    /// Blur radius in scene px (text animators blur units in and out).
    blur: f32,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct GlyphKey {
    font: usize,
    ch: char,
    px: u32,
}

#[derive(Clone, Copy)]
struct Glyph {
    uv: [f32; 4],
    metrics: fontdue::Metrics,
}

struct FontEntry {
    family: String,
    weight: u16,
    font: fontdue::Font,
}

/// Shelf-packed R8 atlas. When full it is wiped and refilled on demand.
struct Atlas {
    texture: wgpu::Texture,
    cursor: [u32; 2],
    row_height: u32,
    glyphs: HashMap<GlyphKey, Glyph>,
}

impl Atlas {
    fn reset(&mut self, queue: &wgpu::Queue) {
        self.glyphs.clear();
        self.cursor = [WHITE_SIZE + GLYPH_PAD, 0];
        self.row_height = WHITE_SIZE;
        upload(queue, &self.texture, WHITE, [WHITE_SIZE, WHITE_SIZE], &[255; (WHITE_SIZE * WHITE_SIZE) as usize]);
    }

    /// Reserve `size` pixels; `None` when the atlas is full.
    fn alloc(&mut self, size: [u32; 2]) -> Option<[u32; 2]> {
        if self.cursor[0] + size[0] > ATLAS_SIZE {
            self.cursor = [0, self.cursor[1] + self.row_height + GLYPH_PAD];
            self.row_height = 0;
        }
        if self.cursor[1] + size[1] > ATLAS_SIZE {
            return None;
        }
        let at = self.cursor;
        self.cursor[0] += size[0] + GLYPH_PAD;
        self.row_height = self.row_height.max(size[1]);
        Some(at)
    }
}

fn upload(queue: &wgpu::Queue, texture: &wgpu::Texture, at: [u32; 2], size: [u32; 2], data: &[u8]) {
    if size[0] == 0 || size[1] == 0 {
        return;
    }
    queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d { x: at[0], y: at[1], z: 0 }, aspect: Default::default() },
        data,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size[0]), rows_per_image: None },
        wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
    );
}

pub struct TextPipeline {
    pipeline: wgpu::RenderPipeline,
    atlas_group: wgpu::BindGroup,
    atlas: Atlas,
    fonts: Vec<FontEntry>,
    quads: wgpu::Buffer,
    capacity: usize,
    /// Quad range of each text item of the current frame.
    item_quads: Vec<Range<u32>>,
}

impl TextPipeline {
    pub fn new(ctx: &Ctx) -> Self {
        let device = ctx.device;
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glyph atlas"),
            size: wgpu::Extent3d { width: ATLAS_SIZE, height: ATLAS_SIZE, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let atlas_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glyph atlas"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let atlas_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glyph atlas"),
            layout: &atlas_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&texture.create_view(&Default::default())),
                },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("text"),
            bind_group_layouts: &[Some(ctx.globals_layout), Some(&atlas_layout)],
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("text.wgsl"));
        const ATTRS: [wgpu::VertexAttribute; 7] = wgpu::vertex_attr_array![
            0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32x4, 4 => Float32x2, 5 => Float32, 6 => Float32
        ];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("text"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Quad>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &ATTRS,
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(ctx.color_target())],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let mut atlas = Atlas { texture, cursor: [0, 0], row_height: 0, glyphs: HashMap::new() };
        atlas.reset(ctx.queue);
        let capacity = ITEM_CAPACITY * 16;
        TextPipeline {
            pipeline,
            atlas_group,
            atlas,
            fonts: Vec::new(),
            quads: make_buffer(device, capacity),
            capacity,
            item_quads: Vec::new(),
        }
    }

    pub fn add_font(&mut self, family: &str, weight: u16, bytes: &[u8]) -> Result<(), String> {
        let font = fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).map_err(str::to_owned)?;
        self.fonts.retain(|f| !(f.family == family && f.weight == weight));
        self.fonts.push(FontEntry { family: family.to_owned(), weight, font });
        Ok(())
    }

    /// Exact family + weight, else the family's closest weight, else the first font.
    fn pick_font(&self, family: &str, weight: u16) -> Option<usize> {
        let same_family = self.fonts.iter().enumerate().filter(|(_, f)| f.family == family);
        same_family
            .min_by_key(|(_, f)| f.weight.abs_diff(weight))
            .map(|(i, _)| i)
            .or(if self.fonts.is_empty() { None } else { Some(0) })
    }

    fn glyph(&mut self, queue: &wgpu::Queue, font: usize, ch: char, px: u32) -> Option<Glyph> {
        let key = GlyphKey { font, ch, px };
        if let Some(g) = self.atlas.glyphs.get(&key) {
            return Some(*g);
        }
        let (metrics, bitmap) = self.fonts[font].font.rasterize(ch, px as f32);
        let size = [metrics.width as u32, metrics.height as u32];
        let at = match self.atlas.alloc(size) {
            Some(at) => at,
            None => {
                // Atlas full: start over; glyphs already placed this frame are re-requested next frame.
                self.atlas.reset(queue);
                self.atlas.alloc(size)?
            }
        };
        upload(queue, &self.atlas.texture, at, size, &bitmap);
        let s = ATLAS_SIZE as f32;
        let uv = [at[0] as f32 / s, at[1] as f32 / s, (at[0] + size[0]) as f32 / s, (at[1] + size[1]) as f32 / s];
        let glyph = Glyph { uv, metrics };
        self.atlas.glyphs.insert(key, glyph);
        Some(glyph)
    }

    pub fn prepare(&mut self, ctx: &Ctx, items: &[DrawText]) {
        let mut quads = Vec::new();
        self.item_quads.clear();
        for item in items {
            let start = quads.len() as u32;
            self.layout(ctx.queue, item, &mut quads);
            self.item_quads.push(start..quads.len() as u32);
        }
        if quads.len() > self.capacity {
            self.capacity = quads.len().next_power_of_two();
            self.quads = make_buffer(ctx.device, self.capacity);
        }
        if !quads.is_empty() {
            ctx.queue.write_buffer(&self.quads, 0, bytemuck::cast_slice(&quads));
        }
    }

    /// Draw text items `range` (indices into this frame's text items).
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, range: Range<u32>) {
        let (Some(first), Some(last)) = (self.item_quads.get(range.start as usize), self.item_quads.get(range.end as usize - 1))
        else {
            return;
        };
        if first.start == last.end {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(1, &self.atlas_group, &[]);
        pass.set_vertex_buffer(0, self.quads.slice(..));
        pass.draw(0..6, first.start..last.end);
    }

    /// Largest size (≤ requested) at which the block fits its box: no word wider than the
    /// wrap width and, when the layer has a height, all lines inside it.
    fn fit_size(&self, font: usize, item: &DrawText) -> f32 {
        // On a path, lay the line out centered and unrotated (the path carries the layer's
        // rotation); `follow_path` aligns it along the path.
        let on_path;
        let item = if item.path.is_some() {
            on_path = DrawText { align: TextAlign::Center, rotation: 0.0, ..item.clone() };
            &on_path
        } else {
            item
        };
        let words = self.measure_words(font, item);
        let space = self.fonts[font].font.metrics(' ', item.size).advance_width;
        let mut k = 1.0_f32;
        for _ in 0..12 {
            let widest = words.iter().map(|w| w.width * k).fold(0.0, f32::max);
            let mut lines = 1;
            let mut x = 0.0;
            for w in &words {
                let extra = if x == 0.0 { w.width * k } else { (space + w.width) * k };
                if x > 0.0 && x + extra > item.max_width {
                    lines += 1;
                    x = w.width * k;
                } else {
                    x += extra;
                }
            }
            let height = lines as f32 * item.size * k * item.line_height;
            if widest <= item.max_width && item.max_height.is_none_or(|h| height <= h) {
                break;
            }
            k *= 0.9;
        }
        item.size * k
    }

    /// Box `[x0, y0, x1, y1]` the visible glyphs of `item` really cover (scene px).
    pub fn ink(&mut self, queue: &wgpu::Queue, item: &DrawText) -> Option<[f32; 4]> {
        let mut quads = Vec::new();
        self.layout(queue, item, &mut quads);
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        for q in quads.iter().filter(|q| q.color[3] > 0.02) {
            let (s, c) = q.rotation.sin_cos();
            for corner in [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]] {
                let p = [q.pos[0] + corner[0] * q.size[0] - q.pivot[0], q.pos[1] + corner[1] * q.size[1] - q.pivot[1]];
                let w = [q.pivot[0] + p[0] * c - p[1] * s, q.pivot[1] + p[0] * s + p[1] * c];
                b = [b[0].min(w[0]), b[1].min(w[1]), b[2].max(w[0]), b[3].max(w[1])];
            }
        }
        (b[0] <= b[2]).then_some(b)
    }

    fn layout(&mut self, queue: &wgpu::Queue, item: &DrawText, out: &mut Vec<Quad>) {
        let Some(font) = self.pick_font(&item.family, item.weight) else { return };
        let original_align = item.align;
        let fitted;
        let item = {
            let size = self.fit_size(font, item);
            if size < item.size {
                fitted = DrawText { size, ..item.clone() };
                &fitted
            } else {
                item
            }
        };
        let words = self.measure_words(font, item);
        let space = self.fonts[font].font.metrics(' ', item.size).advance_width;

        // Greedy wrap.
        let mut lines: Vec<Vec<&MeasuredWord>> = vec![Vec::new()];
        let mut width = 0.0;
        for w in &words {
            let line = lines.last_mut().unwrap();
            let extra = if line.is_empty() { w.width } else { space + w.width };
            if !line.is_empty() && width + extra > item.max_width {
                lines.push(vec![w]);
                width = w.width;
            } else {
                line.push(w);
                width += extra;
            }
        }

        let lm = self.fonts[font].font.horizontal_line_metrics(item.size);
        let (ascent, descent) = lm.map_or((item.size * 0.8, -item.size * 0.2), |m| (m.ascent, m.descent));
        let line_scale = |l: &Vec<&MeasuredWord>| l.iter().map(|w| w.scale).fold(1.0_f32, f32::max);
        let heights: Vec<f32> = lines.iter().map(|l| item.size * item.line_height * line_scale(l)).collect();
        let total: f32 = heights.iter().sum();
        let mut top = item.center[1] - total / 2.0;
        let pivot = item.center;
        // (quad index, char, word, line) of every glyph, for gradients and text animators.
        let mut glyphs: Vec<(usize, usize, usize, usize)> = Vec::new();
        let (mut char_i, mut word_i) = (0usize, 0usize);
        let mut first_baseline = None;
        // Typewriter: characters past `shown` are hidden; the caret sits where typing is.
        let shown = item.reveal.map(|r| r.floor() as usize);
        let mut caret_at: Option<[f32; 2]> = None;
        let mut last_end = [item.center[0], item.center[1]];

        for (line_i, (line, h)) in lines.iter().zip(&heights).enumerate() {
            let line_w: f32 = line.iter().map(|w| w.width).sum::<f32>() + space * line.len().saturating_sub(1) as f32;
            let mut x = match item.align {
                TextAlign::Left => item.center[0] - item.max_width / 2.0,
                TextAlign::Center => item.center[0] - line_w / 2.0,
                TextAlign::Right => item.center[0] + item.max_width / 2.0 - line_w,
            };
            let baseline = top + (h - (ascent - descent) * line_scale(line)) / 2.0 + ascent * line_scale(line);
            first_baseline.get_or_insert(baseline);
            for w in line {
                let span = &item.spans[w.span];
                if let Some(bg) = span.highlight {
                    let pad = item.size * 0.14 * w.scale;
                    let s = ATLAS_SIZE as f32;
                    let c = (WHITE_SIZE / 2) as f32 / s;
                    out.push(Quad {
                        pos: [x - pad, baseline - ascent * w.scale - pad * 0.5],
                        size: [w.width + pad * 2.0, (ascent - descent) * w.scale + pad],
                        uv: [c, c, c, c],
                        color: bg.0,
                        pivot,
                        rotation: item.rotation,
                        blur: 0.0,
                    });
                }
                let px = item.size * w.scale;
                let px_q = ((px / PX_STEP).round() * PX_STEP).clamp(PX_MIN, PX_MAX);
                let k = px / px_q;
                let mut pen = x;
                for ch in w.text.chars() {
                    let Some(g) = self.glyph(queue, font, ch, px_q as u32) else { continue };
                    let m = g.metrics;
                    if shown == Some(char_i) {
                        caret_at = Some([pen, baseline]);
                    }
                    let hidden = shown.is_some_and(|n| char_i >= n);
                    if m.width > 0 && m.height > 0 && !hidden {
                        glyphs.push((out.len(), char_i, word_i, line_i));
                        out.push(Quad {
                            pos: [pen + m.xmin as f32 * k, baseline - (m.height as f32 + m.ymin as f32) * k],
                            size: [m.width as f32 * k, m.height as f32 * k],
                            uv: g.uv,
                            color: span_color(span.color),
                            pivot,
                            rotation: item.rotation,
                            blur: 0.0,
                        });
                    }
                    pen += m.advance_width * k + item.letter_spacing;
                    if !hidden {
                        last_end = [pen, baseline];
                    }
                    char_i += 1;
                }
                word_i += 1;
                x += w.width + space;
            }
            top += h;
        }
        if let Some(g) = &item.gradient {
            recolor(out, &glyphs, g);
        }
        if let Some(alpha) = item.caret.filter(|a| *a > 0.0) {
            let [x, baseline] = caret_at.unwrap_or(last_end);
            let s = ATLAS_SIZE as f32;
            let c = (WHITE_SIZE / 2) as f32 / s;
            let mut color = item.spans.first().map_or([1.0; 4], |sp| span_color(sp.color));
            color[3] *= alpha;
            out.push(Quad {
                pos: [x + item.size * 0.04, baseline - ascent * 0.95],
                size: [(item.size * 0.055).max(2.0), (ascent - descent) * 0.95],
                uv: [c, c, c, c],
                color,
                pivot,
                rotation: item.rotation,
                blur: 0.0,
            });
        }
        if let Some(a) = &item.animator {
            animate(out, &glyphs, a);
        }
        if let (Some((points, offset)), Some(baseline)) = (&item.path, first_baseline) {
            follow_path(out, &glyphs, points, *offset, baseline, original_align);
        }
    }

    fn measure_words(&self, font: usize, item: &DrawText) -> Vec<MeasuredWord> {
        let f = &self.fonts[font].font;
        item.spans
            .iter()
            .enumerate()
            .flat_map(|(i, span)| {
                span.text.split_whitespace().map(move |word| {
                    let px = item.size * span.scale;
                    let width = word.chars().map(|c| f.metrics(c, px).advance_width + item.letter_spacing).sum();
                    MeasuredWord { text: word.to_owned(), width, scale: span.scale, span: i }
                })
            })
            .collect()
    }
}

struct MeasuredWord {
    text: String,
    width: f32,
    scale: f32,
    span: usize,
}

/// Paint glyphs with a gradient laid over the whole text block.
fn recolor(out: &mut [Quad], glyphs: &[(usize, usize, usize, usize)], g: &scene::paint::DrawGradient) {
    let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
    for &(q, ..) in glyphs {
        let Quad { pos, size, .. } = out[q];
        lo = [lo[0].min(pos[0]), lo[1].min(pos[1])];
        hi = [hi[0].max(pos[0] + size[0]), hi[1].max(pos[1] + size[1])];
    }
    let span = [(hi[0] - lo[0]).max(1e-3), (hi[1] - lo[1]).max(1e-3)];
    for &(q, ..) in glyphs {
        let quad = &mut out[q];
        let c = [quad.pos[0] + quad.size[0] / 2.0, quad.pos[1] + quad.size[1] / 2.0];
        let col = g.color_at([(c[0] - lo[0]) / span[0], (c[1] - lo[1]) / span[1]]).0;
        quad.color = [col[0], col[1], col[2], quad.color[3] * col[3]];
    }
}

/// Text animator: every unit (char / word / line) eases from its offset pose to rest.
fn animate(out: &mut [Quad], glyphs: &[(usize, usize, usize, usize)], a: &scene::paint::DrawTextAnim) {
    use scene::paint::TextUnit;
    let (by, .., from, _) = a.anim;
    let unit = |g: &(usize, usize, usize, usize)| match by {
        TextUnit::Char => g.1,
        TextUnit::Word => g.2,
        TextUnit::Line => g.3,
    };
    let count = glyphs.iter().map(|g| unit(g) + 1).max().unwrap_or(0);
    // Center of each unit, to scale and rotate it in place.
    let mut boxes = vec![([f32::MAX; 2], [f32::MIN; 2]); count];
    for g in glyphs {
        let Quad { pos, size, .. } = out[g.0];
        let b = &mut boxes[unit(g)];
        b.0 = [b.0[0].min(pos[0]), b.0[1].min(pos[1])];
        b.1 = [b.1[0].max(pos[0] + size[0]), b.1[1].max(pos[1] + size[1])];
    }
    for g in glyphs {
        let u = unit(g);
        let p = a.progress(u, count);
        if p >= 1.0 {
            continue;
        }
        let inv = 1.0 - p;
        let s = from.scale + (1.0 - from.scale) * p;
        let center = [(boxes[u].0[0] + boxes[u].1[0]) / 2.0, (boxes[u].0[1] + boxes[u].1[1]) / 2.0];
        let q = &mut out[g.0];
        q.pos = [center[0] + (q.pos[0] - center[0]) * s + from.x * inv, center[1] + (q.pos[1] - center[1]) * s + from.y * inv];
        q.size = [q.size[0] * s, q.size[1] * s];
        q.color[3] *= (from.opacity + (1.0 - from.opacity) * p).clamp(0.0, 1.0);
        q.blur = from.blur * s * inv;
        if from.rotation != 0.0 {
            // Spin about the unit center, then the block's own rotation about its pivot: the
            // same as one rotation (sum) about the unit center carried by the block rotation.
            let c = [center[0] + from.x * inv, center[1] + from.y * inv];
            let moved = rotate_about(c, q.pivot, q.rotation);
            q.pos = [q.pos[0] + moved[0] - c[0], q.pos[1] + moved[1] - c[1]];
            q.pivot = moved;
            q.rotation += (from.rotation * inv).to_radians();
        }
    }
}

fn rotate_about(p: [f32; 2], pivot: [f32; 2], angle: f32) -> [f32; 2] {
    let (sn, cs) = angle.sin_cos();
    let d = [p[0] - pivot[0], p[1] - pivot[1]];
    [pivot[0] + d[0] * cs - d[1] * sn, pivot[1] + d[0] * sn + d[1] * cs]
}

/// Lay a laid-out line along a polyline: each glyph goes to the point at its distance along the
/// path, turned to the path direction, keeping its height above the baseline. Glyphs past
/// either end are hidden, so animating the offset makes text crawl in.
fn follow_path(out: &mut [Quad], glyphs: &[(usize, usize, usize, usize)], points: &[[f32; 2]], offset: f32, baseline: f32, align: TextAlign) {
    let mut acc = vec![0.0f32];
    for w in points.windows(2) {
        acc.push(acc.last().unwrap() + (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]));
    }
    let total = *acc.last().unwrap();
    if points.len() < 2 || total <= 0.0 {
        return;
    }
    let (mut lo, mut hi) = (f32::MAX, f32::MIN);
    for &(q, ..) in glyphs {
        lo = lo.min(out[q].pos[0]);
        hi = hi.max(out[q].pos[0] + out[q].size[0]);
    }
    let start = offset
        + match align {
            TextAlign::Left => 0.0,
            TextAlign::Center => (total - (hi - lo)) / 2.0,
            TextAlign::Right => total - (hi - lo),
        };
    for &(qi, ..) in glyphs {
        let q = &mut out[qi];
        let c = [q.pos[0] + q.size[0] / 2.0, q.pos[1] + q.size[1] / 2.0];
        let along = start + c[0] - lo;
        if !(0.0..=total).contains(&along) {
            q.color[3] = 0.0;
            continue;
        }
        let i = acc.partition_point(|d| *d <= along).clamp(1, points.len() - 1);
        let (a, b) = (points[i - 1], points[i]);
        let seg = (acc[i] - acc[i - 1]).max(1e-6);
        let k = ((along - acc[i - 1]) / seg).clamp(0.0, 1.0);
        let angle = (b[1] - a[1]).atan2(b[0] - a[0]);
        let (sn, cs) = angle.sin_cos();
        let up = c[1] - baseline;
        let p = [a[0] + (b[0] - a[0]) * k - sn * up, a[1] + (b[1] - a[1]) * k + cs * up];
        // A per-unit spin from an animator stays on top of the path direction.
        let spin = q.rotation;
        q.pos = [p[0] - q.size[0] / 2.0, p[1] - q.size[1] / 2.0];
        q.pivot = p;
        q.rotation = angle + spin;
    }
}

fn span_color(c: Rgba) -> [f32; 4] {
    c.0
}

fn make_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("text quads"),
        contents: &vec![0u8; capacity * std::mem::size_of::<Quad>()],
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
    })
}
