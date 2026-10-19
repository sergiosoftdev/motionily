//! GPU renderer. Knows nothing about the browser, React or files: it receives a
//! [`Scene`] and a time, and draws one frame into a wgpu surface. The host
//! (WASM bindings today, Tauri/native later) creates the surface.
//!
//! Each kind of [`DrawItem`] has its own pipeline module (`shapes.rs`, …) with
//! the same shape: `new(&Ctx)`, `prepare(&Ctx, &[Item])` once per frame, then
//! `draw(pass, range)` for every consecutive run of that kind, so layer order is
//! kept across kinds.

mod polys;
mod post;
mod shapes;
mod text;

use bytemuck::{Pod, Zeroable};
use polys::PolyPipeline;
use scene::{DrawItem, DrawPoly, DrawShape, DrawText, Scene};
use post::{PostColors, PostPass};
use shapes::ShapePipeline;
use text::TextPipeline;
use std::ops::Range;

/// Initial per-pipeline instance capacity; buffers grow as needed.
pub(crate) const ITEM_CAPACITY: usize = 64;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    scene_size: [f32; 2],
    linearize: f32,
    /// Seconds into the scene, for time-based effects.
    time: f32,
}

/// What every pipeline needs to build and upload. Group 0 is always the globals uniform.
pub struct Ctx<'a> {
    pub device: &'a wgpu::Device,
    pub queue: &'a wgpu::Queue,
    pub format: wgpu::TextureFormat,
    pub globals_layout: &'a wgpu::BindGroupLayout,
    pub globals_pipeline_layout: &'a wgpu::PipelineLayout,
}

impl Ctx<'_> {
    /// Premultiplied-alpha target used by every scene pipeline.
    pub fn color_target(&self) -> wgpu::ColorTargetState {
        wgpu::ColorTargetState {
            format: self.format,
            blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::ALL,
        }
    }
}

#[derive(Debug)]
pub enum EngineError {
    NoAdapter(String),
    NoDevice(String),
    UnsupportedSurface,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::NoAdapter(e) => write!(f, "no GPU adapter: {e}"),
            EngineError::NoDevice(e) => write!(f, "could not open GPU device: {e}"),
            EngineError::UnsupportedSurface => f.write_str("surface not supported by adapter"),
        }
    }
}

impl std::error::Error for EngineError {}

/// Which pipeline draws a run of consecutive items.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ItemKind {
    Shape,
    Text,
    Poly,
}

/// The frame's items split per pipeline, plus the ordered runs that interleave them.
#[derive(Default)]
struct Batches {
    shapes: Vec<DrawShape>,
    texts: Vec<DrawText>,
    polys: Vec<DrawPoly>,
    runs: Vec<(ItemKind, Range<u32>)>,
}

impl Batches {
    fn build(items: Vec<DrawItem>) -> Self {
        let mut b = Batches::default();
        b.push_all(items);
        b
    }

    fn push_all(&mut self, items: Vec<DrawItem>) {
        let b = self;
        for item in items {
            let (kind, index) = match item {
                DrawItem::Group(children) => {
                    b.push_all(children);
                    continue;
                }
                DrawItem::Poly(p) => {
                    b.polys.push(p);
                    (ItemKind::Poly, b.polys.len() as u32 - 1)
                }
                DrawItem::Shape(s) => {
                    b.shapes.push(s);
                    (ItemKind::Shape, b.shapes.len() as u32 - 1)
                }
                DrawItem::Text(t) => {
                    b.texts.push(t);
                    (ItemKind::Text, b.texts.len() as u32 - 1)
                }
            };
            match b.runs.last_mut() {
                Some((k, r)) if *k == kind && r.end == index => r.end += 1,
                _ => b.runs.push((kind, index..index + 1)),
            }
        }
    }
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    globals: wgpu::Buffer,
    globals_layout: wgpu::BindGroupLayout,
    globals_pipeline_layout: wgpu::PipelineLayout,
    bind_group: wgpu::BindGroup,
    shapes: ShapePipeline,
    text: TextPipeline,
    polys: PolyPipeline,
    post: PostPass,
    pub adapter_info: String,
}

