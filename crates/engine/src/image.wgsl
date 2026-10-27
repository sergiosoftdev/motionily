// Textured rounded rectangles for image layers (one texture per draw).

struct Globals {
    scene_size: vec2<f32>,
    linearize: f32,
    time: f32,
    // Flat-space origin of the pass: 0 for the scene, the plane origin inside a tilted plane.
    origin: vec2<f32>,
    // To 32 bytes (WebGL2 uniform blocks are multiples of 16).
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var tex_sampler: sampler;

struct Quad {
    @location(0) center: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) uv: vec4<f32>,
    // x: radius, y: rotation, z: opacity
    @location(3) params: vec4<f32>,
};

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) local: vec2<f32>,
    @location(1) half: vec2<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) params: vec4<f32>,
};

const CORNERS = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, q: Quad) -> VsOut {
    let corner = CORNERS[vi];
    let half = q.size * 0.5;
    let local = corner * half;
    let c = cos(q.params.y);
    let s = sin(q.params.y);
    let p = q.center + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    var out: VsOut;
    out.pos = vec4((p.x - g.origin.x) / g.scene_size.x * 2.0 - 1.0, 1.0 - (p.y - g.origin.y) / g.scene_size.y * 2.0, 0.0, 1.0);
    out.local = local;
    out.half = half;
    out.uv = mix(q.uv.xy, q.uv.zw, corner * 0.5 + 0.5);
    out.params = q.params;
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
    let texel = textureSample(tex, tex_sampler, in.uv);
    let d = sd_round_box(in.local, in.half, min(in.params.x, min(in.half.x, in.half.y)));
    let aa = max(fwidth(d), 1e-4);
    let coverage = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);
    var rgb = texel.rgb;
    if (g.linearize > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    let a = texel.a * coverage * in.params.z;
    return vec4(rgb * a, a);
}
