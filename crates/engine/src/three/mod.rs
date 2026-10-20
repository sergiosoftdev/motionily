//! 3D stage renderer: glTF props (skinned characters, furniture, buildings),
//! an orbit/isometric camera, toon shading and inverted-hull outlines. Draws
//! into the scene texture with its own depth buffer, before the 2D layers.

mod model;
mod procedural;

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use model::{parse_glb, ModelData, Vertex3D};
use scene::{CameraKind, DrawStage, Rgba};
use std::collections::HashMap;
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
    light_dir: [f32; 4],
    ink: [f32; 4],
    params: [f32; 4],
    eye: [f32; 4],
}

/// Where an object layer lands: its box on screen (scene px) and the scene size.
#[derive(Clone, Copy)]
pub struct ScreenBox {
    pub center: [f32; 2],
    pub size: [f32; 2],
    pub scene: [f32; 2],
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
}

struct GpuModel {
    data: ModelData,
    prims: Vec<GpuPrim>,
    /// Texture group key (the model pack), if any primitive is textured.
    texture: Option<String>,
}

pub struct StageRenderer {
    pipeline: wgpu::RenderPipeline,
    outline: wgpu::RenderPipeline,
    frame_buf: wgpu::Buffer,
    frame_group: wgpu::BindGroup,
    draw_layout: wgpu::BindGroupLayout,
    draw_buf: wgpu::Buffer,
    draw_group: wgpu::BindGroup,
    draw_capacity: u64,
    tex_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    white: wgpu::BindGroup,
    textures: HashMap<String, wgpu::BindGroup>,
    models: HashMap<String, GpuModel>,
    depth: wgpu::TextureView,
    depth_size: [u32; 2],
    /// Draw list of the current frame: (model key, prim index, draw slot, outline).
    draws: Vec<(String, usize, u32, bool)>,
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
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("stage frame"), entries: &[uniform_entry(0, false)] });
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
        let make = |label, vs, fs, cull| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(vs),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<Vertex3D>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &ATTRS,
                    })],
                },
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

        let frame_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("stage frame"),
            size: std::mem::size_of::<FrameU>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let frame_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("stage frame"),
            layout: &frame_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: frame_buf.as_entire_binding() }],
        });
        let draw_capacity = 64;
        let (draw_buf, draw_group) = Self::make_draw_buffer(device, &draw_layout, draw_capacity);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let white = Self::texture_group(device, queue, &tex_layout, &sampler, &[255; 4], 1, 1);
        let depth = Self::make_depth(device, size);

        let mut renderer = StageRenderer {
            pipeline,
            outline,
            frame_buf,
            frame_group,
            draw_layout,
            draw_buf,
            draw_group,
            draw_capacity,
            tex_layout,
            sampler,
            white,
            textures: HashMap::new(),
            models: HashMap::new(),
            depth,
            depth_size: size,
            draws: Vec::new(),
            has_frame: false,
        };
        renderer.add_floor(device);
        renderer
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

    /// A big unlit square on y = 0, tinted with the stage floor color.
    fn add_floor(&mut self, device: &wgpu::Device) {
        const HALF: f32 = 60.0;
        let v = |x: f32, z: f32| Vertex3D { pos: [x, 0.0, z], normal: [0.0, 1.0, 0.0], ..Default::default() };
        let vertices = vec![v(-HALF, -HALF), v(HALF, -HALF), v(HALF, HALF), v(-HALF, HALF)];
        let data = ModelData {
            prims: vec![model::PrimData { vertices, indices: vec![0, 2, 1, 0, 3, 2], color: [1.0; 4], textured: false, node: 0, skin: None }],
            nodes: vec![model::NodeData {
                parent: None,
                rest: model::Trs { t: Vec3::ZERO, r: glam::Quat::IDENTITY, s: Vec3::ONE },
            }],
            skins: vec![],
            clips: vec![],
            uses_texture: false,
        };
        self.upload(device, FLOOR_KEY, data, None);
    }

    fn upload(&mut self, device: &wgpu::Device, key: &str, data: ModelData, texture: Option<String>) {
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
            })
            .collect();
        self.models.insert(key.to_owned(), GpuModel { data, prims, texture });
    }

    /// Register a GLB under `key` ("characters/character-female-b"). Its texture group is the pack ("characters").
    pub fn add_model(&mut self, device: &wgpu::Device, key: &str, bytes: &[u8]) -> Result<(), String> {
        let data = parse_glb(bytes)?;
        let texture = data.uses_texture.then(|| key.split('/').next().unwrap_or(key).to_owned());
        self.upload(device, key, data, texture);
        Ok(())
    }

    /// Shared texture of a model pack (decoded RGBA8 from the host).
    pub fn add_texture(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, pack: &str, rgba: &[u8], width: u32, height: u32) {
        let group = Self::texture_group(device, queue, &self.tex_layout, &self.sampler, rgba, width, height);
        self.textures.insert(pack.to_owned(), group);
    }

    pub fn has_model(&self, key: &str) -> bool {
        self.models.contains_key(key)
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
        let Some(stage) = stage else { return };
        self.has_frame = true;

        let cam = &stage.camera;
        let eye = Vec3::from(cam.eye);
        let target = Vec3::from(cam.target);
        let view = look_at_rh(eye, target, Vec3::Y);
        let aspect = screen.map_or(aspect, |b| b.size[0] / b.size[1].max(1.0));
        let proj = match cam.kind {
            CameraKind::Perspective => perspective_rh(cam.fov.to_radians(), aspect, 0.05, 300.0),
            CameraKind::Isometric => orthographic_rh(cam.ortho * aspect, cam.ortho, -200.0, 400.0),
        };
        // Object layers: map the full-frame picture into their box (in clip space).
        let fit = screen.map_or(Mat4::IDENTITY, |b| {
            let c = [b.center[0] / b.scene[0] * 2.0 - 1.0, 1.0 - b.center[1] / b.scene[1] * 2.0];
            Mat4::from_translation(Vec3::new(c[0], c[1], 0.0)) * Mat4::from_scale(Vec3::new(b.size[0] / b.scene[0], b.size[1] / b.scene[1], 1.0))
        });
        let outlines = stage.finish == scene::Finish::Toon;
        let light = (eye - target).normalize() * 0.4 + Vec3::new(0.5, 1.0, 0.35);
        let rgba = |c: Rgba| c.0;
        queue.write_buffer(
            &self.frame_buf,
            0,
            bytemuck::bytes_of(&FrameU {
                view_proj: (fit * proj * view).to_cols_array_2d(),
                light_dir: light.normalize().extend(0.0).to_array(),
                ink: rgba(stage.ink),
                params: [if linearize { 1.0 } else { 0.0 }, OUTLINE_WIDTH, finish_code(stage.finish), 0.0],
                eye: eye.extend(1.0).to_array(),
            }),
        );

        let mut uniforms: Vec<DrawU> = Vec::new();
        let push = |u: DrawU, uniforms: &mut Vec<DrawU>| {
            uniforms.push(u);
            uniforms.len() as u32 - 1
        };
        let identity = Mat4::IDENTITY.to_cols_array_2d();

        if let Some(floor) = stage.floor {
            let slot = push(
                DrawU { model: identity, tint: rgba(floor), flags: [0.0, 0.0, 0.0, 1.0], joints: [identity; MAX_JOINTS] },
                &mut uniforms,
            );
            self.draws.push((FLOOR_KEY.to_owned(), 0, slot, false));
        }

        // Procedural pieces: one cached mesh per recipe, tinted per piece.
        for solid in &stage.solids {
            // 3D text meshes depend on the font really used: a font that arrives later rebuilds them.
            let key = match scene::glyphs::outline(&solid.geometry) {
                Some(o) => format!("@proc:{}@{}", solid.geometry.key(), o.font),
                None if matches!(solid.geometry, scene::Geometry::Text { .. }) => continue,
                None => format!("@proc:{}", solid.geometry.key()),
            };
            if !self.models.contains_key(&key) {
                let mesh = procedural::build(&solid.geometry);
                let data = ModelData {
                    prims: vec![model::PrimData { vertices: mesh.vertices, indices: mesh.indices, color: [1.0; 4], textured: false, node: 0, skin: None }],
                    nodes: vec![model::NodeData { parent: None, rest: model::Trs { t: Vec3::ZERO, r: glam::Quat::IDENTITY, s: Vec3::ONE } }],
                    skins: vec![],
                    clips: vec![],
                    uses_texture: false,
                };
                self.upload(device, &key, data, None);
            }
            let slot = push(
                DrawU { model: solid.transform, tint: rgba(solid.color), flags: [0.0, 0.0, 1.0, 0.0], joints: [identity; MAX_JOINTS] },
                &mut uniforms,
            );
            self.draws.push((key, 0, slot, outlines));
        }

        // glTF models placed inside procedural trees (static pose).
        for placed in &stage.placed {
            let Some(model) = self.models.get(&placed.model) else { continue };
            let world = Mat4::from_cols_array_2d(&placed.transform);
            let globals = model.data.globals(&model.data.pose(None, 0.0));
            for (i, prim) in model.data.prims.iter().enumerate() {
                let mut u = DrawU { model: world.to_cols_array_2d(), tint: prim.color, flags: [0.0, if prim.textured { 1.0 } else { 0.0 }, 1.0, 0.0], joints: [identity; MAX_JOINTS] };
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
                self.draws.push((placed.model.clone(), i, slot, true));
            }
        }

        for prop in &stage.props {
            let Some(model) = self.models.get(&prop.model) else { continue };
            let world = Mat4::from_scale_rotation_translation(
                Vec3::from(prop.scale),
                glam::Quat::from_rotation_y(prop.rotation),
                Vec3::from(prop.position),
            );
            let clip = prop.action.as_deref().and_then(|a| model.data.clip(a));
            let locals = model.data.pose(clip, prop.action_time);
            let globals = model.data.globals(&locals);
            for (i, prim) in model.data.prims.iter().enumerate() {
                let mut u = DrawU {
                    model: world.to_cols_array_2d(),
                    tint: [prim.color[0] * prop.tint.0[0], prim.color[1] * prop.tint.0[1], prim.color[2] * prop.tint.0[2], 1.0],
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
                self.draws.push((prop.model.clone(), i, slot, true));
            }
        }

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
            for (key, prim_index, slot, outline) in &self.draws {
                if outlines && !outline {
                    continue;
                }
                let Some(model) = self.models.get(key) else { continue };
                let prim = &model.prims[*prim_index];
                let tex = model.texture.as_ref().and_then(|t| self.textures.get(t)).unwrap_or(&self.white);
                pass.set_bind_group(1, &self.draw_group, &[(*slot as u64 * DRAW_STRIDE) as u32]);
                pass.set_bind_group(2, tex, &[]);
                pass.set_vertex_buffer(0, prim.vertices.slice(..));
                pass.set_index_buffer(prim.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..prim.count, 0, 0..1);
            }
        }
        true
    }
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
}
