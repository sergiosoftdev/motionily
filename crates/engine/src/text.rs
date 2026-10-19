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
    _pad: f32,
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
        const ATTRS: [wgpu::VertexAttribute; 6] = wgpu::vertex_attr_array![
            0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32x4, 4 => Float32x2, 5 => Float32
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

    fn layout(&mut self, queue: &wgpu::Queue, item: &DrawText, out: &mut Vec<Quad>) {
        let Some(font) = self.pick_font(&item.family, item.weight) else { return };
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

        for (line, h) in lines.iter().zip(&heights) {
            let line_w: f32 = line.iter().map(|w| w.width).sum::<f32>() + space * line.len().saturating_sub(1) as f32;
            let mut x = match item.align {
                TextAlign::Left => item.center[0] - item.max_width / 2.0,
                TextAlign::Center => item.center[0] - line_w / 2.0,
                TextAlign::Right => item.center[0] + item.max_width / 2.0 - line_w,
            };
            let baseline = top + (h - (ascent - descent) * line_scale(line)) / 2.0 + ascent * line_scale(line);
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
                        _pad: 0.0,
                    });
                }
                let px = item.size * w.scale;
                let px_q = ((px / PX_STEP).round() * PX_STEP).clamp(PX_MIN, PX_MAX);
                let k = px / px_q;
                let mut pen = x;
                for ch in w.text.chars() {
                    let Some(g) = self.glyph(queue, font, ch, px_q as u32) else { continue };
                    let m = g.metrics;
                    if m.width > 0 && m.height > 0 {
                        out.push(Quad {
                            pos: [pen + m.xmin as f32 * k, baseline - (m.height as f32 + m.ymin as f32) * k],
                            size: [m.width as f32 * k, m.height as f32 * k],
                            uv: g.uv,
                            color: span_color(span.color),
                            pivot,
                            rotation: item.rotation,
                            _pad: 0.0,
                        });
                    }
                    pen += m.advance_width * k;
                }
                x += w.width + space;
            }
            top += h;
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
                    let width = word.chars().map(|c| f.metrics(c, px).advance_width).sum();
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
