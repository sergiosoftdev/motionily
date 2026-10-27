//! Offscreen layers for effects, blend modes and track mattes — the AE-style per-layer pipeline.
//!
//! A layer that needs it is drawn into its own texture (`layer`), optionally with its matte into
//! `matte`; blur effects run on it in place (ping-pong through `temp`); shadows and glows blur a
//! copy (`copy`) and composite under / over it; finally the layer is composited onto the scene
//! with its blend mode. All passes of a frame share one uniform buffer with dynamic offsets.

use bytemuck::{Pod, Zeroable};
use scene::paint::{BlendMode, MatteMode};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub struct FxParams {
    pub a: [f32; 4],
    pub b: [f32; 4],
    pub color: [f32; 4],
    pub adj: [f32; 4],
    pub warp: [f32; 4],
    pub grain: [f32; 4],
    pub turb: [f32; 4],
    /// 3D layers: inverse homography rows (xyz) + enabled, scene width, scene height (w).
    pub h0: [f32; 4],
    pub h1: [f32; 4],
    pub h2: [f32; 4],
    /// Tilted planes: the flat-space origin of the plane's pass (xy), so projected texels line up with
    /// the offset content.
    pub origin: [f32; 4],
    /// Layer composite grading: exposure (stops), temperature, tint, vibrance.
    pub grade: [f32; 4],
    /// Layer composite grading: shadows, highlights, vignette, unused.
    pub tone: [f32; 4],
    /// Color wheels (rgb, w unused): lift, gamma − 1, gain − 1, offset (so all-zero is neutral).
    pub lift: [f32; 4],
    pub gamma: [f32; 4],
    pub gain: [f32; 4],
    pub offset: [f32; 4],
    /// Points per curve: master, red, green, blue.
    pub curve_n: [f32; 4],
    /// Curve points, 3 vec4 per curve (x0 y0 x1 y1 …), master then red, green, blue.
    pub curve: [[f32; 4]; 12],
    /// LUT: how much of it shows (x; 0 = off), input transform (y: `LogInput::id`, 0 = none), the rest
    /// unused. The LUT itself is bind group 1.
    pub lut: [f32; 4],
}

/// The `.cube` LUTs the color effects use, as 3D textures (bind group 1 of every fx pipeline), shared by
/// the scene's pass and the tilted planes' ones. Unknown or absent LUTs bind an identity cube.
pub struct Luts {
    pub layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    identity: wgpu::BindGroup,
    map: std::collections::HashMap<u64, wgpu::BindGroup>,
}

impl Luts {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fx lut"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D3, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("fx lut"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let identity_lut = scene::lut::Lut { size: 2, data: (0..8).map(|i| [(i & 1) as f32, ((i >> 1) & 1) as f32, ((i >> 2) & 1) as f32]).collect() };
        let identity = Self::make(device, queue, &layout, &sampler, &identity_lut);
        Luts { layout, sampler, identity, map: Default::default() }
    }

    fn make(device: &wgpu::Device, queue: &wgpu::Queue, layout: &wgpu::BindGroupLayout, sampler: &wgpu::Sampler, lut: &scene::lut::Lut) -> wgpu::BindGroup {
        let n = lut.size;
        let size = wgpu::Extent3d { width: n, height: n, depth_or_array_layers: n };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("lut"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let texels = lut.rgba_f16();
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&texels),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(n * 8), rows_per_image: Some(n) },
            size,
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D3), ..Default::default() });
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lut"),
            layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) }],
        })
    }

    pub fn add(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, key: u64, lut: &scene::lut::Lut) {
        let group = Self::make(device, queue, &self.layout, &self.sampler, lut);
        self.map.insert(key, group);
    }

    pub fn has(&self, key: u64) -> bool {
        self.map.contains_key(&key)
    }

    /// The LUT under `key` (identity when 0 or not loaded yet).
    pub fn group(&self, key: u64) -> &wgpu::BindGroup {
        self.map.get(&key).unwrap_or(&self.identity)
    }
}

/// Uniform slot stride (WebGPU's minimum dynamic-offset alignment).
const SLOT: u64 = 512;
const INITIAL_SLOTS: u64 = 64;

