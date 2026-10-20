//! 3D stage renderer: glTF props (skinned characters, furniture, buildings),
//! an orbit/isometric camera, toon shading and inverted-hull outlines, lights
//! (key, ambient, points) with a key-light shadow map. Draws into the scene
//! texture with its own depth buffer, before the 2D layers.

mod lights;
mod model;
mod procedural;
mod shadows;
#[cfg(test)]
mod webgl_check;

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use model::{parse_glb, ModelData, TexSource, Vertex3D};
use scene::{CameraKind, DrawStage, Rgba, MAX_POINT_LIGHTS};
use std::collections::HashMap;
use std::sync::Arc;
use wgpu::util::DeviceExt;

const MAX_JOINTS: usize = 16;
/// Dynamic-offset stride for per-draw uniforms (must be a multiple of 256).
const DRAW_STRIDE: u64 = 1280;
const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;
/// Outline thickness in world units (meters) at scale 1.
const OUTLINE_WIDTH: f32 = 0.018;
const FLOOR_KEY: &str = "__floor";

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct FrameU {
    view_proj: [[f32; 4]; 4],
    light_vp: [[f32; 4]; 4],
    light_dir: [f32; 4],
    key: [f32; 4],
    sky: [f32; 4],
    ground: [f32; 4],
    shadow: [f32; 4],
    ink: [f32; 4],
    params: [f32; 4],
    eye: [f32; 4],
    point_pos: [[f32; 4]; MAX_POINT_LIGHTS],
    point_color: [[f32; 4]; MAX_POINT_LIGHTS],
}

/// Where an object layer lands: its box on screen (scene px), turned `rotation` rad clockwise,
/// and the scene size.
#[derive(Clone, Copy)]
pub struct ScreenBox {
    pub center: [f32; 2],
    pub size: [f32; 2],
    pub rotation: f32,
    pub scene: [f32; 2],
}

impl ScreenBox {
    /// Clip-space map from the object's own full-frame picture into its (turned) box.
    fn fit(&self) -> Mat4 {
        let [sw, sh] = self.scene;
        let [w, h] = self.size;
        let (s, c) = self.rotation.sin_cos();
        Mat4::from_cols(
            glam::Vec4::new(w * c / sw, -w * s / sh, 0.0, 0.0),
            glam::Vec4::new(h * s / sw, h * c / sh, 0.0, 0.0),
            glam::Vec4::new(0.0, 0.0, 1.0, 0.0),
            glam::Vec4::new(self.center[0] / sw * 2.0 - 1.0, 1.0 - self.center[1] / sh * 2.0, 0.0, 1.0),
        )
    }
}

