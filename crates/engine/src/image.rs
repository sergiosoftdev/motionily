//! Image layers: one GPU texture per source, drawn as fitted rounded quads.

use crate::Ctx;
use bytemuck::{Pod, Zeroable};
use scene::{DrawImage, ImageFit};
use std::collections::HashMap;
use std::ops::Range;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Quad {
    center: [f32; 2],
    size: [f32; 2],
    uv: [f32; 4],
    params: [f32; 4],
}

struct Texture {
    group: wgpu::BindGroup,
    size: [u32; 2],
}

pub struct ImagePipeline {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    textures: HashMap<String, Texture>,
    quads: wgpu::Buffer,
    capacity: usize,
    /// Source of each image item this frame (None when not loaded yet).
    items: Vec<Option<String>>,
}

impl ImagePipeline {
    pub fn new(ctx: &Ctx) -> Self {
        let device = ctx.device;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("image"),
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
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("image"),
            bind_group_layouts: &[Some(ctx.globals_layout), Some(&layout)],
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("image.wgsl"));
        const ATTRS: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32x4];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("image"),
            layout: Some(&pipeline_layout),
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
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        ImagePipeline { pipeline, layout, sampler, textures: HashMap::new(), quads: make_buffer(device, 16), capacity: 16, items: Vec::new() }
    }

    pub fn add_image(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, key: &str, rgba: &[u8], width: u32, height: u32) {
        let texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("image"),
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
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("image"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&texture.create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        self.textures.insert(key.to_owned(), Texture { group, size: [width, height] });
    }

    pub fn has_image(&self, key: &str) -> bool {
        self.textures.contains_key(key)
    }

    pub fn prepare(&mut self, ctx: &Ctx, images: &[DrawImage]) {
        self.items.clear();
        let mut quads = Vec::with_capacity(images.len());
        for img in images {
            let Some(tex) = self.textures.get(&img.src) else {
                self.items.push(None);
                quads.push(Quad::zeroed());
                continue;
            };
            let (iw, ih) = (tex.size[0] as f32, tex.size[1] as f32);
            let (bw, bh) = (img.size[0].max(1.0), img.size[1].max(1.0));
            let (mut size, mut uv) = (img.size, [0.0, 0.0, 1.0, 1.0]);
            match img.fit {
                ImageFit::Cover => {
                    // Crop the image to the box aspect, centered.
                    let (sx, sy) = if iw / ih > bw / bh { ((bw / bh) / (iw / ih), 1.0) } else { (1.0, (iw / ih) / (bw / bh)) };
                    uv = [(1.0 - sx) / 2.0, (1.0 - sy) / 2.0, (1.0 + sx) / 2.0, (1.0 + sy) / 2.0];
                }
                ImageFit::Contain => {
                    let k = (bw / iw).min(bh / ih);
                    size = [iw * k, ih * k];
                }
            }
            self.items.push(Some(img.src.clone()));
            quads.push(Quad { center: img.center, size, uv, params: [img.radius, img.rotation, img.opacity, 0.0] });
        }
        if quads.len() > self.capacity {
            self.capacity = quads.len().next_power_of_two();
            self.quads = make_buffer(ctx.device, self.capacity);
        }
        if !quads.is_empty() {
            ctx.queue.write_buffer(&self.quads, 0, bytemuck::cast_slice(&quads));
        }
    }

    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, range: Range<u32>) {
        pass.set_pipeline(&self.pipeline);
        pass.set_vertex_buffer(0, self.quads.slice(..));
        for i in range {
            let Some(Some(src)) = self.items.get(i as usize) else { continue };
            let Some(tex) = self.textures.get(src) else { continue };
            pass.set_bind_group(1, &tex.group, &[]);
            pass.draw(0..6, i..i + 1);
        }
    }
}

fn make_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("image quads"),
        contents: &vec![0u8; capacity * std::mem::size_of::<Quad>()],
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
    })
}
