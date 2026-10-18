// Instanced signed-distance shapes: rounded rects and ellipses (radius = half size).

struct Globals {
    scene_size: vec2<f32>,
    // 1.0 when the surface is sRGB and we must linearize our sRGB colors.
    linearize: f32,
    // Seconds into the scene.
    time: f32,
};

@group(0) @binding(0) var<uniform> g: Globals;

struct Instance {
    @location(0) center: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) radius: f32,
    @location(4) rotation: f32,
};

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) local: vec2<f32>,
    @location(1) half: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) radius: f32,
};

const CORNERS = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, inst: Instance) -> VsOut {
    // Pad by 2px so the antialiased edge is not clipped by the quad.
    let half = inst.size * 0.5;
    let local = CORNERS[vi] * (half + vec2(2.0));
    let c = cos(inst.rotation);
    let s = sin(inst.rotation);
    let p = inst.center + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    let ndc = vec2(p.x / g.scene_size.x * 2.0 - 1.0, 1.0 - p.y / g.scene_size.y * 2.0);

    var out: VsOut;
    out.pos = vec4(ndc, 0.0, 1.0);
    out.local = local;
    out.half = half;
    out.color = inst.color;
    out.radius = min(inst.radius, min(half.x, half.y));
    return out;
}

fn sd_round_box(p: vec2<f32>, half: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - half + vec2(r);
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let d = sd_round_box(in.local, in.half, in.radius);
    let aa = max(fwidth(d), 1e-4);
    let coverage = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);
    var rgb = in.color.rgb;
    if (g.linearize > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    let a = in.color.a * coverage;
    return vec4(rgb * a, a);
}
