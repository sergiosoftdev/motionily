//! GPU renderer. Knows nothing about the browser, React or files: it receives a
//! [`Scene`] and a time, and draws one frame into a wgpu surface. The host
//! (WASM bindings today, Tauri/native later) creates the surface.
//!
//! Each kind of [`DrawItem`] has its own pipeline module (`shapes.rs`, …) with
//! the same shape: `new(&Ctx)`, `prepare(&Ctx, &[Item])` once per frame, then
//! `draw(pass, range)` for every consecutive run of that kind, so layer order is
//! kept across kinds.

mod custom;
mod fx;
mod image;
mod paths;
mod polys;
mod post;
mod shapes;
mod text;
mod three;

use bytemuck::{Pod, Zeroable};
use custom::{CustomShaders, FrameInfo};
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
    /// Flat-space origin of the pass: [0, 0] for the scene, the plane origin inside a tilted plane.
    origin: [f32; 2],
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
    /// Custom shader layers (`custom.rs`).
    Shader,
}

/// A stretch of the frame: consecutive items of one kind, or a layer drawn offscreen.
enum Run {
    Items(ItemKind, Range<u32>),
    Fx(FxRun),
    /// A 3D object layer (index into `Batches::objects`), rendered by its own stage renderer.
    Object(u32),
}

