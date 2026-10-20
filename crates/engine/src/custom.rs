//! Custom shaders written by the agent (`scene::shader`): shader layers drawn as boxes in the
//! scene pass, and shader effects run on a layer's offscreen image (`fx.layer` → `fx.accum`).
//!
//! One pipeline per (stage, code hash), compiled when the scene first lists the code (before the
//! frame that shows it, so exports never miss a frame). Code is re-checked with naga first: a
//! scene saved with broken code draws nothing for that shader instead of failing the frame. All
//! items of a frame share one uniform buffer with dynamic offsets.

use crate::fx::FxPass;
use crate::Ctx;
use bytemuck::{Pod, Zeroable};
use scene::shader::{DrawShader, ShaderCode, ShaderStage, MAX_PARAMS};
use scene::{Palette, Scene};
use std::collections::HashMap;
use std::future::Future;
use std::ops::Range;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

/// `MlyUniform` in `scene/src/shader/common.wgsl` (same field order).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
struct Uniform {
    rect: [f32; 4],
    misc: [f32; 4],
    clock: [f32; 4],
    area: [f32; 4],
    tint: [f32; 4],
    p: [[f32; 4]; 2],
    pal: [[f32; 4]; 5],
}

/// Uniform slot stride (WebGPU's minimum dynamic-offset alignment).
const SLOT: u64 = 256;
const INITIAL_SLOTS: u64 = 16;
/// Pipelines kept before stale ones are dropped (an agent iterating on code leaves many behind).
const MAX_PIPELINES: usize = 64;
/// Frames a pipeline may go unused before it counts as stale.
const STALE_FRAMES: u64 = 600;

/// The GPU's verdict on a new pipeline (WebGPU validates asynchronously; wgpu-core at once).
type Verdict = Pin<Box<dyn Future<Output = Option<wgpu::Error>>>>;

enum Compiled {
    Ready(wgpu::RenderPipeline),
    /// Drawn while the verdict is on its way: a WebGPU validation error only drops a frame.
    Pending(wgpu::RenderPipeline, Verdict),
    Failed(String),
}

struct Entry {
    compiled: Compiled,
    last_used: u64,
}

/// Per-frame inputs every custom shader receives.
pub struct FrameInfo {
    palette: [[f32; 4]; 5],
    linearize: f32,
    scene_size: [f32; 2],
}

impl FrameInfo {
    pub fn new(palette: &Palette, linearize: bool, scene_size: [f32; 2]) -> Self {
        let pal = [palette.background, palette.surface, palette.primary, palette.accent, palette.text].map(|c| c.0);
        FrameInfo { palette: pal, linearize: if linearize { 1.0 } else { 0.0 }, scene_size }
    }
}

fn params(p: &[f32; MAX_PARAMS]) -> [[f32; 4]; 2] {
    [[p[0], p[1], p[2], p[3]], [p[4], p[5], p[6], p[7]]]
}

pub struct CustomShaders {
    format: wgpu::TextureFormat,
    layer_layout: wgpu::BindGroupLayout,
    layer_pipeline_layout: wgpu::PipelineLayout,
    effect_layout: wgpu::BindGroupLayout,
    effect_pipeline_layout: wgpu::PipelineLayout,
    sampler: wgpu::Sampler,
    pipelines: HashMap<(ShaderStage, u64), Entry>,
    uniform: wgpu::Buffer,
    slots: u64,
    layer_group: wgpu::BindGroup,
    params: Vec<Uniform>,
    /// Shader layer items this frame: code hash and uniform offset.
    items: Vec<(u64, u32)>,
    frame: u64,
}