fn finish_code(f: scene::Finish) -> f32 {
    match f {
        scene::Finish::Toon => 0.0,
        scene::Finish::Glossy => 1.0,
        scene::Finish::Glass => 2.0,
        scene::Finish::Chrome => 3.0,
        scene::Finish::Matte => 4.0,
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct DrawU {
    model: [[f32; 4]; 4],
    tint: [f32; 4],
    flags: [f32; 4],
    joints: [[[f32; 4]; 4]; MAX_JOINTS],
}

struct GpuPrim {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    count: u32,
    /// Texture keys to try in order (the image's own key, then the model pack's shared one).
    textures: Vec<String>,
}

struct GpuModel {
    data: ModelData,
    prims: Vec<GpuPrim>,
    /// Box at rest in model space (shadow-map fitting).
    bounds: Option<(Vec3, Vec3)>,
}

/// One draw of the current frame.
struct DrawCall {
    model: String,
    prim: usize,
    slot: u32,
    outline: bool,
    /// Drawn into the shadow map (everything but the floor).
    casts: bool,
}

pub struct StageRenderer {
    pipeline: wgpu::RenderPipeline,
    outline: wgpu::RenderPipeline,
    shadow_pipeline: wgpu::RenderPipeline,
    frame_buf: wgpu::Buffer,
    frame_layout: wgpu::BindGroupLayout,
    frame_group: wgpu::BindGroup,
    /// Uniforms only, for the shadow pass (the map cannot be bound while it is drawn).
    shadow_frame_group: wgpu::BindGroup,
    shadow_sampler: wgpu::Sampler,
    /// The real 2048² map once a stage asks for shadows (a 1×1 placeholder is bound until then).
    shadow_map: Option<wgpu::TextureView>,
    shadows_on: bool,
    draw_layout: wgpu::BindGroupLayout,
    draw_buf: wgpu::Buffer,
    draw_group: wgpu::BindGroup,
    draw_capacity: u64,
    tex_layout: wgpu::BindGroupLayout,
    /// Pack palettes (Kenney colormaps): crisp texels.
    sampler: wgpu::Sampler,
    /// Images embedded in models (photos, painted maps): smooth.
    smooth_sampler: wgpu::Sampler,
    white: wgpu::BindGroup,
    textures: HashMap<String, wgpu::BindGroup>,
    models: HashMap<String, Arc<GpuModel>>,
    /// Embedded images waiting for the host to decode them: key -> encoded bytes.
    embedded: HashMap<String, Arc<Vec<u8>>>,
    /// Bumped on every new model or texture, so object renderers know when to copy them.
    assets_gen: u64,
    /// The source's `assets_gen` when this renderer last copied its assets.
    synced_gen: Option<u64>,
    depth: wgpu::TextureView,
    depth_size: [u32; 2],
    draws: Vec<DrawCall>,
    has_frame: bool,
}

impl StageRenderer {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat, size: [u32; 2]) -> Self {
        let uniform_entry = |binding, dynamic| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: dynamic,
                min_binding_size: None,
            },
            count: None,
        };
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("stage frame"),
            entries: &[
                uniform_entry(0, false),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                    count: None,
                },
            ],
        });
        let shadow_frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("stage shadow frame"), entries: &[uniform_entry(0, false)] });
        let draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("stage draw"), entries: &[uniform_entry(0, true)] });
        let tex_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("stage texture"),
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
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("stage"),
            bind_group_layouts: &[Some(&frame_layout), Some(&draw_layout), Some(&tex_layout)],
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("mesh.wgsl"));
        const ATTRS: [wgpu::VertexAttribute; 5] = wgpu::vertex_attr_array![
            0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x4, 4 => Float32x4
        ];
        let vertex_buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex3D>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &ATTRS,
        })];
        let make = |label, vs, fs, cull| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                vertex: wgpu::VertexState { module: &shader, entry_point: Some(vs), compilation_options: Default::default(), buffers: &vertex_buffers },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: wgpu::PrimitiveState { cull_mode: Some(cull), ..Default::default() },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH_FORMAT,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::Less),
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let pipeline = make("stage", "vs", "fs", wgpu::Face::Back);
        let outline = make("stage outline", "vs_outline", "fs_outline", wgpu::Face::Front);
        let shadow_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("stage shadow"),
            bind_group_layouts: &[Some(&shadow_frame_layout), Some(&draw_layout)],
            ..Default::default()
        });
        let shadow_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("stage shadow"),
            layout: Some(&shadow_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_shadow"), compilation_options: Default::default(), buffers: &vertex_buffers },
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs_shadow"), compilation_options: Default::default(), targets: &[] }),
            // Both faces cast: thin pieces (planes, leaves, open meshes) still shade the floor.
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: shadows::SHADOW_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: wgpu::DepthBiasState { constant: 2, slope_scale: 2.0, clamp: 0.0 },
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });

        let frame_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("stage frame"),
            size: std::mem::size_of::<FrameU>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let shadow_sampler = shadows::comparison_sampler(device);
        let frame_group = Self::frame_group(device, &frame_layout, &frame_buf, &shadows::depth_view(device, 1), &shadow_sampler);
        let shadow_frame_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("stage shadow frame"),
            layout: &shadow_frame_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: frame_buf.as_entire_binding() }],
        });
        let draw_capacity = 64;
        let (draw_buf, draw_group) = Self::make_draw_buffer(device, &draw_layout, draw_capacity);
        let sampler_with = |mag| {
            device.create_sampler(&wgpu::SamplerDescriptor {
                // glTF's default wrap is repeat.
                address_mode_u: wgpu::AddressMode::Repeat,
                address_mode_v: wgpu::AddressMode::Repeat,
                mag_filter: mag,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            })
        };
        let sampler = sampler_with(wgpu::FilterMode::Nearest);
        let smooth_sampler = sampler_with(wgpu::FilterMode::Linear);
        let white = Self::texture_group(device, queue, &tex_layout, &sampler, &[255; 4], 1, 1);
        let depth = Self::make_depth(device, size);

        let mut renderer = StageRenderer {
            pipeline,
            outline,
            shadow_pipeline,
            frame_buf,
            frame_layout,
            frame_group,
            shadow_frame_group,
            shadow_sampler,
            shadow_map: None,
            shadows_on: false,
            draw_layout,
            draw_buf,
            draw_group,
            draw_capacity,
            tex_layout,
            sampler,
            smooth_sampler,
            white,
            textures: HashMap::new(),
            models: HashMap::new(),
            embedded: HashMap::new(),
            assets_gen: 0,
            synced_gen: None,
            depth,
            depth_size: size,
            draws: Vec::new(),
            has_frame: false,
        };
        renderer.add_floor(device);
        renderer
    }

    fn frame_group(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, buf: &wgpu::Buffer, shadow: &wgpu::TextureView, sampler: &wgpu::Sampler) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("stage frame"),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(shadow) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(sampler) },
            ],
        })
    }

    fn make_draw_buffer(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, capacity: u64) -> (wgpu::Buffer, wgpu::BindGroup) {
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("stage draws"),
            size: capacity * DRAW_STRIDE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("stage draws"),
            layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &buf,
                    offset: 0,
                    size: wgpu::BufferSize::new(std::mem::size_of::<DrawU>() as u64),
                }),
            }],
        });
        (buf, group)
    }

    fn make_depth(device: &wgpu::Device, size: [u32; 2]) -> wgpu::TextureView {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("stage depth"),
                size: wgpu::Extent3d { width: size[0].max(1), height: size[1].max(1), depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: DEPTH_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&Default::default())
    }

    fn texture_group(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> wgpu::BindGroup {
        let texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("stage texture"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            Default::default(),
            rgba,
        );
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("stage texture"),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&texture.create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
            ],
        })
    }

    /// A big square on y = 0, tinted with the stage floor color (lit only by shadows and lights).
    fn add_floor(&mut self, device: &wgpu::Device) {
        const HALF: f32 = 60.0;
        let v = |x: f32, z: f32| Vertex3D { pos: [x, 0.0, z], normal: [0.0, 1.0, 0.0], ..Default::default() };
        let vertices = vec![v(-HALF, -HALF), v(HALF, -HALF), v(HALF, HALF), v(-HALF, HALF)];
        let data = ModelData {
            prims: vec![model::PrimData { vertices, indices: vec![0, 2, 1, 0, 3, 2], color: [1.0; 4], textured: false, texture: None, node: 0, skin: None }],
            nodes: vec![model::NodeData {
                parent: None,
                rest: model::Trs { t: Vec3::ZERO, r: glam::Quat::IDENTITY, s: Vec3::ONE },
            }],
            skins: vec![],
            clips: vec![],
            images: vec![],
        };
        self.upload(device, FLOOR_KEY, data);
    }

    fn upload(&mut self, device: &wgpu::Device, key: &str, data: ModelData) {
        // Images live next to the model (`dir/uri`) or inside it (`key#index`); Kenney packs
        // also answer to the pack name the host registers their shared colormap under.
        let dir = key.rsplit_once('/').map_or("", |(d, _)| d);
        let pack = key.split('/').next().unwrap_or(key);
        let prims = data
            .prims
            .iter()
            .map(|p| GpuPrim {
                vertices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("mesh vertices"),
                    contents: bytemuck::cast_slice(&p.vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                }),
                indices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("mesh indices"),
                    contents: bytemuck::cast_slice(&p.indices),
                    usage: wgpu::BufferUsages::INDEX,
                }),
                count: p.indices.len() as u32,
                textures: match &p.texture {
                    None => Vec::new(),
                    Some(TexSource::Uri(uri)) => vec![texture_key(dir, uri), pack.to_owned()],
                    Some(TexSource::Embedded(i)) => vec![embedded_key(key, *i)],
                },
            })
            .collect();
        let bounds = data.rest_bounds();
        self.models.insert(key.to_owned(), Arc::new(GpuModel { data, prims, bounds }));
        self.assets_gen += 1;
    }

    /// Register a GLB under `key` ("characters/character-female-b"). Its images are looked up as
    /// `dir/uri` (falling back to the pack's shared texture) or, embedded, `key#index`.
    pub fn add_model(&mut self, device: &wgpu::Device, key: &str, bytes: &[u8]) -> Result<(), String> {
        let mut data = parse_glb(bytes)?;
        for (i, bytes) in std::mem::take(&mut data.images) {
            self.embedded.insert(embedded_key(key, i), Arc::new(bytes));
        }
        self.upload(device, key, data);
        Ok(())
    }

    /// Register a decoded texture (RGBA8): a model pack's shared one ("characters") or one image by
    /// its key (`missing_textures`).
    pub fn add_texture(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, key: &str, rgba: &[u8], width: u32, height: u32) {
        let sampler = if self.embedded.contains_key(key) { &self.smooth_sampler } else { &self.sampler };
        let group = Self::texture_group(device, queue, &self.tex_layout, sampler, rgba, width, height);
        self.textures.insert(key.to_owned(), group);
        self.assets_gen += 1;
    }

    pub fn has_model(&self, key: &str) -> bool {
        self.models.contains_key(key)
    }

    /// Image keys loaded models need that no registered texture answers (first choice of each).
    pub fn missing_textures(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .models
            .values()
            .flat_map(|m| &m.prims)
            .filter(|p| !p.textures.is_empty() && !p.textures.iter().any(|k| self.textures.contains_key(k)))
            .map(|p| p.textures[0].clone())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Encoded bytes (PNG/JPEG) of an image embedded in a model, for the host to decode.
    pub fn embedded_texture(&self, key: &str) -> Option<&[u8]> {
        self.embedded.get(key).map(|b| b.as_slice())
    }

    /// Every registered texture key (to hand the same textures to another engine).
    pub fn texture_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.textures.keys().cloned().collect();
        keys.sort();
        keys
    }

    /// Share `src`'s models and textures (object layers draw the same glTF props as the stage).
    pub fn share_assets(&mut self, src: &StageRenderer) {
        if self.synced_gen == Some(src.assets_gen) {
            return;
        }
        for (k, m) in &src.models {
            self.models.entry(k.clone()).or_insert_with(|| m.clone());
        }
        for (k, t) in &src.textures {
            self.textures.entry(k.clone()).or_insert_with(|| t.clone());
        }
        self.synced_gen = Some(src.assets_gen);
    }

    pub fn resize(&mut self, device: &wgpu::Device, size: [u32; 2]) {
        if self.depth_size != size {
            self.depth = Self::make_depth(device, size);
            self.depth_size = size;
        }
    }

    /// Compute camera, skeleton poses and per-draw uniforms for this frame.
    pub fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, stage: Option<&DrawStage>, aspect: f32, linearize: bool) {
        self.prepare_in(device, queue, stage, aspect, linearize, None);
    }

    /// Like `prepare`, but the picture is squeezed into `screen` (object layers).
    pub fn prepare_in(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, stage: Option<&DrawStage>, aspect: f32, linearize: bool, screen: Option<ScreenBox>) {
        self.draws.clear();
        self.has_frame = false;
        self.shadows_on = false;
        let Some(stage) = stage else { return };
        self.has_frame = true;

        let cam = &stage.camera;
        let eye = Vec3::from(cam.eye);
        let target = Vec3::from(cam.target);
        // Roll turns the picture around the view axis (clockwise camera = counter-clockwise image).
        let view = Mat4::from_rotation_z(cam.roll) * look_at_rh(eye, target, Vec3::Y);
        let aspect = screen.map_or(aspect, |b| b.size[0] / b.size[1].max(1.0));
        let proj = match cam.kind {
            CameraKind::Perspective => perspective_rh(cam.fov.to_radians(), aspect, 0.05, 300.0),
            CameraKind::Isometric => orthographic_rh(cam.ortho * aspect, cam.ortho, -200.0, 400.0),
        };
        // Object layers: map the full-frame picture into their box (in clip space).
        let fit = screen.map_or(Mat4::IDENTITY, |b| b.fit());
        let outlines = stage.finish == scene::Finish::Toon;
        let rgba = |c: Rgba| c.0;

        let mut uniforms: Vec<DrawU> = Vec::new();
        let push = |u: DrawU, uniforms: &mut Vec<DrawU>| {
            uniforms.push(u);
            uniforms.len() as u32 - 1
        };
        let identity = Mat4::IDENTITY.to_cols_array_2d();
        // World box of everything that casts a shadow.
        let mut casters: Option<(Vec3, Vec3)> = None;
        let mut grow = |m: Mat4, b: Option<(Vec3, Vec3)>| {
            let Some((lo, hi)) = b else { return };
            for i in 0..8 {
                let p = m.transform_point3(Vec3::new([lo.x, hi.x][i & 1], [lo.y, hi.y][(i >> 1) & 1], [lo.z, hi.z][(i >> 2) & 1]));
                casters = Some(casters.map_or((p, p), |(a, c)| (a.min(p), c.max(p))));
            }
        };

        if let Some(floor) = stage.floor {
            let slot = push(DrawU { model: identity, tint: rgba(floor), flags: [0.0, 0.0, 0.0, 1.0], joints: [identity; MAX_JOINTS] }, &mut uniforms);
            self.draws.push(DrawCall { model: FLOOR_KEY.to_owned(), prim: 0, slot, outline: false, casts: false });
        }

        // Procedural pieces: one cached mesh per recipe, tinted per piece.
        for solid in &stage.solids {
            let key = format!("@proc:{}", solid.geometry.key());
            if !self.models.contains_key(&key) {
                let mesh = procedural::build(&solid.geometry);
                let data = ModelData {
                    prims: vec![model::PrimData { vertices: mesh.vertices, indices: mesh.indices, color: [1.0; 4], textured: false, texture: None, node: 0, skin: None }],
                    nodes: vec![model::NodeData { parent: None, rest: model::Trs { t: Vec3::ZERO, r: glam::Quat::IDENTITY, s: Vec3::ONE } }],
                    skins: vec![],
                    clips: vec![],
                    images: vec![],
                };
                self.upload(device, &key, data);
            }
            let (lo, hi) = scene::geometry_bounds(&solid.geometry);
            grow(Mat4::from_cols_array_2d(&solid.transform), Some((Vec3::from(lo), Vec3::from(hi))));
            let slot = push(DrawU { model: solid.transform, tint: rgba(solid.color), flags: [0.0, 0.0, 1.0, 0.0], joints: [identity; MAX_JOINTS] }, &mut uniforms);
            self.draws.push(DrawCall { model: key, prim: 0, slot, outline: outlines, casts: true });
        }

        // glTF models placed inside procedural trees (static pose) and stage props (animated).
        let placed = stage.placed.iter().map(|p| (&p.model, Mat4::from_cols_array_2d(&p.transform), None, 0.0, [1.0; 4]));
        let props = stage.props.iter().map(|p| {
            let world = Mat4::from_scale_rotation_translation(Vec3::from(p.scale), glam::Quat::from_rotation_y(p.rotation), Vec3::from(p.position));
            (&p.model, world, p.action.as_deref(), p.action_time, p.tint.0)
        });
        for (key, world, action, time, tint) in placed.chain(props) {
            let Some(model) = self.models.get(key) else { continue };
            grow(world, model.bounds);
            let clip = action.and_then(|a| model.data.clip(a));
            let globals = model.data.globals(&model.data.pose(clip, time));
            for (i, prim) in model.data.prims.iter().enumerate() {
                let mut u = DrawU {
                    model: world.to_cols_array_2d(),
                    tint: [prim.color[0] * tint[0], prim.color[1] * tint[1], prim.color[2] * tint[2], prim.color[3]],
                    flags: [0.0, if prim.textured { 1.0 } else { 0.0 }, 1.0, 0.0],
                    joints: [identity; MAX_JOINTS],
                };
                match prim.skin.and_then(|s| model.data.skins.get(s)) {
                    Some(skin) => {
                        u.flags[0] = 1.0;
                        for (j, (&node, inv)) in skin.joints.iter().zip(&skin.inverse_bind).take(MAX_JOINTS).enumerate() {
                            u.joints[j] = (globals[node] * *inv).to_cols_array_2d();
                        }
                    }
                    None => u.model = (world * globals[prim.node]).to_cols_array_2d(),
                }
                let slot = push(u, &mut uniforms);
                self.draws.push(DrawCall { model: key.clone(), prim: i, slot, outline: true, casts: true });
            }
        }

        // Shadows: the stage only (object layers get a 2D contact shadow instead).
        let lit = stage.lights.as_ref();
        let shadow = lit
            .filter(|l| l.shadows && screen.is_none())
            .zip(casters)
            .and_then(|(l, c)| shadows::fit(Vec3::from(l.key_dir), c, l.softness));
        if shadow.is_some() && self.shadow_map.is_none() {
            let map = shadows::depth_view(device, shadows::SHADOW_SIZE);
            self.frame_group = Self::frame_group(device, &self.frame_layout, &self.frame_buf, &map, &self.shadow_sampler);
            self.shadow_map = Some(map);
        }
        self.shadows_on = shadow.is_some();
        let lu = lights::uniforms(lit, eye, target);
        queue.write_buffer(
            &self.frame_buf,
            0,
            bytemuck::bytes_of(&FrameU {
                view_proj: (fit * proj * view).to_cols_array_2d(),
                light_vp: shadow.map_or(Mat4::IDENTITY, |s| s.light_vp).to_cols_array_2d(),
                light_dir: lu.light_dir,
                key: lu.key,
                sky: lu.sky,
                ground: lu.ground,
                shadow: shadow.map_or([0.0; 4], |s| s.params),
                ink: rgba(stage.ink),
                params: [if linearize { 1.0 } else { 0.0 }, OUTLINE_WIDTH, finish_code(stage.finish), 0.0],
                eye: eye.extend(1.0).to_array(),
                point_pos: lu.point_pos,
                point_color: lu.point_color,
            }),
        );

        if uniforms.len() as u64 > self.draw_capacity {
            self.draw_capacity = (uniforms.len() as u64).next_power_of_two();
            (self.draw_buf, self.draw_group) = Self::make_draw_buffer(device, &self.draw_layout, self.draw_capacity);
        }
        let mut bytes = vec![0u8; uniforms.len() * DRAW_STRIDE as usize];
        for (i, u) in uniforms.iter().enumerate() {
            let at = i * DRAW_STRIDE as usize;
            bytes[at..at + std::mem::size_of::<DrawU>()].copy_from_slice(bytemuck::bytes_of(u));
        }
        if !bytes.is_empty() {
            queue.write_buffer(&self.draw_buf, 0, &bytes);
        }
    }

    /// Draw the stage into `target` (clearing it), with depth. No-op without a stage.
    pub fn render(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) -> bool {
        self.render_onto(encoder, target, true)
    }

    /// Draw into `target`, clearing it first or drawing over what is there.
    pub fn render_onto(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, clear: bool) -> bool {
        if !self.has_frame {
            return false;
        }
        if let (true, Some(map)) = (self.shadows_on, &self.shadow_map) {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("stage shadow map"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: map,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            pass.set_pipeline(&self.shadow_pipeline);
            pass.set_bind_group(0, &self.shadow_frame_group, &[]);
            for d in self.draws.iter().filter(|d| d.casts) {
                let Some(model) = self.models.get(&d.model) else { continue };
                let prim = &model.prims[d.prim];
                pass.set_bind_group(1, &self.draw_group, &[(d.slot as u64 * DRAW_STRIDE) as u32]);
                pass.set_vertex_buffer(0, prim.vertices.slice(..));
                pass.set_index_buffer(prim.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..prim.count, 0, 0..1);
            }
        }
        let load = if clear { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) } else { wgpu::LoadOp::Load };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("stage"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &self.depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_bind_group(0, &self.frame_group, &[]);
        for (pipeline, outlines) in [(&self.pipeline, false), (&self.outline, true)] {
            pass.set_pipeline(pipeline);
            for d in &self.draws {
                if outlines && !d.outline {
                    continue;
                }
                let Some(model) = self.models.get(&d.model) else { continue };
                let prim = &model.prims[d.prim];
                let tex = prim.textures.iter().find_map(|k| self.textures.get(k)).unwrap_or(&self.white);
                pass.set_bind_group(1, &self.draw_group, &[(d.slot as u64 * DRAW_STRIDE) as u32]);
                pass.set_bind_group(2, tex, &[]);
                pass.set_vertex_buffer(0, prim.vertices.slice(..));
                pass.set_index_buffer(prim.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..prim.count, 0, 0..1);
            }
        }
        true
    }
}

