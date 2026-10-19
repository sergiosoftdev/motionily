//! Post-processing: the scene renders into an offscreen texture (transparent
//! background), then one fullscreen pass composites it over the background
//! with the project's render style. Scene pipelines never need to know.

use bytemuck::{Pod, Zeroable};
use scene::{RenderKind, RenderStyle};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PostUniform {
    background: [f32; 4],
    ink: [f32; 4],
    shadow: [f32; 4],
    /// x: texture px per scene px, y: style id, z: amount, w: time.
    params: [f32; 4],
    texel: [f32; 2],
    _pad: [f32; 2],
}

/// Colors the post pass needs, already in the surface's color space.
pub struct PostColors {
    pub background: [f32; 3],
    pub ink: [f32; 3],
    pub shadow: [f32; 3],
}

fn style_id(kind: RenderKind) -> f32 {
    // Must match the STYLE_* constants in post.wgsl.
    match kind {
        RenderKind::Flat => 0.0,
        RenderKind::SoftDepth => 1.0,
        RenderKind::ToonOutline => 2.0,
        RenderKind::CelAnime => 3.0,
        RenderKind::PaperCut => 4.0,
        RenderKind::IsoFlat => 5.0,
    }
}

pub struct PostPass {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniform: wgpu::Buffer,
    format: wgpu::TextureFormat,
    target: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
    size: [u32; 2],
}

impl PostPass {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("post"),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("post"),
            bind_group_layouts: &[Some(&layout)],
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("post.wgsl"));
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("post"),
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
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("post"),
            size: std::mem::size_of::<PostUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let (target, bind_group) = Self::make_target(device, &layout, &sampler, &uniform, format, width, height);
        PostPass { pipeline, layout, sampler, uniform, format, target, bind_group, size: [width, height] }
    }

    fn make_target(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        uniform: &wgpu::Buffer,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> (wgpu::TextureView, wgpu::BindGroup) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("scene"),
            size: wgpu::Extent3d { width: width.max(1), height: height.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("post"),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: uniform.as_entire_binding() },
            ],
        });
        (view, bind_group)
    }

    /// Where scene pipelines draw this frame.
    pub fn target(&self) -> &wgpu::TextureView {
        &self.target
    }

    pub fn resize(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if self.size == [width, height] {
            return;
        }
        let (target, bind_group) = Self::make_target(device, &self.layout, &self.sampler, &self.uniform, self.format, width, height);
        self.target = target;
        self.bind_group = bind_group;
        self.size = [width, height];
    }

    /// Composite the scene texture over the background into `surface`.
    pub fn run(
        &self,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        surface: &wgpu::TextureView,
        style: Option<RenderStyle>,
        colors: &PostColors,
        scene_width: f32,
        time: f32,
    ) {
        let style = style.unwrap_or(RenderStyle { kind: RenderKind::Flat, amount: 1.0 });
        let rgba = |c: [f32; 3]| [c[0], c[1], c[2], 1.0];
        let u = PostUniform {
            background: rgba(colors.background),
            ink: rgba(colors.ink),
            shadow: rgba(colors.shadow),
            params: [self.size[0] as f32 / scene_width, style_id(style.kind), style.amount, time],
            texel: [1.0 / self.size[0] as f32, 1.0 / self.size[1] as f32],
            _pad: [0.0; 2],
        };
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&u));
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("post"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: surface,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}
