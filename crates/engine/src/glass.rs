//! Liquid glass pass: draws a glass shape's refracted, blurred backdrop into a target. The scene
//! prepares the inputs: the sharp backdrop, a blurred copy of it, and the shape (see `scene::paint`).

use bytemuck::{Pod, Zeroable};

/// One glass shape's uniforms, all in scene px except the scalars noted.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub struct GlassParams {
    /// xy: center, zw: half size.
    pub shape: [f32; 4],
    /// x: corner radius, y: rotation (rad), z: thickness, w: bevel width.
    pub optics: [f32; 4],
    /// x: index of refraction, y: dispersion, z: specular amount.
    pub look: [f32; 4],
    /// rgb: tint, a: tint amount (0 = no tint).
    pub tint: [f32; 4],
    /// xy: scene size.
    pub scene: [f32; 4],
}

/// Uniform slot stride (WebGPU's minimum dynamic-offset alignment).
const SLOT: u64 = 256;
const INITIAL_SLOTS: u64 = 16;

pub struct GlassPass {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniform: wgpu::Buffer,
    slots: u64,
    params: Vec<GlassParams>,
}

impl GlassPass {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let tex = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass"),
            entries: &[
                tex(0),
                tex(1),
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<GlassParams>() as u64) },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("glass"), bind_group_layouts: &[Some(&layout)], ..Default::default() });
        let shader = device.create_shader_module(wgpu::include_wgsl!("glass.wgsl"));
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("glass"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("glass"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let uniform = make_uniform(device, INITIAL_SLOTS);
        GlassPass { pipeline, layout, sampler, uniform, slots: INITIAL_SLOTS, params: Vec::new() }
    }

    /// Start collecting this frame's glass shapes.
    pub fn begin(&mut self) {
        self.params.clear();
    }

    /// Queue one shape; returns the uniform offset to draw it with.
    pub fn push(&mut self, p: GlassParams) -> u32 {
        self.params.push(p);
        ((self.params.len() - 1) as u64 * SLOT) as u32
    }

    /// Upload the queued shapes (before the frame is submitted).
    pub fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        let needed = self.params.len() as u64;
        if needed > self.slots {
            self.slots = needed.next_power_of_two();
            self.uniform = make_uniform(device, self.slots);
        }
        for (i, p) in self.params.iter().enumerate() {
            queue.write_buffer(&self.uniform, i as u64 * SLOT, bytemuck::bytes_of(p));
        }
    }

    /// Draw the glass at `offset` into `target`: `sharp` is the backdrop, `blurred` its blurred copy.
    pub fn draw(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, sharp: &wgpu::TextureView, blurred: &wgpu::TextureView, target: &wgpu::TextureView, offset: u32) {
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(sharp) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(blurred) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniform, offset: 0, size: wgpu::BufferSize::new(std::mem::size_of::<GlassParams>() as u64) }),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("glass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[offset]);
        pass.draw(0..3, 0..1);
    }
}

fn make_uniform(device: &wgpu::Device, slots: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("glass params"),
        size: slots * SLOT,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}