impl Renderer {
    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, EngineError> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| EngineError::NoAdapter(e.to_string()))?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("motionily"),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
                ..Default::default()
            })
            .await
            .map_err(|e| EngineError::NoDevice(e.to_string()))?;

        let mut config = surface
            .get_default_config(&adapter, width.max(1), height.max(1))
            .ok_or(EngineError::UnsupportedSurface)?;
        // Prefer a non-sRGB surface: our palette colors are already sRGB.
        let caps = surface.get_capabilities(&adapter);
        if let Some(f) = caps.formats.iter().copied().find(|f| !f.is_srgb()) {
            config.format = f;
        }
        surface.configure(&device, &config);

        let globals = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let globals_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("globals"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globals"),
            layout: &globals_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: globals.as_entire_binding() }],
        });
        let globals_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("globals only"),
            bind_group_layouts: &[Some(&globals_layout)],
            ..Default::default()
        });

        let ctx = Ctx {
            device: &device,
            queue: &queue,
            format: config.format,
            globals_layout: &globals_layout,
            globals_pipeline_layout: &globals_pipeline_layout,
        };
        let shapes = ShapePipeline::new(&ctx);
        let text = TextPipeline::new(&ctx);
        let polys = PolyPipeline::new(&ctx);
        let post = PostPass::new(&device, config.format, config.width, config.height);

        let info = adapter.get_info();
        Ok(Renderer {
            shapes,
            text,
            polys,
            post,
            device,
            queue,
            surface,
            config,
            globals,
            globals_layout,
            globals_pipeline_layout,
            bind_group,
            adapter_info: if info.name.is_empty() {
                format!("{:?}", info.backend)
            } else {
                format!("{} ({:?})", info.name, info.backend)
            },
        })
    }

    /// Register a TTF/OTF font for text layers and captions.
    pub fn add_font(&mut self, family: &str, weight: u16, bytes: &[u8]) -> Result<(), String> {
        self.text.add_font(family, weight, bytes)
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        self.post.resize(&self.device, width, height);
    }

    /// Draw `scene` at time `t` (seconds) into the surface.
    pub fn render(&mut self, scene: &Scene, t: f32) {
        let batches = Batches::build(scene.frame(t));
        let linearize = if self.config.format.is_srgb() { 1.0 } else { 0.0 };
        self.queue.write_buffer(
            &self.globals,
            0,
            bytemuck::bytes_of(&Globals { scene_size: [scene.width as f32, scene.height as f32], linearize, time: t }),
        );
        // Built from fields (not `self.ctx()`) so pipelines can be borrowed mutably alongside it.
        let ctx = Ctx {
            device: &self.device,
            queue: &self.queue,
            format: self.config.format,
            globals_layout: &self.globals_layout,
            globals_pipeline_layout: &self.globals_pipeline_layout,
        };
        self.shapes.prepare(&ctx, &batches.shapes);
        self.text.prepare(&ctx, &batches.texts);
        self.polys.prepare(&ctx, &batches.polys);

        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let palette = scene.palette();
        let to_surface = |c: scene::Rgba| {
            let [r, g, b, _] = c.0;
            if linearize > 0.5 { [r, g, b].map(srgb_to_linear) } else { [r, g, b] }
        };
        let colors = PostColors {
            background: to_surface(palette.background),
            ink: to_surface(palette.text),
            shadow: to_surface(palette.text).map(|c| c * 0.35),
        };

        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            // Scene pass: transparent canvas; the post pass adds background and finish.
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: self.post.target(),
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_bind_group(0, &self.bind_group, &[]);
            for (kind, range) in &batches.runs {
                match kind {
                    ItemKind::Shape => self.shapes.draw(&mut pass, range.clone()),
                    ItemKind::Text => self.text.draw(&mut pass, range.clone()),
                    ItemKind::Poly => self.polys.draw(&mut pass, range.clone()),
                }
            }
        }
        self.post.run(&self.queue, &mut encoder, &view, scene.render_style, &colors, scene.width as f32, t);
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
    }
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
