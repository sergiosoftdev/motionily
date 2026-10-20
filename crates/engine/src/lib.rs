//! GPU renderer. Knows nothing about the browser, React or files: it receives a
//! [`Scene`] and a time, and draws one frame into a wgpu surface. The host
//! (WASM bindings today, Tauri/native later) creates the surface.
//!
//! Each kind of [`DrawItem`] has its own pipeline module (`shapes.rs`, …) with
//! the same shape: `new(&Ctx)`, `prepare(&Ctx, &[Item])` once per frame, then
//! `draw(pass, range)` for every consecutive run of that kind, so layer order is
//! kept across kinds.

mod fx;
mod image;
mod paths;
mod polys;
mod post;
mod shapes;
mod text;
mod three;

use bytemuck::{Pod, Zeroable};
use image::ImagePipeline;
use polys::PolyPipeline;
use fx::{FxParams, FxPass, Tex};
use paths::PathPipeline;
use scene::paint::{DrawEffect, DrawFx, DrawPath};
use scene::{DrawImage, DrawItem, DrawPoly, DrawShape, DrawStage, DrawText, Scene};
use post::{PostColors, PostPass};
use shapes::ShapePipeline;
use text::TextPipeline;
use three::StageRenderer;
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
    Image,
    Path,
}

/// A stretch of the frame: consecutive items of one kind, or a layer drawn offscreen.
enum Run {
    Items(ItemKind, Range<u32>),
    Fx(FxRun),
}

struct FxRun {
    runs: Vec<Run>,
    /// Motion-blur samples, averaged with `runs`.
    samples: Vec<Vec<Run>>,
    /// Adjustment layer: the effects run on the scene drawn so far.
    adjust: bool,
    perspective: Option<[f32; 9]>,
    matte: Option<(Vec<Run>, scene::paint::MatteMode)>,
    effects: Vec<DrawEffect>,
    blend: scene::paint::BlendMode,
}

/// The frame's items split per pipeline (uploaded once), plus the ordered runs that draw them.
#[derive(Default)]
struct Batches {
    shapes: Vec<DrawShape>,
    texts: Vec<DrawText>,
    polys: Vec<DrawPoly>,
    images: Vec<DrawImage>,
    paths: Vec<DrawPath>,
    stage: Option<DrawStage>,
    runs: Vec<Run>,
}

impl Batches {
    fn build(items: Vec<DrawItem>) -> Self {
        let mut b = Batches::default();
        let mut runs = Vec::new();
        b.push_all(items, &mut runs, true);
        b.runs = runs;
        b
    }