impl CustomShaders {
    pub fn new(ctx: &Ctx) -> Self {
        let device = ctx.device;
        let uniform_entry = |binding: u32, visibility: wgpu::ShaderStages| wgpu::BindGroupLayoutEntry {
            binding,
            visibility,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: true,
                min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<Uniform>() as u64),
            },
            count: None,
        };
        let layer_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("custom shader layer"),
            entries: &[uniform_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT)],
        });
        let effect_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("custom shader effect"),
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
                uniform_entry(2, wgpu::ShaderStages::VERTEX_FRAGMENT),
            ],
        });
        let layer_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("custom shader layer"),
            bind_group_layouts: &[Some(ctx.globals_layout), Some(&layer_layout)],
            ..Default::default()
        });
        let effect_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("custom shader effect"),
            bind_group_layouts: &[Some(&effect_layout)],
            ..Default::default()
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let uniform = make_uniform(device, INITIAL_SLOTS);
        let layer_group = make_layer_group(device, &layer_layout, &uniform);
        CustomShaders {
            format: ctx.format,
            layer_layout,
            layer_pipeline_layout,
            effect_layout,
            effect_pipeline_layout,
            sampler,
            pipelines: HashMap::new(),
            uniform,
            slots: INITIAL_SLOTS,
            layer_group,
            params: Vec::new(),
            items: Vec::new(),
            frame: 0,
        }
    }

    /// Compile every shader the scene lists that is new, collect GPU verdicts, drop stale
    /// pipelines; then start collecting this frame's uniforms.
    pub fn begin(&mut self, device: &wgpu::Device, scene: &Scene) {
        self.frame += 1;
        self.params.clear();
        self.items.clear();
        for (stage, code) in scene.shader_codes() {
            let key = (stage, code.hash());
            if let Some(e) = self.pipelines.get_mut(&key) {
                e.last_used = self.frame;
                continue;
            }
            let compiled = self.compile(device, stage, code);
            self.pipelines.insert(key, Entry { compiled, last_used: self.frame });
        }
        for e in self.pipelines.values_mut() {
            if let Compiled::Pending(_, verdict) = &mut e.compiled {
                let Poll::Ready(error) = verdict.as_mut().poll(&mut Context::from_waker(Waker::noop())) else { continue };
                e.compiled = match (std::mem::replace(&mut e.compiled, Compiled::Failed(String::new())), error) {
                    (_, Some(err)) => Compiled::Failed(err.to_string()),
                    (Compiled::Pending(p, _), None) => Compiled::Ready(p),
                    (other, None) => other,
                };
            }
        }
        if self.pipelines.len() > MAX_PIPELINES {
            let frame = self.frame;
            self.pipelines.retain(|_, e| frame - e.last_used < STALE_FRAMES);
        }
    }

    fn compile(&self, device: &wgpu::Device, stage: ShaderStage, code: &ShaderCode) -> Compiled {
        if let Err(e) = scene::shader::check(stage, code) {
            return Compiled::Failed(e.to_string());
        }
        let (layout, blend) = match stage {
            ShaderStage::Layer => (&self.layer_pipeline_layout, Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING)),
            // The effect's output replaces the layer image.
            ShaderStage::Effect => (&self.effect_pipeline_layout, None),
        };
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("custom shader"),
            source: wgpu::ShaderSource::Wgsl(scene::shader::module_source(stage, code.as_str()).into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("custom shader"),
            layout: Some(layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("mly_vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("mly_fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: self.format, blend, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let mut verdict: Verdict = Box::pin(scope.pop());
        match verdict.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(Some(err)) => Compiled::Failed(err.to_string()),
            Poll::Ready(None) => Compiled::Ready(pipeline),
            Poll::Pending => Compiled::Pending(pipeline, verdict),
        }
    }

    fn pipeline(&self, stage: ShaderStage, hash: u64) -> Option<&wgpu::RenderPipeline> {
        match &self.pipelines.get(&(stage, hash))?.compiled {
            Compiled::Ready(p) | Compiled::Pending(p, _) => Some(p),
            Compiled::Failed(_) => None,
        }
    }

    fn push(&mut self, u: Uniform) -> u32 {
        self.params.push(u);
        ((self.params.len() - 1) as u64 * SLOT) as u32
    }

    /// Uniforms of this frame's shader layers (in `Batches::shaders` order).
    pub fn prepare_layers(&mut self, items: &[DrawShader], info: &FrameInfo) {
        for s in items {
            let zoom = if s.box_size[0].abs() > 1e-4 { s.size[0] / s.box_size[0] } else { 1.0 };
            let offset = self.push(Uniform {
                rect: [s.center[0], s.center[1], s.size[0], s.size[1]],
                misc: [s.rotation, s.opacity, s.radius, info.linearize],
                clock: [s.time, s.scene_time, zoom, 0.0],
                area: [s.box_size[0], s.box_size[1], 0.0, 0.0],
                tint: s.fill.0,
                p: params(&s.params),
                pal: info.palette,
            });
            self.items.push((s.code.hash(), offset));
        }
    }

    /// Uniform slot for one shader effect pass (uv spans the whole frame).
    pub fn push_effect(&mut self, params_: &[f32; MAX_PARAMS], time: f32, scene_time: f32, zoom: f32, info: &FrameInfo) -> u32 {
        self.push(Uniform {
            misc: [0.0, 1.0, 0.0, info.linearize],
            clock: [time, scene_time, zoom, 0.0],
            area: [info.scene_size[0], info.scene_size[1], 0.0, 0.0],
            tint: [1.0; 4],
            p: params(params_),
            pal: info.palette,
            ..Default::default()
        })
    }

    /// Write every slot (after all pushes, before submitting).
    pub fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        let needed = self.params.len() as u64;
        if needed > self.slots {
            self.slots = needed.next_power_of_two();
            self.uniform = make_uniform(device, self.slots);
            self.layer_group = make_layer_group(device, &self.layer_layout, &self.uniform);
        }
        if needed == 0 {
            return;
        }
        let mut bytes = vec![0u8; (needed * SLOT) as usize];
        for (i, u) in self.params.iter().enumerate() {
            let o = i * SLOT as usize;
            bytes[o..o + std::mem::size_of::<Uniform>()].copy_from_slice(bytemuck::bytes_of(u));
        }
        queue.write_buffer(&self.uniform, 0, &bytes);
    }

    /// Draw shader layer items `range` (group 0 = globals is already bound by the scene pass).
    pub fn draw_layers(&self, pass: &mut wgpu::RenderPass<'_>, range: Range<u32>) {
        for i in range {
            let Some(&(hash, offset)) = self.items.get(i as usize) else { continue };
            let Some(pipeline) = self.pipeline(ShaderStage::Layer, hash) else { continue };
            pass.set_pipeline(pipeline);
            pass.set_bind_group(1, &self.layer_group, &[offset]);
            pass.draw(0..6, 0..1);
        }
    }

    /// Run a shader effect: read `src` (a layer image), write `dst` (cleared). False when the
    /// shader is not usable (the layer then stays as it was).
    pub fn run_effect(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, hash: u64, offset: u32, src: &wgpu::TextureView, dst: &wgpu::TextureView) -> bool {
        let Some(pipeline) = self.pipeline(ShaderStage::Effect, hash) else { return false };
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("custom shader effect"),
            layout: &self.effect_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.uniform,
                        offset: 0,
                        size: wgpu::BufferSize::new(std::mem::size_of::<Uniform>() as u64),
                    }),
                },
            ],
        });
        let mut pass = FxPass::clear_pass(encoder, dst, "custom shader effect");
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[offset]);
        pass.draw(0..3, 0..1);
        true
    }

    /// Shaders of `scene` the GPU refused (layer id, reason): naga accepted them but the browser's
    /// compiler did not. Empty in practice; review checks report it.
    pub fn failures(&self, scene: &Scene) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for l in &scene.layers {
            for (stage, code) in scene::shader::layer_codes(l) {
                if let Some(Entry { compiled: Compiled::Failed(why), .. }) = self.pipelines.get(&(stage, code.hash())) {
                    out.push((l.id.clone(), why.clone()));
                }
            }
        }
        out
    }
}

fn make_uniform(device: &wgpu::Device, slots: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("custom shader params"),
        size: slots * SLOT,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn make_layer_group(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, uniform: &wgpu::Buffer) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("custom shader layer"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: uniform, offset: 0, size: wgpu::BufferSize::new(std::mem::size_of::<Uniform>() as u64) }),
        }],
    })
}
