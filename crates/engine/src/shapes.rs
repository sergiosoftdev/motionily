//! Instanced SDF shapes (rounded rects, ellipses) with gradients, outlines and soft edges.

use crate::{Ctx, ITEM_CAPACITY};
use bytemuck::{Pod, Zeroable};
use scene::DrawShape;
use std::ops::Range;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Instance {
    rect: [f32; 4],
    color: [f32; 4],
    params: [f32; 4],
    stroke_color: [f32; 4],
    grad: [f32; 4],
    grad_center: [f32; 2],
    stop_pos: [f32; 4],
    stops: [[f32; 4]; 4],
}

/// Gradient fields shared by every instanced pipeline that supports gradients.
pub(crate) fn gradient_fields(g: Option<&scene::paint::DrawGradient>) -> ([f32; 4], [f32; 2], [f32; 4], [[f32; 4]; 4]) {
    let Some(g) = g else { return ([0.0; 4], [0.5, 0.5], [0.0; 4], [[0.0; 4]; 4]) };
    let kind = match g.kind {
        scene::paint::GradientKind::Linear => 1.0,
        scene::paint::GradientKind::Radial => 2.0,
    };
    let mut pos = [1.0; 4];
    let mut cols = [[0.0; 4]; 4];
    for i in 0..g.count {
        pos[i] = g.stops[i].0;
        cols[i] = g.stops[i].1 .0;
    }
    ([kind, g.count as f32, g.angle, g.radius], g.center, pos, cols)
}

impl From<&DrawShape> for Instance {
    fn from(s: &DrawShape) -> Self {
        let (grad, grad_center, stop_pos, stops) = gradient_fields(s.style.gradient.as_ref());
        let (sw, sc) = s.style.stroke.map_or((0.0, [0.0; 4]), |(w, c)| (w.max(0.0), c.0));
        Instance {
            rect: [s.center[0], s.center[1], s.size[0], s.size[1]],
            color: s.color.0,
            params: [s.radius, s.rotation, s.style.soft, sw],
            stroke_color: sc,
            grad,
            grad_center,
            stop_pos,
            stops,
        }
    }
}

pub struct ShapePipeline {
    pipeline: wgpu::RenderPipeline,
    instances: wgpu::Buffer,
    capacity: usize,
}

impl ShapePipeline {
    pub fn new(ctx: &Ctx) -> Self {
        let shader = ctx.device.create_shader_module(wgpu::include_wgsl!("shapes.wgsl"));
        const ATTRS: [wgpu::VertexAttribute; 11] = wgpu::vertex_attr_array![
            0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4, 4 => Float32x4, 5 => Float32x2,
            6 => Float32x4, 7 => Float32x4, 8 => Float32x4, 9 => Float32x4, 10 => Float32x4
        ];
        let pipeline = ctx.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("shapes"),
            layout: Some(ctx.globals_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Instance>() as u64,
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
        ShapePipeline { pipeline, instances: make_buffer(ctx.device, ITEM_CAPACITY), capacity: ITEM_CAPACITY }
    }

    /// Upload every shape of the frame once; runs then draw sub-ranges.
    pub fn prepare(&mut self, ctx: &Ctx, shapes: &[DrawShape]) {
        if shapes.len() > self.capacity {
            self.capacity = shapes.len().next_power_of_two();
            self.instances = make_buffer(ctx.device, self.capacity);
        }
        if !shapes.is_empty() {
            let data: Vec<Instance> = shapes.iter().map(Instance::from).collect();
            ctx.queue.write_buffer(&self.instances, 0, bytemuck::cast_slice(&data));
        }
    }

    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, range: Range<u32>) {
        pass.set_pipeline(&self.pipeline);
        pass.set_vertex_buffer(0, self.instances.slice(..));
        pass.draw(0..6, range);
    }
}

fn make_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("shape instances"),
        contents: &vec![0u8; capacity * std::mem::size_of::<Instance>()],
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
    })
}