/// Which offscreen texture a pass reads.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tex {
    Layer = 0,
    Temp = 1,
    Copy = 2,
    /// One motion-blur sample.
    Accum = 3,
}

pub struct FxPass {
    blur_pipeline: wgpu::RenderPipeline,
    composite: [wgpu::RenderPipeline; 4],
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    format: wgpu::TextureFormat,
    uniform: wgpu::Buffer,
    slots: u64,
    pub layer: wgpu::TextureView,
    pub temp: wgpu::TextureView,
    pub copy: wgpu::TextureView,
    pub matte: wgpu::TextureView,
    pub accum: wgpu::TextureView,
    /// Backdrop blend modes: the layer alone (cleared, composited, then blended over `backdrop`).
    pub scratch: wgpu::TextureView,
    /// Copy of the scene so far, taken before a backdrop blend.
    backdrop_texture: wgpu::Texture,
    pub backdrop: wgpu::TextureView,
    blend_pipeline: wgpu::RenderPipeline,
    /// Bind groups reading layer / temp / copy / accum (each with the matte).
    groups: Vec<wgpu::BindGroup>,
    /// Identity LUT for passes that do not grade (bind group 1 is always set).
    no_lut: wgpu::BindGroup,
    size: [u32; 2],
    params: Vec<FxParams>,
    /// Pixels `[x, y, w, h]` the passes of the layer being drawn may change (see `DrawFx::reach`);
    /// None = the whole target.
    scissor: std::cell::Cell<Option<[u32; 4]>>,
}

fn blend_state(mode: BlendMode) -> wgpu::BlendState {
    use wgpu::{BlendComponent, BlendFactor as F, BlendOperation::Add};
    let alpha = BlendComponent { src_factor: F::One, dst_factor: F::OneMinusSrcAlpha, operation: Add };
    let color = match mode {
        BlendMode::Normal => BlendComponent { src_factor: F::One, dst_factor: F::OneMinusSrcAlpha, operation: Add },
        BlendMode::Add => BlendComponent { src_factor: F::One, dst_factor: F::One, operation: Add },
        BlendMode::Screen => BlendComponent { src_factor: F::One, dst_factor: F::OneMinusSrc, operation: Add },
        BlendMode::Multiply => BlendComponent { src_factor: F::Dst, dst_factor: F::OneMinusSrcAlpha, operation: Add },
        // Backdrop modes never use fixed-function blending (see `FxPass::blend_over`).
        _ => BlendComponent { src_factor: F::One, dst_factor: F::OneMinusSrcAlpha, operation: Add },
    };
    let alpha = if mode == BlendMode::Add { BlendComponent { src_factor: F::One, dst_factor: F::One, operation: Add } } else { alpha };
    wgpu::BlendState { color, alpha }
}