    /// `top`: offscreen layers are only honored at the top level (nested ones draw plainly).
    fn push_all(&mut self, items: Vec<DrawItem>, runs: &mut Vec<Run>, top: bool) {
        for item in items {
            let (kind, index) = match item {
                DrawItem::Group(children) => {
                    self.push_all(children, runs, top);
                    continue;
                }
                DrawItem::Stage(stage) => {
                    self.stage = Some(stage);
                    continue;
                }
                DrawItem::Fx(fx) => {
                    let DrawFx { items, effects, blend, matte, samples, adjust, perspective } = *fx;
                    if top {
                        let mut inner = Vec::new();
                        self.push_all(items, &mut inner, false);
                        let samples = samples
                            .into_iter()
                            .map(|s| {
                                let mut r = Vec::new();
                                self.push_all(s, &mut r, false);
                                r
                            })
                            .collect();
                        let matte = matte.map(|(m, mode)| {
                            let mut mr = Vec::new();
                            self.push_all(m, &mut mr, false);
                            (mr, mode)
                        });
                        runs.push(Run::Fx(FxRun { runs: inner, samples, adjust, perspective, matte, effects, blend }));
                    } else {
                        self.push_all(items, runs, false);
                    }
                    continue;
                }
                DrawItem::Image(i) => {
                    self.images.push(i);
                    (ItemKind::Image, self.images.len() as u32 - 1)
                }
                DrawItem::Poly(p) => {
                    self.polys.push(p);
                    (ItemKind::Poly, self.polys.len() as u32 - 1)
                }
                DrawItem::Shape(sh) => {
                    self.shapes.push(sh);
                    (ItemKind::Shape, self.shapes.len() as u32 - 1)
                }
                DrawItem::Text(t) => {
                    self.texts.push(t);
                    (ItemKind::Text, self.texts.len() as u32 - 1)
                }
                DrawItem::Path(p) => {
                    self.paths.push(p);
                    (ItemKind::Path, self.paths.len() as u32 - 1)
                }
            };
            match runs.last_mut() {
                Some(Run::Items(k, r)) if *k == kind && r.end == index => r.end += 1,
                _ => runs.push(Run::Items(kind, index..index + 1)),
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
    images: ImagePipeline,
    paths: PathPipeline,
    stage: StageRenderer,
    post: PostPass,
    fx: FxPass,
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
        let images = ImagePipeline::new(&ctx);
        let paths = PathPipeline::new(&ctx);
        let post = PostPass::new(&device, config.format, config.width, config.height);
        let fx = FxPass::new(&device, config.format, config.width, config.height);
        let stage = StageRenderer::new(&device, &queue, config.format, [config.width, config.height]);

        let info = adapter.get_info();
        Ok(Renderer {
            shapes,
            text,
            polys,
            images,
            paths,
            stage,
            post,
            fx,
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

    /// Register a glTF binary (GLB) model under `key`, e.g. "characters/character-female-b".
    pub fn add_model(&mut self, key: &str, bytes: &[u8]) -> Result<(), String> {
        self.stage.add_model(&self.device, key, bytes)
    }

    /// Register a model pack's shared texture (RGBA8).
    pub fn add_texture(&mut self, pack: &str, rgba: &[u8], width: u32, height: u32) {
        self.stage.add_texture(&self.device, &self.queue, pack, rgba, width, height);
    }

    /// Register an image (RGBA8) for image layers under its source key.
    pub fn add_image(&mut self, key: &str, rgba: &[u8], width: u32, height: u32) {
        self.images.add_image(&self.device, &self.queue, key, rgba, width, height);
    }

    pub fn has_image(&self, key: &str) -> bool {
        self.images.has_image(key)
    }

    pub fn has_model(&self, key: &str) -> bool {
        self.stage.has_model(key)
    }

    /// Box `[x0, y0, x1, y1]` the text of layer `id` really covers at `t` (glyph ink, not its box).
    pub fn text_ink(&mut self, scene: &Scene, id: &str, t: f32) -> Option<[f32; 4]> {
        fn texts(items: Vec<DrawItem>, out: &mut Vec<DrawText>) {
            for item in items {
                match item {
                    DrawItem::Text(t) => out.push(t),
                    DrawItem::Group(g) => texts(g, out),
                    DrawItem::Fx(fx) => texts(fx.items, out),
                    _ => {}
                }
            }
        }
        let mut found = Vec::new();
        texts(scene.layer_items_at(id, t), &mut found);
        found.iter().filter_map(|item| self.text.ink(&self.queue, item)).reduce(|a, b| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])])
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
        self.fx.resize(&self.device, width, height);
        self.stage.resize(&self.device, [width, height]);
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
        self.images.prepare(&ctx, &batches.images);
        self.paths.prepare(&ctx, &batches.paths);
        self.stage.prepare(&self.device, &self.queue, batches.stage.as_ref(), scene.width as f32 / scene.height as f32, linearize > 0.5);

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

        // Plan every offscreen pass first: they share one uniform buffer written before submit.
        let px_per_scene = self.config.width as f32 / scene.width.max(1) as f32;
        let texel = [1.0 / self.config.width.max(1) as f32, 1.0 / self.config.height.max(1) as f32];
        self.fx.begin();
        let plans: Vec<Option<FxPlan>> = batches
            .runs
            .iter()
            .map(|r| match r {
                Run::Fx(f) => Some(plan_fx(&mut self.fx, f, px_per_scene, texel, scene.width as f32, scene.height as f32, linearize > 0.5)),
                Run::Items(..) => None,
            })
            .collect();
        self.fx.upload(&self.device, &self.queue);

        let mut encoder = self.device.create_command_encoder(&Default::default());
        // 3D stage first (with depth); 2D layers then draw on top of it.
        let drew_stage = self.stage.render(&mut encoder, self.post.target());
        let mut cleared = drew_stage;
        let mut i = 0;
        while i < batches.runs.len() {
            // A stretch of plain runs goes in one scene pass.
            let j = batches.runs[i..].iter().position(|r| matches!(r, Run::Fx(_))).map_or(batches.runs.len(), |k| i + k);
            if j > i || !cleared {
                let load = if cleared { wgpu::LoadOp::Load } else { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) };
                cleared = true;
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("scene"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: self.post.target(),
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
                    })],
                    ..Default::default()
                });
                pass.set_bind_group(0, &self.bind_group, &[]);
                self.draw_runs(&mut pass, &batches.runs[i..j]);
            }
            if j < batches.runs.len() {
                if let (Run::Fx(f), Some(plan)) = (&batches.runs[j], &plans[j]) {
                    self.render_fx(&mut encoder, f, plan);
                }
                i = j + 1;
            } else {
                i = j;
            }
        }
        if !cleared {
            // Empty scene: still clear the target.
            let _ = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: self.post.target(),
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
        }
        self.post.run(&self.queue, &mut encoder, &view, scene.render_style, &colors, scene.width as f32, t);
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
    }
}

