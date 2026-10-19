//! Vector paths: strokes as instanced SDF capsules (antialiased, round caps, dashes, color along
//! the path) and fills tessellated with lyon into a triangle mesh (edges antialiased with a thin
//! stroke of the fill color).

use crate::{Ctx, ITEM_CAPACITY};
use bytemuck::{Pod, Zeroable};
use lyon_tessellation::geom::point;
use lyon_tessellation::path::Path as LyonPath;
use lyon_tessellation::{BuffersBuilder, FillOptions, FillRule, FillTessellator, FillVertex, VertexBuffers};
use scene::paint::DrawPath;
use scene::Rgba;
use std::ops::Range;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Seg {
    ends: [f32; 4],
    params: [f32; 4],
    color_a: [f32; 4],
    color_b: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    pos: [f32; 2],
    color: [f32; 4],
}

/// Width of the antialiasing rim drawn around fills.
const FILL_RIM: f32 = 0.9;
const TESSELLATION_TOLERANCE: f32 = 0.35;

/// Where one path's data lives in the frame buffers.
#[derive(Clone)]
struct Span {
    mesh: Range<u32>,
    segs: Range<u32>,
}

pub struct PathPipeline {
    seg_pipeline: wgpu::RenderPipeline,
    mesh_pipeline: wgpu::RenderPipeline,
    segs: wgpu::Buffer,
    seg_capacity: usize,
    mesh: wgpu::Buffer,
    mesh_capacity: usize,
    spans: Vec<Span>,
}

impl PathPipeline {
    pub fn new(ctx: &Ctx) -> Self {
        let shader = ctx.device.create_shader_module(wgpu::include_wgsl!("paths.wgsl"));
        const SEG_ATTRS: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4];
        const MESH_ATTRS: [wgpu::VertexAttribute; 2] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4];
        let make = |label: &str, vs: &str, fs: &str, layout: wgpu::VertexBufferLayout<'_>| {
            ctx.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(ctx.globals_pipeline_layout),
                vertex: wgpu::VertexState { module: &shader, entry_point: Some(vs), compilation_options: Default::default(), buffers: &[Some(layout)] },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(ctx.color_target())],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let seg_pipeline = make(
            "path strokes",
            "vs_seg",
            "fs_seg",
            wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Seg>() as u64, step_mode: wgpu::VertexStepMode::Instance, attributes: &SEG_ATTRS },
        );
        let mesh_pipeline = make(
            "path fills",
            "vs_mesh",
            "fs_mesh",
            wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &MESH_ATTRS },
        );
        PathPipeline {
            seg_pipeline,
            mesh_pipeline,
            segs: buffer(ctx.device, ITEM_CAPACITY * std::mem::size_of::<Seg>(), "path segments"),
            seg_capacity: ITEM_CAPACITY,
            mesh: buffer(ctx.device, ITEM_CAPACITY * 3 * std::mem::size_of::<Vertex>(), "path mesh"),
            mesh_capacity: ITEM_CAPACITY * 3,
            spans: Vec::new(),
        }
    }

    pub fn prepare(&mut self, ctx: &Ctx, paths: &[DrawPath]) {
        let mut segs: Vec<Seg> = Vec::new();
        let mut verts: Vec<Vertex> = Vec::new();
        self.spans.clear();
        for p in paths {
            let (m0, s0) = (verts.len() as u32, segs.len() as u32);
            let (lo, hi) = p.bounds;
            let size = [(hi[0] - lo[0]).max(1e-3), (hi[1] - lo[1]).max(1e-3)];
            let paint = |q: [f32; 2], flat: Rgba| -> [f32; 4] {
                p.gradient.as_ref().map_or(flat.0, |g| g.color_at([(q[0] - lo[0]) / size[0], (q[1] - lo[1]) / size[1]]).0)
            };
            if let Some(fill) = p.fill.filter(|_| !p.fills.is_empty()) {
                tessellate(&p.fills, &mut verts, |q| paint(q, fill));
                for poly in &p.fills {
                    push_polyline(&mut segs, poly, FILL_RIM / 2.0, None, &|q| paint(q, fill));
                }
            }
            if let Some((width, color)) = p.stroke.filter(|(w, _)| *w > 0.0) {
                for line in &p.lines {
                    push_polyline(&mut segs, line, width / 2.0, p.dash, &|q| paint(q, color));
                }
            }
            self.spans.push(Span { mesh: m0..verts.len() as u32, segs: s0..segs.len() as u32 });
        }
        if segs.len() > self.seg_capacity {
            self.seg_capacity = segs.len().next_power_of_two();
            self.segs = buffer(ctx.device, self.seg_capacity * std::mem::size_of::<Seg>(), "path segments");
        }
        if verts.len() > self.mesh_capacity {
            self.mesh_capacity = verts.len().next_power_of_two();
            self.mesh = buffer(ctx.device, self.mesh_capacity * std::mem::size_of::<Vertex>(), "path mesh");
        }
        if !segs.is_empty() {
            ctx.queue.write_buffer(&self.segs, 0, bytemuck::cast_slice(&segs));
        }
        if !verts.is_empty() {
            ctx.queue.write_buffer(&self.mesh, 0, bytemuck::cast_slice(&verts));
        }
    }

    /// Draw paths `range` in order: each one's fill, then its stroke.
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, range: Range<u32>) {
        for span in &self.spans[range.start as usize..range.end as usize] {
            if !span.mesh.is_empty() {
                pass.set_pipeline(&self.mesh_pipeline);
                pass.set_vertex_buffer(0, self.mesh.slice(..));
                pass.draw(span.mesh.clone(), 0..1);
            }
            if !span.segs.is_empty() {
                pass.set_pipeline(&self.seg_pipeline);
                pass.set_vertex_buffer(0, self.segs.slice(..));
                pass.draw(0..6, span.segs.clone());
            }
        }
    }
}

fn push_polyline(out: &mut Vec<Seg>, line: &[[f32; 2]], half: f32, dash: Option<[f32; 2]>, paint: &dyn Fn([f32; 2]) -> [f32; 4]) {
    let [on, off] = dash.unwrap_or([0.0, 0.0]);
    let mut along = 0.0;
    for w in line.windows(2) {
        let len = ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt();
        if len < 1e-4 {
            continue;
        }
        out.push(Seg { ends: [w[0][0], w[0][1], w[1][0], w[1][1]], params: [half, on, off, along], color_a: paint(w[0]), color_b: paint(w[1]) });
        along += len;
    }
}

fn tessellate(polys: &[Vec<[f32; 2]>], out: &mut Vec<Vertex>, paint: impl Fn([f32; 2]) -> [f32; 4]) {
    let mut builder = LyonPath::builder();
    for poly in polys.iter().filter(|p| p.len() > 2) {
        builder.begin(point(poly[0][0], poly[0][1]));
        for q in &poly[1..] {
            builder.line_to(point(q[0], q[1]));
        }
        builder.end(true);
    }
    let path = builder.build();
    let mut geom: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
    let ok = FillTessellator::new().tessellate_path(
        &path,
        &FillOptions::tolerance(TESSELLATION_TOLERANCE).with_fill_rule(FillRule::EvenOdd),
        &mut BuffersBuilder::new(&mut geom, |v: FillVertex| v.position().to_array()),
    );
    if ok.is_err() {
        return;
    }
    for i in geom.indices {
        let q = geom.vertices[i as usize];
        out.push(Vertex { pos: q, color: paint(q) });
    }
}

fn buffer(device: &wgpu::Device, bytes: usize, label: &str) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: &vec![0u8; bytes.max(64)],
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
    })
}