struct FxRun {
    runs: Vec<Run>,
    /// Motion-blur samples, averaged with `runs`.
    samples: Vec<Vec<Run>>,
    /// Adjustment layer: the effects run on the scene drawn so far.
    adjust: bool,
    perspective: Option<[f32; 9]>,
    /// Flat-space origin of a tilted plane's pass (see DrawFx::plane_origin).
    plane_origin: [f32; 2],
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
    shaders: Vec<scene::shader::DrawShader>,
    stage: Option<DrawStage>,
    objects: Vec<scene::DrawObject>,
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
                    let DrawFx { items, effects, blend, matte, samples, adjust, perspective, plane_origin } = *fx;
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
                        runs.push(Run::Fx(FxRun { runs: inner, samples, adjust, perspective, plane_origin, matte, effects, blend }));
                    } else {
                        self.push_all(items, runs, false);
                    }
                    continue;
                }
                DrawItem::Object(mut o) => {
                    // Its contact shadow is a plain shape drawn just before it.
                    if let Some(shadow) = o.contact.take() {
                        self.push_all(vec![DrawItem::Shape(shadow)], runs, top);
                    }
                    self.objects.push(*o);
                    runs.push(Run::Object(self.objects.len() as u32 - 1));
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
                DrawItem::Shader(s) => {
                    self.shaders.push(*s);
                    (ItemKind::Shader, self.shaders.len() as u32 - 1)
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
    /// `None` for headless renderers, which draw into textures (`render_rgba`).
    surface: Option<wgpu::Surface<'static>>,
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
    /// One stage renderer per 3D object layer on screen (grown on demand).
    objects: Vec<StageRenderer>,
    post: PostPass,
    fx: FxPass,
    /// Agent-written shader layers and effects.
    custom: CustomShaders,
    /// One globals uniform (with its origin) per tilted plane drawn this frame, reused frame to frame.
    plane_globals: Vec<(wgpu::Buffer, wgpu::BindGroup)>,
    /// Internal resolution as a multiple of the output size (1 or 2). At 2 the scene is drawn at
    /// double size and the post pass averages it down: every edge (shapes, text, strokes, 3D) is
    /// supersampled, whatever the layer type.
    supersample: u32,
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

        let info = adapter.get_info();
        let adapter_info = if info.name.is_empty() { format!("{:?}", info.backend) } else { format!("{} ({:?})", info.name, info.backend) };
        Ok(Self::assemble(device, queue, config, Some(surface), adapter_info))
    }

    /// A renderer with no window: frames go to textures and come back as pixels (`render_rgba`).
    /// Native tests and stills; the same pipelines as the surface renderer.
    pub async fn new_headless(width: u32, height: u32) -> Result<Self, EngineError> {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| EngineError::NoAdapter(e.to_string()))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("motionily headless"),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
                ..Default::default()
            })
            .await
            .map_err(|e| EngineError::NoDevice(e.to_string()))?;
        // Non-sRGB, like the web surface: palette colors are written as they are.
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            format: wgpu::TextureFormat::Rgba8Unorm,
            color_space: wgpu::SurfaceColorSpace::Srgb,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: vec![],
        };
        let info = adapter.get_info();
        let adapter_info = if info.name.is_empty() { format!("{:?}", info.backend) } else { format!("{} ({:?})", info.name, info.backend) };
        Ok(Self::assemble(device, queue, config, None, adapter_info))
    }

    fn assemble(device: wgpu::Device, queue: wgpu::Queue, config: wgpu::SurfaceConfiguration, surface: Option<wgpu::Surface<'static>>, adapter_info: String) -> Self {
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
        let custom = CustomShaders::new(&ctx);
        let internal = [config.width, config.height];
        let post = PostPass::new(&device, config.format, internal[0], internal[1]);
        let fx = FxPass::new(&device, config.format, internal[0], internal[1]);
        let stage = StageRenderer::new(&device, &queue, config.format, internal);

        Renderer {
            shapes,
            text,
            polys,
            images,
            paths,
            stage,
            objects: Vec::new(),
            post,
            fx,
            custom,
            plane_globals: Vec::new(),
            supersample: 1,
            device,
            queue,
            surface,
            config,
            globals,
            globals_layout,
            globals_pipeline_layout,
            bind_group,
            adapter_info,
        }
    }

    /// Register a glTF binary (GLB) model under `key`, e.g. "characters/character-female-b".
    pub fn add_model(&mut self, key: &str, bytes: &[u8]) -> Result<(), String> {
        self.stage.add_model(&self.device, key, bytes)
    }

    /// Register a model pack's shared texture, or one model image by its key (RGBA8).
    pub fn add_texture(&mut self, key: &str, rgba: &[u8], width: u32, height: u32) {
        self.stage.add_texture(&self.device, &self.queue, key, rgba, width, height);
    }

    /// Image keys the loaded models need and nobody registered yet (`add_texture` them).
    pub fn missing_textures(&self) -> Vec<String> {
        self.stage.missing_textures()
    }

    /// PNG/JPEG bytes of an image embedded in a model (`key` from `missing_textures`).
    pub fn embedded_texture(&self, key: &str) -> Option<&[u8]> {
        self.stage.embedded_texture(key)
    }

    /// Every texture key registered so far.
    pub fn texture_keys(&self) -> Vec<String> {
        self.stage.texture_keys()
    }

    /// Register an image (RGBA8) for image layers under its source key.
    pub fn add_image(&mut self, key: &str, rgba: &[u8], width: u32, height: u32) {
        self.images.add_image(&self.device, &self.queue, key, rgba, width, height);
    }

    pub fn has_image(&self, key: &str) -> bool {
        self.images.has_image(key)
    }

    /// Store a decoded video frame (RGBA8) under its `src#ms` key (`scene::video::frame_key`).
    pub fn add_video_frame(&mut self, key: &str, rgba: &[u8], width: u32, height: u32) {
        self.images.add_frame(&self.device, &self.queue, key, rgba, width, height);
    }

    /// Store a decoded video frame straight from a browser canvas or bitmap (no CPU copy).
    #[cfg(target_arch = "wasm32")]
    pub fn copy_video_frame(&mut self, key: &str, source: &wgpu::CopyExternalImageSourceInfo) {
        self.images.copy_frame(&self.device, &self.queue, key, source);
    }

    pub fn has_video_frame(&self, key: &str) -> bool {
        self.images.has_frame(key)
    }

    /// Release every video frame not in `keep` (the host calls it with the frames of the next render).
    pub fn retain_video_frames(&mut self, keep: &[String]) {
        self.images.retain_frames(keep);
    }

    pub fn has_model(&self, key: &str) -> bool {
        self.stage.has_model(key)
    }

    /// Box `[x0, y0, x1, y1]` the text of layer `id` really covers on screen at `t` (glyph ink, not its box).
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
        let flat = found.iter().filter_map(|item| self.text.ink(&self.queue, item)).reduce(|a, b| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])])?;
        scene.rect_to_screen(id, t, flat)
    }

    /// Custom shaders of `scene` that cannot draw (layer id, reason), for review checks.
    pub fn shader_failures(&self, scene: &Scene) -> Vec<(String, String)> {
        self.custom.failures(scene)
    }

    /// Register a TTF/OTF font for text layers and captions.
    pub fn add_font(&mut self, family: &str, weight: u16, bytes: &[u8]) -> Result<(), String> {
        self.text.add_font(family, weight, bytes)?;
        // The same font extrudes 3D text.
        scene::glyphs::register(family, weight, bytes)
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        if let Some(surface) = &self.surface {
            surface.configure(&self.device, &self.config);
        }
        self.resize_targets();
    }

    /// Supersampling: 1 (default) or 2. Takes effect on the next frame.
    pub fn set_supersample(&mut self, factor: u32) {
        let factor = factor.clamp(1, 2);
        if factor != self.supersample {
            self.supersample = factor;
            self.resize_targets();
        }
    }

    /// Size of the offscreen targets the scene is drawn into (output size times supersampling).
    fn internal_size(&self) -> [u32; 2] {
        [self.config.width * self.supersample, self.config.height * self.supersample]
    }

    fn resize_targets(&mut self) {
        let [w, h] = self.internal_size();
        self.post.resize(&self.device, w, h);
        self.fx.resize(&self.device, w, h);
        self.stage.resize(&self.device, [w, h]);
        for o in &mut self.objects {
            o.resize(&self.device, [w, h]);
        }
    }

    /// Draw `scene` at time `t` (seconds) into the surface. Does nothing on a headless renderer.
    pub fn render(&mut self, scene: &Scene, t: f32) {
        let Some(surface) = &self.surface else { return };
        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => {
                surface.configure(&self.device, &self.config);
                return;
            }
        };
        let view = frame.texture.create_view(&Default::default());
        self.draw(scene, t, &view);
        self.queue.present(frame);
    }

    /// Draw `scene` at time `t` into a texture of the renderer's size and read it back as tightly
    /// packed RGBA8 rows (top row first). Works on any renderer; the output is not sRGB-converted.
    pub fn render_rgba(&mut self, scene: &Scene, t: f32) -> Vec<u8> {
        let (width, height) = (self.config.width, self.config.height);
        let target = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("still"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.config.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        self.draw(scene, t, &view);
        // Rows are copied with 256-byte alignment, as the GPU requires, then unpacked.
        let row = (width * 4).div_ceil(256) * 256;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("still readback"),
            size: row as u64 * height as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(height) },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv().ok().and_then(Result::ok).expect("readback map failed");
        let data = slice.get_mapped_range().expect("readback range");
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height as usize {
            let start = y * row as usize;
            out.extend_from_slice(&data[start..start + width as usize * 4]);
        }
        drop(data);
        readback.unmap();
        out
    }

    /// The frame at `t` into `view`: 3D stage, then the 2D runs over it, then the post pass.
    fn draw(&mut self, scene: &Scene, t: f32, view: &wgpu::TextureView) {
        let batches = Batches::build(scene.frame(t));
        let linearize = if self.config.format.is_srgb() { 1.0 } else { 0.0 };
        self.queue.write_buffer(
            &self.globals,
            0,
            bytemuck::bytes_of(&Globals { scene_size: [scene.width as f32, scene.height as f32], linearize, time: t, origin: [0.0; 2] }),
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
        // Custom shaders: compile what the scene lists, then this frame's uniforms (layers here,
        // effects while planning the offscreen passes).
        let shading = FrameInfo::new(&scene.palette(), linearize > 0.5, [scene.width as f32, scene.height as f32]);
        self.custom.begin(&self.device, scene);
        self.custom.prepare_layers(&batches.shaders, &shading);
        self.stage.prepare(&self.device, &self.queue, batches.stage.as_ref(), scene.width as f32 / scene.height as f32, linearize > 0.5);
        while self.objects.len() < batches.objects.len() {
            self.objects.push(StageRenderer::new(&self.device, &self.queue, self.config.format, self.internal_size()));
        }
        let scene_px = [scene.width as f32, scene.height as f32];
        for (renderer, o) in self.objects.iter_mut().zip(&batches.objects) {
            renderer.share_assets(&self.stage);
            let screen = three::ScreenBox { center: o.center, size: o.size, rotation: o.rotation, scene: scene_px };
            renderer.prepare_in(&self.device, &self.queue, Some(&o.stage), 1.0, linearize > 0.5, Some(screen));
        }

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
        let [internal_w, internal_h] = self.internal_size();
        let px_per_scene = internal_w as f32 / scene.width.max(1) as f32;
        let texel = [1.0 / internal_w.max(1) as f32, 1.0 / internal_h.max(1) as f32];
        self.fx.begin();
        // Tilted planes draw with their own globals (their origin); the scene's stays as it is.
        let plane_slots = self.prepare_plane_globals(&batches.runs, scene, linearize, t);
        let plans: Vec<Option<FxPlan>> = batches
            .runs
            .iter()
            .map(|r| match r {
                Run::Fx(f) => Some(plan_fx(&mut self.fx, &mut self.custom, &shading, f, px_per_scene, texel, scene.width as f32, scene.height as f32, linearize > 0.5)),
                Run::Items(..) | Run::Object(_) => None,
            })
            .collect();
        // Top-level objects composite at their opacity.
        let object_params: Vec<Option<u32>> = batches
            .runs
            .iter()
            .map(|r| match r {
                Run::Object(k) => Some(self.fx.push(FxParams { a: [2.0, 0.0, batches.objects[*k as usize].opacity, 0.0], ..Default::default() })),
                _ => None,
            })
            .collect();
        self.fx.upload(&self.device, &self.queue);
        self.custom.upload(&self.device, &self.queue);

        let mut encoder = self.device.create_command_encoder(&Default::default());
        // 3D stage first (with depth); 2D layers then draw on top of it.
        let drew_stage = self.stage.render(&mut encoder, self.post.target());
        let mut cleared = drew_stage;
        let mut i = 0;
        while i < batches.runs.len() {
            // A stretch of plain runs goes in one scene pass.
            let j = batches.runs[i..].iter().position(|r| matches!(r, Run::Fx(_) | Run::Object(_))).map_or(batches.runs.len(), |k| i + k);
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
                    let globals = plane_slots[j].map_or(&self.bind_group, |s| &self.plane_globals[s].1);
                    self.render_fx(&mut encoder, f, plan, globals);
                }
                if let (Run::Object(k), Some(param)) = (&batches.runs[j], object_params[j]) {
                    if self.objects[*k as usize].render_onto(&mut encoder, &self.fx.layer, true) {
                        self.fx.composite(&mut encoder, Tex::Layer, self.post.target(), scene::paint::BlendMode::Normal, param);
                    }
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
        self.post.run(&self.queue, &mut encoder, view, scene.render_style, &colors, scene.width as f32, t);
        self.queue.submit([encoder.finish()]);
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
                    ItemKind::Shader => self.custom.draw_layers(pass, range.clone()),
                },
                Run::Fx(f) => self.draw_runs(pass, &f.runs),
                // Objects need their own pass (depth): `draw_offscreen` handles them.
                Run::Object(_) => {}
            }
        }
    }

    /// Globals for each tilted plane drawn this frame: the scene's uniform, with the plane's origin.
    /// Returns the slot per run (`None` for runs that are not planes).
    fn prepare_plane_globals(&mut self, runs: &[Run], scene: &Scene, linearize: f32, t: f32) -> Vec<Option<usize>> {
        let mut slots = vec![None; runs.len()];
        let mut next = 0;
        for (i, run) in runs.iter().enumerate() {
            let Run::Fx(f) = run else { continue };
            if f.perspective.is_none() {
                continue;
            }
            if next == self.plane_globals.len() {
                let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("plane globals"),
                    size: std::mem::size_of::<Globals>() as u64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("plane globals"),
                    layout: &self.globals_layout,
                    entries: &[wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() }],
                });
                self.plane_globals.push((buffer, group));
            }
            let globals = Globals { scene_size: [scene.width as f32, scene.height as f32], linearize, time: t, origin: f.plane_origin };
            self.queue.write_buffer(&self.plane_globals[next].0, 0, bytemuck::bytes_of(&globals));
            slots[i] = Some(next);
            next += 1;
        }
        slots
    }

    /// Draw `runs` into an offscreen texture (cleared first).
    fn draw_offscreen(&self, encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, runs: &[Run], globals: &wgpu::BindGroup) {
        drop(FxPass::clear_pass(encoder, view, "fx layer"));
        let mut i = 0;
        while i < runs.len() {
            if let Run::Object(k) = runs[i] {
                self.objects[k as usize].render_onto(encoder, view, false);
                i += 1;
                continue;
            }
            let j = runs[i..].iter().position(|r| matches!(r, Run::Object(_))).map_or(runs.len(), |k| i + k);
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("fx layer"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_bind_group(0, globals, &[]);
            self.draw_runs(&mut pass, &runs[i..j]);
            i = j;
        }
    }

    fn render_fx(&self, encoder: &mut wgpu::CommandEncoder, f: &FxRun, plan: &FxPlan, globals: &wgpu::BindGroup) {
        if f.adjust {
            // The scene so far becomes the layer; compositing it back replaces what is below.
            drop(FxPass::clear_pass(encoder, &self.fx.layer, "fx adjust"));
            let scene = self.fx.group_for(&self.device, self.post.target());
            self.fx.composite_group(encoder, &scene, &self.fx.layer, scene::paint::BlendMode::Normal, plan.copy);
        } else if f.samples.is_empty() {
            self.draw_offscreen(encoder, &self.fx.layer, &f.runs, globals);
        } else {
            // Motion blur: every sample drawn alone, then added in at 1/n.
            drop(FxPass::clear_pass(encoder, &self.fx.layer, "fx motion blur"));
            for runs in std::iter::once(&f.runs).chain(&f.samples) {
                self.draw_offscreen(encoder, &self.fx.accum, runs, globals);
                self.fx.composite(encoder, Tex::Accum, &self.fx.layer, scene::paint::BlendMode::Add, plan.average);
            }
        }
        if let Some((m, _)) = &f.matte {
            self.draw_offscreen(encoder, &self.fx.matte, m, globals);
        }
        // Blurs and custom shader effects change the layer itself, in stack order.
        for step in &plan.steps {
            match *step {
                LayerStep::Blur(h, v) => {
                    self.fx.blur(encoder, Tex::Layer, &self.fx.temp, h);
                    self.fx.blur(encoder, Tex::Temp, &self.fx.layer, v);
                }
                LayerStep::Shader(hash, offset) => {
                    // layer -> accum (free once motion blur is averaged), then copied back.
                    if self.custom.run_effect(&self.device, encoder, hash, offset, &self.fx.layer, &self.fx.accum) {
                        drop(FxPass::clear_pass(encoder, &self.fx.layer, "custom shader copy"));
                        self.fx.composite(encoder, Tex::Accum, &self.fx.layer, scene::paint::BlendMode::Normal, plan.replace);
                    }
                }
            }
        }
        let target = self.post.target();
        for (h, v, comp) in &plan.shadows {
            self.fx.blur(encoder, Tex::Layer, &self.fx.temp, *h);
            self.fx.blur(encoder, Tex::Temp, &self.fx.copy, *v);
            self.fx.composite(encoder, Tex::Copy, target, scene::paint::BlendMode::Normal, *comp);
        }
        if f.blend.reads_backdrop() {
            // The layer alone, then blended over a copy of the scene so far.
            drop(FxPass::clear_pass(encoder, &self.fx.scratch, "fx blend source"));
            self.fx.composite(encoder, Tex::Layer, &self.fx.scratch, scene::paint::BlendMode::Normal, plan.layer);
            self.fx.blend_over(&self.device, encoder, self.post.texture(), target, plan.blend);
        } else {
            self.fx.composite(encoder, Tex::Layer, target, f.blend, plan.layer);
        }
        for (h, v, comp, thresh) in &plan.glows {
            match thresh {
                Some(thresh) => {
                    drop(FxPass::clear_pass(encoder, &self.fx.accum, "fx glow threshold"));
                    self.fx.composite(encoder, Tex::Layer, &self.fx.accum, scene::paint::BlendMode::Normal, *thresh);
                    self.fx.blur(encoder, Tex::Accum, &self.fx.temp, *h);
                }
                None => self.fx.blur(encoder, Tex::Layer, &self.fx.temp, *h),
            }
            self.fx.blur(encoder, Tex::Temp, &self.fx.copy, *v);
            self.fx.composite(encoder, Tex::Copy, target, scene::paint::BlendMode::Add, *comp);
        }
    }
}