impl Renderer {
    /// Draw plain runs (offscreen layers nested here draw their items plainly).
    fn draw_runs(&self, pass: &mut wgpu::RenderPass<'_>, runs: &[Run]) {
        for run in runs {
            match run {
                Run::Items(kind, range) => match kind {
                    ItemKind::Shape => self.shapes.draw(pass, range.clone()),
                    ItemKind::Text => self.text.draw(pass, range.clone()),
                    ItemKind::Poly => self.polys.draw(pass, range.clone()),
                    ItemKind::Image => self.images.draw(pass, range.clone()),
                    ItemKind::Path => self.paths.draw(pass, range.clone()),
                },
                Run::Fx(f) => self.draw_runs(pass, &f.runs),
            }
        }
    }

    /// Draw `runs` into an offscreen texture (cleared first).
    fn draw_offscreen(&self, encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, runs: &[Run]) {
        let mut pass = FxPass::clear_pass(encoder, view, "fx layer");
        pass.set_bind_group(0, &self.bind_group, &[]);
        self.draw_runs(&mut pass, runs);
    }

    fn render_fx(&self, encoder: &mut wgpu::CommandEncoder, f: &FxRun, plan: &FxPlan) {
        if f.adjust {
            // The scene so far becomes the layer; compositing it back replaces what is below.
            drop(FxPass::clear_pass(encoder, &self.fx.layer, "fx adjust"));
            let scene = self.fx.group_for(&self.device, self.post.target());
            self.fx.composite_group(encoder, &scene, &self.fx.layer, scene::paint::BlendMode::Normal, plan.copy);
        } else if f.samples.is_empty() {
            self.draw_offscreen(encoder, &self.fx.layer, &f.runs);
        } else {
            // Motion blur: every sample drawn alone, then added in at 1/n.
            drop(FxPass::clear_pass(encoder, &self.fx.layer, "fx motion blur"));
            for runs in std::iter::once(&f.runs).chain(&f.samples) {
                self.draw_offscreen(encoder, &self.fx.accum, runs);
                self.fx.composite(encoder, Tex::Accum, &self.fx.layer, scene::paint::BlendMode::Add, plan.average);
            }
        }
        if let Some((m, _)) = &f.matte {
            self.draw_offscreen(encoder, &self.fx.matte, m);
        }
        // Blur effects change the layer itself.
        for (h, v) in &plan.blurs {
            self.fx.blur(encoder, Tex::Layer, &self.fx.temp, *h);
            self.fx.blur(encoder, Tex::Temp, &self.fx.layer, *v);
        }
        let target = self.post.target();
        for (h, v, comp) in &plan.shadows {
            self.fx.blur(encoder, Tex::Layer, &self.fx.temp, *h);
            self.fx.blur(encoder, Tex::Temp, &self.fx.copy, *v);
            self.fx.composite(encoder, Tex::Copy, target, scene::paint::BlendMode::Normal, *comp);
        }
        self.fx.composite(encoder, Tex::Layer, target, f.blend, plan.layer);
        for (h, v, comp) in &plan.glows {
            self.fx.blur(encoder, Tex::Layer, &self.fx.temp, *h);
            self.fx.blur(encoder, Tex::Temp, &self.fx.copy, *v);
            self.fx.composite(encoder, Tex::Copy, target, scene::paint::BlendMode::Add, *comp);
        }
    }
}

/// Uniform offsets for every pass of one offscreen layer.
struct FxPlan {
    /// (horizontal, vertical) blur passes applied to the layer in place.
    blurs: Vec<(u32, u32)>,
    /// (h blur, v blur, composite) per shadow.
    shadows: Vec<(u32, u32, u32)>,
    layer: u32,
    glows: Vec<(u32, u32, u32)>,
    /// Plain copy (adjustment layers).
    copy: u32,
    /// One motion-blur sample at 1/n.
    average: u32,
}