/// Key of an image next to a model: `dir/uri` with `./` dropped.
fn texture_key(dir: &str, uri: &str) -> String {
    let uri = uri.trim_start_matches("./");
    if dir.is_empty() { uri.to_owned() } else { format!("{dir}/{uri}") }
}

/// Key of an image embedded in model `key`.
fn embedded_key(key: &str, index: usize) -> String {
    format!("{key}#{index}")
}

/// Right-handed view matrix looking from `eye` at `target`.
fn look_at_rh(eye: Vec3, target: Vec3, up: Vec3) -> Mat4 {
    let f = (target - eye).normalize();
    let s = f.cross(up).normalize();
    let u = s.cross(f);
    Mat4::from_cols(
        glam::Vec4::new(s.x, u.x, -f.x, 0.0),
        glam::Vec4::new(s.y, u.y, -f.y, 0.0),
        glam::Vec4::new(s.z, u.z, -f.z, 0.0),
        glam::Vec4::new(-s.dot(eye), -u.dot(eye), f.dot(eye), 1.0),
    )
}

/// Right-handed perspective projection with WebGPU's 0..1 depth range.
fn perspective_rh(fov_y: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
    let h = 1.0 / (fov_y * 0.5).tan();
    let r = far / (near - far);
    Mat4::from_cols(
        glam::Vec4::new(h / aspect, 0.0, 0.0, 0.0),
        glam::Vec4::new(0.0, h, 0.0, 0.0),
        glam::Vec4::new(0.0, 0.0, r, -1.0),
        glam::Vec4::new(0.0, 0.0, r * near, 0.0),
    )
}

