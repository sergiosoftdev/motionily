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
}

/// Uniform slot stride (WebGPU's minimum dynamic-offset alignment).
const SLOT: u64 = 256;
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
    /// Bind groups reading layer / temp / copy / accum (each with the matte).
    groups: Vec<wgpu::BindGroup>,
    size: [u32; 2],
    params: Vec<FxParams>,
}

fn blend_state(mode: BlendMode) -> wgpu::BlendState {
    use wgpu::{BlendComponent, BlendFactor as F, BlendOperation::Add};
    let alpha = BlendComponent { src_factor: F::One, dst_factor: F::OneMinusSrcAlpha, operation: Add };
    let color = match mode {
        BlendMode::Normal => BlendComponent { src_factor: F::One, dst_factor: F::OneMinusSrcAlpha, operation: Add },
        BlendMode::Add => BlendComponent { src_factor: F::One, dst_factor: F::One, operation: Add },
        BlendMode::Screen => BlendComponent { src_factor: F::One, dst_factor: F::OneMinusSrc, operation: Add },
        BlendMode::Multiply => BlendComponent { src_factor: F::Dst, dst_factor: F::OneMinusSrcAlpha, operation: Add },
    };
    let alpha = if mode == BlendMode::Add { BlendComponent { src_factor: F::One, dst_factor: F::One, operation: Add } } else { alpha };
    wgpu::BlendState { color, alpha }
}

impl FxPass {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32) -> Self {
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
            bind_group_layouts: &[Some(&layout)],
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
            groups: Vec::new(),
            size: [width, height],
            params: Vec::new(),
        };
        fx.rebind(device);
        fx
    }

    fn rebind(&mut self, device: &wgpu::Device) {
        self.groups = [&self.layer, &self.temp, &self.copy, &self.accum].iter().map(|src| self.group_for(device, src)).collect();
    }

    /// A bind group reading `src` (e.g. the scene so far, for adjustment layers).
    pub fn group_for(&self, device: &wgpu::Device, src: &wgpu::TextureView) -> wgpu::BindGroup {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("fx"),
                    layout: &self.layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.matte) },
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

    pub fn resize(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if self.size == [width, height] {
            return;
        }
        self.size = [width, height];
        self.layer = make_texture(device, self.format, width, height);
        self.matte = make_texture(device, self.format, width, height);
        self.accum = make_texture(device, self.format, width, height);
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

    /// One blur direction: `from` → `to` (cleared).
    pub fn blur(&self, encoder: &mut wgpu::CommandEncoder, from: Tex, to: &wgpu::TextureView, offset: u32) {
        let mut pass = Self::clear_pass(encoder, to, "fx blur");
        pass.set_pipeline(&self.blur_pipeline);
        pass.set_bind_group(0, &self.groups[from as usize], &[offset]);
        pass.draw(0..3, 0..1);
    }

    /// Composite `from` onto `target` (loaded, not cleared).
    pub fn composite(&self, encoder: &mut wgpu::CommandEncoder, from: Tex, target: &wgpu::TextureView, blend: BlendMode, offset: u32) {
        self.composite_group(encoder, &self.groups[from as usize], target, blend, offset);
    }

    /// Composite whatever `group` reads onto `target`.
    pub fn composite_group(&self, encoder: &mut wgpu::CommandEncoder, group: &wgpu::BindGroup, target: &wgpu::TextureView, blend: BlendMode, offset: u32) {
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
        };
        pass.set_pipeline(&self.composite[index]);
        pass.set_bind_group(0, group, &[offset]);
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