impl FxPass {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32, luts: &Luts) -> Self {
        let tex = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fx"),
            entries: &[
                tex(0),
                tex(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<FxParams>() as u64),
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fx"),
            bind_group_layouts: &[Some(&layout), Some(&luts.layout)],
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("fx.wgsl"));
        let make = |label: &str, fs: &str, blend: Option<wgpu::BlendState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let blur_pipeline = make("fx blur", "fs_blur", None);
        let composite = [BlendMode::Normal, BlendMode::Add, BlendMode::Screen, BlendMode::Multiply].map(|m| make("fx composite", "fs_composite", Some(blend_state(m))));
        let blend_pipeline = make("fx blend", "fs_blend", None);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let uniform = make_uniform(device, INITIAL_SLOTS);
        let (layer, matte) = (make_texture(device, format, width, height), make_texture(device, format, width, height));
        let accum = make_texture(device, format, width, height);
        let scratch = make_texture(device, format, width, height);
        let (backdrop_texture, backdrop) = make_copy_target(device, format, width, height);
        // Blurs run at half resolution: the blur hides it and it costs a quarter of the fill rate.
        let (temp, copy) = (make_texture(device, format, width / 2, height / 2), make_texture(device, format, width / 2, height / 2));
        let mut fx = FxPass {
            blur_pipeline,
            composite,
            layout,
            sampler,
            format,
            uniform,
            slots: INITIAL_SLOTS,
            layer,
            temp,
            copy,
            matte,
            accum,
            scratch,
            backdrop_texture,
            backdrop,
            blend_pipeline,
            groups: Vec::new(),
            no_lut: luts.group(0).clone(),
            size: [width, height],
            params: Vec::new(),
            scissor: std::cell::Cell::new(None),
        };
        fx.rebind(device);
        fx
    }

    fn rebind(&mut self, device: &wgpu::Device) {
        self.groups = [&self.layer, &self.temp, &self.copy, &self.accum].iter().map(|src| self.group_for(device, src)).collect();
    }

    /// A bind group reading `src` (e.g. the scene so far, for adjustment layers).
    pub fn group_for(&self, device: &wgpu::Device, src: &wgpu::TextureView) -> wgpu::BindGroup {
        self.bind(device, src, &self.matte, "fx")
    }

    /// Bind group with `src` in slot 0 and `second` in slot 1 (the matte, or the backdrop for blends).
    fn bind(&self, device: &wgpu::Device, src: &wgpu::TextureView, second: &wgpu::TextureView, label: &str) -> wgpu::BindGroup {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some(label),
                    layout: &self.layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(second) },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &self.uniform,
                                offset: 0,
                                size: wgpu::BufferSize::new(std::mem::size_of::<FxParams>() as u64),
                            }),
                        },
                    ],
                })
    }

    /// Texture size this pass was built for.
    pub fn size(&self) -> [u32; 2] {
        self.size
    }

    pub fn resize(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if self.size == [width, height] {
            return;
        }
        self.size = [width, height];
        self.layer = make_texture(device, self.format, width, height);
        self.matte = make_texture(device, self.format, width, height);
        self.accum = make_texture(device, self.format, width, height);
        self.scratch = make_texture(device, self.format, width, height);
        (self.backdrop_texture, self.backdrop) = make_copy_target(device, self.format, width, height);
        self.temp = make_texture(device, self.format, width / 2, height / 2);
        self.copy = make_texture(device, self.format, width / 2, height / 2);
        self.rebind(device);
    }

    /// Start collecting this frame's pass parameters.
    pub fn begin(&mut self) {
        self.params.clear();
    }

    /// Reserve a uniform slot; returns its dynamic offset.
    pub fn push(&mut self, p: FxParams) -> u32 {
        self.params.push(p);
        ((self.params.len() - 1) as u64 * SLOT) as u32
    }

    /// Upload every slot (call after all `push`, before submitting).
    pub fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        let needed = self.params.len() as u64;
        if needed > self.slots {
            self.slots = needed.next_power_of_two();
            self.uniform = make_uniform(device, self.slots);
            self.rebind(device);
        }
        let mut bytes = vec![0u8; (needed * SLOT) as usize];
        for (i, p) in self.params.iter().enumerate() {
            let o = i * SLOT as usize;
            bytes[o..o + std::mem::size_of::<FxParams>()].copy_from_slice(bytemuck::bytes_of(p));
        }
        if !bytes.is_empty() {
            queue.write_buffer(&self.uniform, 0, &bytes);
        }
    }

    /// Limit the next passes to `rect` (`[x, y, w, h]` px, inside the target), or lift the limit.
    pub fn set_scissor(&self, rect: Option<[u32; 4]>) {
        self.scissor.set(rect);
    }

    /// Apply the scissor to a pass drawing into `to` (the half-size blur targets get it halved).
    fn clip(&self, pass: &mut wgpu::RenderPass<'_>, to: &wgpu::TextureView) {
        let Some([x, y, w, h]) = self.scissor.get() else { return };
        if std::ptr::eq(to, &self.temp) || std::ptr::eq(to, &self.copy) {
            let (hw, hh) = ((self.size[0] / 2).max(1), (self.size[1] / 2).max(1));
            let (x0, y0) = ((x / 2).min(hw - 1), (y / 2).min(hh - 1));
            let (x1, y1) = ((x + w).div_ceil(2).min(hw), (y + h).div_ceil(2).min(hh));
            pass.set_scissor_rect(x0, y0, (x1 - x0).max(1), (y1 - y0).max(1));
        } else {
            pass.set_scissor_rect(x, y, w, h);
        }
    }

    /// Clear a target and return a pass on it (for drawing a layer or its matte).
    pub fn clear_pass<'a>(encoder: &'a mut wgpu::CommandEncoder, view: &'a wgpu::TextureView, label: &str) -> wgpu::RenderPass<'a> {
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        })
    }

    /// Blend the layer in `scratch` over the scene in `scene` (the texture behind `target`), with the
    /// blend mode at uniform slot `offset`. Modes that read the backdrop need this two-step path.
    pub fn blend_over(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, scene: &wgpu::Texture, target: &wgpu::TextureView, offset: u32) {
        // Only the part of the backdrop the layer can touch.
        let [x, y, w, h] = self.scissor.get().unwrap_or([0, 0, self.size[0], self.size[1]]);
        let origin = wgpu::Origin3d { x, y, z: 0 };
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: scene, mip_level: 0, origin, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &self.backdrop_texture, mip_level: 0, origin, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        let group = self.bind(device, &self.scratch, &self.backdrop, "fx blend");
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("fx blend"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        self.clip(&mut pass, target);
        pass.set_pipeline(&self.blend_pipeline);
        pass.set_bind_group(0, &group, &[offset]);
        pass.set_bind_group(1, &self.no_lut, &[]);
        pass.draw(0..3, 0..1);
    }

    /// One blur direction: `from` → `to` (cleared).
    pub fn blur(&self, encoder: &mut wgpu::CommandEncoder, from: Tex, to: &wgpu::TextureView, offset: u32) {
        let mut pass = Self::clear_pass(encoder, to, "fx blur");
        self.clip(&mut pass, to);
        pass.set_pipeline(&self.blur_pipeline);
        pass.set_bind_group(0, &self.groups[from as usize], &[offset]);
        pass.set_bind_group(1, &self.no_lut, &[]);
        pass.draw(0..3, 0..1);
    }

    /// Composite `from` onto `target` (loaded, not cleared).
    pub fn composite(&self, encoder: &mut wgpu::CommandEncoder, from: Tex, target: &wgpu::TextureView, blend: BlendMode, offset: u32) {
        self.composite_group(encoder, &self.groups[from as usize], target, blend, offset, None);
    }

    /// Composite `from` graded through `lut` (the layer's color effect LUT).
    pub fn composite_lut(&self, encoder: &mut wgpu::CommandEncoder, from: Tex, target: &wgpu::TextureView, blend: BlendMode, offset: u32, lut: &wgpu::BindGroup) {
        self.composite_group(encoder, &self.groups[from as usize], target, blend, offset, Some(lut));
    }

    /// Composite whatever `group` reads onto `target`.
    pub fn composite_group(&self, encoder: &mut wgpu::CommandEncoder, group: &wgpu::BindGroup, target: &wgpu::TextureView, blend: BlendMode, offset: u32, lut: Option<&wgpu::BindGroup>) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("fx composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        let index = match blend {
            BlendMode::Normal => 0,
            BlendMode::Add => 1,
            BlendMode::Screen => 2,
            BlendMode::Multiply => 3,
            _ => unreachable!("backdrop modes go through blend_over"),
        };
        self.clip(&mut pass, target);
        pass.set_pipeline(&self.composite[index]);
        pass.set_bind_group(0, group, &[offset]);
        pass.set_bind_group(1, lut.unwrap_or(&self.no_lut), &[]);
        pass.draw(0..3, 0..1);
    }
}

pub fn matte_code(m: Option<MatteMode>) -> f32 {
    match m {
        None => 0.0,
        Some(MatteMode::Alpha) => 1.0,
        Some(MatteMode::AlphaInverted) => 2.0,
        Some(MatteMode::Luma) => 3.0,
        Some(MatteMode::LumaInverted) => 4.0,
    }
}

fn make_uniform(device: &wgpu::Device, slots: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("fx params"),
        size: slots * SLOT,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// A texture that receives a copy of the scene (backdrop blends), not a render target.
fn make_copy_target(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("fx backdrop"),
        size: wgpu::Extent3d { width: width.max(1), height: height.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    (texture, view)
}

fn make_texture(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("fx layer"),
            size: wgpu::Extent3d { width: width.max(1), height: height.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&Default::default())
}