/// Right-handed orthographic projection centered on the view axis, 0..1 depth.
fn orthographic_rh(half_w: f32, half_h: f32, near: f32, far: f32) -> Mat4 {
    let r = 1.0 / (near - far);
    Mat4::from_cols(
        glam::Vec4::new(1.0 / half_w, 0.0, 0.0, 0.0),
        glam::Vec4::new(0.0, 1.0 / half_h, 0.0, 0.0),
        glam::Vec4::new(0.0, 0.0, r, 0.0),
        glam::Vec4::new(0.0, 0.0, r * near, 1.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projections_map_the_view_frustum_to_clip_space() {
        let view = look_at_rh(Vec3::new(0.0, 0.0, 5.0), Vec3::ZERO, Vec3::Y);
        let proj = perspective_rh(60f32.to_radians(), 1.0, 0.1, 100.0);
        let p = proj * view * glam::Vec4::new(0.0, 0.0, 0.0, 1.0);
        let ndc = p.truncate() / p.w;
        assert!(ndc.x.abs() < 1e-5 && ndc.y.abs() < 1e-5 && ndc.z > 0.0 && ndc.z < 1.0, "{ndc:?}");
        let o = orthographic_rh(2.0, 2.0, 0.0, 10.0) * view * glam::Vec4::new(2.0, 0.0, 0.0, 1.0);
        assert!((o.x - 1.0).abs() < 1e-5 && o.z >= 0.0 && o.z <= 1.0);
    }

    #[test]
    fn a_turned_object_box_maps_its_picture_corners_where_the_scene_measures_them() {
        let b = ScreenBox { center: [600.0, 400.0], size: [300.0, 100.0], rotation: 30f32.to_radians(), scene: [1000.0, 800.0] };
        let fit = b.fit();
        // The object's top-right clip corner (+1, +1) is the box's top-right corner, turned.
        let c = fit * glam::Vec4::new(1.0, 1.0, 0.5, 1.0);
        let px = [(c.x + 1.0) / 2.0 * 1000.0, (1.0 - c.y) / 2.0 * 800.0];
        let scene_box = scene::Bounds { center: b.center, size: b.size, rotation: b.rotation };
        let corner = scene_box.corners()[1];
        assert!((px[0] - corner[0]).abs() < 1e-2 && (px[1] - corner[1]).abs() < 1e-2, "{px:?} vs {corner:?}");
    }

    #[test]
    fn camera_roll_turns_the_stage_picture_counter_clockwise() {
        // A point right of the target, camera rolled 90° clockwise: it shows up above the center.
        let view = Mat4::from_rotation_z(90f32.to_radians()) * look_at_rh(Vec3::new(0.0, 0.0, 5.0), Vec3::ZERO, Vec3::Y);
        let p = perspective_rh(60f32.to_radians(), 1.0, 0.1, 100.0) * view * glam::Vec4::new(1.0, 0.0, 0.0, 1.0);
        assert!(p.x.abs() / p.w < 1e-5 && p.y / p.w > 0.1, "{p:?}");
    }
}
