// Filled convex quads (iso faces, perspective floors), antialiased by the post pass's sampling.

struct Globals {
    scene_size: vec2<f32>,
    linearize: f32,
    time: f32,
};

@group(0) @binding(0) var<uniform> g: Globals;

struct Poly {
    @location(0) p01: vec4<f32>,
    @location(1) p23: vec4<f32>,
    @location(2) color: vec4<f32>,
};

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
};

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, q: Poly) -> VsOut {
    // Two triangles: 0-1-2 and 0-2-3.
    let corners = array<vec2<f32>, 4>(q.p01.xy, q.p01.zw, q.p23.xy, q.p23.zw);
    let order = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
    let p = corners[order[vi]];
    var rgb = q.color.rgb;
    if (g.linearize > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    var out: VsOut;
    out.pos = vec4(p.x / g.scene_size.x * 2.0 - 1.0, 1.0 - p.y / g.scene_size.y * 2.0, 0.0, 1.0);
    out.color = vec4(rgb * q.color.a, q.color.a);
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    return in.color;
}