fn plan_fx(fx: &mut FxPass, f: &FxRun, px_per_scene: f32, texel: [f32; 2], scene_w: f32, scene_h: f32, linear: bool) -> FxPlan {
    let matte = fx::matte_code(f.matte.as_ref().map(|(_, m)| *m));
    let blur_pair = |fx: &mut FxPass, radius_scene: f32| {
        // Radius ~ 2 sigma, in texels of the offscreen target.
        let sigma = (radius_scene * px_per_scene / 2.0).max(0.01);
        let h = fx.push(FxParams { a: [texel[0], 0.0, sigma, 0.0], ..Default::default() });
        let v = fx.push(FxParams { a: [0.0, texel[1], sigma, 0.0], ..Default::default() });
        (h, v)
    };
    let tint = |c: scene::Rgba| {
        let [r, g, b, a] = c.0;
        if linear { [srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), a] } else { [r, g, b, a] }
    };
    let mut plan = FxPlan { blurs: Vec::new(), shadows: Vec::new(), layer: 0, glows: Vec::new(), copy: 0, average: 0 };
    // Color correction, distortion and grain all happen in the final layer composite.
    let (mut hue, mut sat, mut bright, mut contrast) = (0.0, 1.0, 0.0, 1.0);
    let mut warp = [0.0f32; 4];
    let mut grain = [0.0f32; 4];
    let mut turb = [0.0f32; 4];
    let (h0, h1, h2) = f.perspective.map_or(([0.0; 4], [0.0; 4], [0.0; 4]), |m| {
        ([m[0], m[1], m[2], 1.0], [m[3], m[4], m[5], scene_w], [m[6], m[7], m[8], scene_h])
    });
    for e in &f.effects {
        match *e {
            DrawEffect::Blur { radius } if radius > 0.0 => plan.blurs.push(blur_pair(fx, radius)),
            DrawEffect::Shadow { offset, blur, color } => {
                let (h, v) = blur_pair(fx, blur);
                let comp = fx.push(FxParams {
                    a: [1.0, matte, 1.0, 1.0],
                    b: [offset[0] / scene_w, offset[1] / scene_h, 0.0, 0.0],
                    color: tint(color),
                    h0,
                    h1,
                    h2,
                    ..Default::default()
                });
                plan.shadows.push((h, v, comp));
            }
            DrawEffect::Glow { radius, strength, color } => {
                let (h, v) = blur_pair(fx, radius);
                let comp = fx.push(FxParams {
                    a: [2.0, matte, strength, if color.is_some() { 1.0 } else { 0.0 }],
                    color: color.map_or([1.0; 4], tint),
                    h0,
                    h1,
                    h2,
                    ..Default::default()
                });
                plan.glows.push((h, v, comp));
            }
            DrawEffect::Blur { .. } => {}
            DrawEffect::Color { hue: h, saturation, brightness, contrast: k } => {
                hue += h.to_radians();
                sat *= saturation;
                bright += brightness;
                contrast *= k;
            }
            DrawEffect::Chromatic { amount } => warp[3] += amount / scene_w,
            DrawEffect::Wave { amplitude, wavelength, phase } => warp = [amplitude / scene_w, scene_h / wavelength, phase, warp[3]],
            DrawEffect::Grain { amount, seed } => grain = [amount, seed, 0.0, 0.0],
            DrawEffect::Turbulence { amount, size, phase } => turb = [amount / scene_w, amount / scene_h, scene_w / size, phase],
        }
    }
    // Warps pull pixels from around them: at the frame edge, repeat the edge instead of emptiness.
    let clamp_edges = if f.adjust || turb[0] != 0.0 { 1.0 } else { 0.0 };
    plan.layer = fx.push(FxParams { a: [0.0, matte, 1.0, 0.0], b: [0.0, 0.0, clamp_edges, if f.adjust { 1.0 } else { 0.0 }], adj: [hue, sat - 1.0, bright, contrast - 1.0], warp, grain, turb, h0, h1, h2, ..Default::default() });
    if f.adjust {
        plan.copy = fx.push(FxParams::default());
    }
    if !f.samples.is_empty() {
        plan.average = fx.push(FxParams { a: [2.0, 0.0, 1.0 / (f.samples.len() + 1) as f32, 0.0], ..Default::default() });
    }
    plan
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