/// A pass that rewrites an offscreen layer in place.
enum LayerStep {
    /// (horizontal, vertical) blur uniform offsets.
    Blur(u32, u32),
    /// Custom shader effect: code hash, uniform offset in `CustomShaders`.
    Shader(u64, u32),
}

/// Uniform offsets for every pass of one offscreen layer.
struct FxPlan {
    /// Blurs and custom shader effects applied to the layer in place, in stack order.
    steps: Vec<LayerStep>,
    /// Plain copy back into the layer after a custom shader effect.
    replace: u32,
    /// (h blur, v blur, composite) per shadow.
    shadows: Vec<(u32, u32, u32)>,
    layer: u32,
    /// (h blur, v blur, composite, threshold pass) per glow.
    glows: Vec<(u32, u32, u32, Option<u32>)>,
    /// Plain copy (adjustment layers).
    copy: u32,
    /// One motion-blur sample at 1/n.
    average: u32,
    /// Uniform slot holding a backdrop blend's mode id (unused for fixed-function modes).
    blend: u32,
}

#[allow(clippy::too_many_arguments)]
fn plan_fx(fx: &mut FxPass, custom: &mut CustomShaders, shading: &FrameInfo, f: &FxRun, px_per_scene: f32, texel: [f32; 2], scene_w: f32, scene_h: f32, linear: bool) -> FxPlan {
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
    let mut plan = FxPlan { steps: Vec::new(), replace: 0, shadows: Vec::new(), layer: 0, glows: Vec::new(), copy: 0, average: 0, blend: 0 };
    // Color correction, distortion and grain all happen in the final layer composite.
    let (mut hue, mut sat, mut bright, mut contrast) = (0.0, 1.0, 0.0, 1.0);
    let mut warp = [0.0f32; 4];
    let mut grain = [0.0f32; 4];
    let mut turb = [0.0f32; 4];
    let (h0, h1, h2) = f.perspective.map_or(([0.0; 4], [0.0; 4], [0.0; 4]), |m| {
        ([m[0], m[1], m[2], 1.0], [m[3], m[4], m[5], scene_w], [m[6], m[7], m[8], scene_h])
    });
    let origin = [f.plane_origin[0], f.plane_origin[1], 0.0, 0.0];
    for e in &f.effects {
        match *e {
            DrawEffect::Blur { radius } if radius > 0.0 => {
                let (h, v) = blur_pair(fx, radius);
                plan.steps.push(LayerStep::Blur(h, v));
            }
            DrawEffect::Shader { hash, params, time, scene_time, zoom } => {
                plan.steps.push(LayerStep::Shader(hash, custom.push_effect(&params, time, scene_time, zoom, shading)));
            }
            DrawEffect::Shadow { offset, blur, color } => {
                let (h, v) = blur_pair(fx, blur);
                let comp = fx.push(FxParams {
                    a: [1.0, matte, 1.0, 1.0],
                    b: [offset[0] / scene_w, offset[1] / scene_h, 0.0, 0.0],
                    color: tint(color),
                    h0,
                    h1,
                    h2,
                    origin,
                    ..Default::default()
                });
                plan.shadows.push((h, v, comp));
            }
            DrawEffect::Glow { radius, strength, color, threshold } => {
                let (h, v) = blur_pair(fx, radius);
                let comp = fx.push(FxParams {
                    a: [2.0, matte, strength, if color.is_some() { 1.0 } else { 0.0 }],
                    color: color.map_or([1.0; 4], tint),
                    h0,
                    h1,
                    h2,
                    origin,
                    ..Default::default()
                });
                // Threshold: a pass that keeps only the bright pixels, blurred instead of the whole layer.
                let thresh = (threshold > 0.0).then(|| fx.push(FxParams { a: [3.0, matte, 1.0, 0.0], adj: [threshold, 0.0, 0.0, 0.0], ..Default::default() }));
                plan.glows.push((h, v, comp, thresh));
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
    plan.layer = fx.push(FxParams { a: [0.0, matte, 1.0, 0.0], b: [0.0, 0.0, clamp_edges, if f.adjust { 1.0 } else { 0.0 }], adj: [hue, sat - 1.0, bright, contrast - 1.0], warp, grain, turb, h0, h1, h2, origin, ..Default::default() });
    if f.blend.reads_backdrop() {
        plan.blend = fx.push(FxParams { a: [f.blend.shader_id(), 0.0, 0.0, 0.0], ..Default::default() });
    }
    if f.adjust {
        plan.copy = fx.push(FxParams::default());
    }
    if plan.steps.iter().any(|s| matches!(s, LayerStep::Shader(..))) {
        plan.replace = fx.push(FxParams::default());
    }
    if !f.samples.is_empty() {
        plan.average = fx.push(FxParams { a: [2.0, 0.0, 1.0 / (f.samples.len() + 1) as f32, 0.0], ..Default::default() });
    }
    plan
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
