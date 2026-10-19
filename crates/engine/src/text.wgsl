// Textured quads from the glyph atlas (coverage in the red channel).

struct Globals {
    scene_size: vec2<f32>,
    linearize: f32,
    time: f32,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(1) @binding(0) var atlas: texture_2d<f32>;
@group(1) @binding(1) var atlas_sampler: sampler;

struct Quad {
    @location(0) pos: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) uv: vec4<f32>,
    @location(3) color: vec4<f32>,
    @location(4) pivot: vec2<f32>,
    @location(5) rotation: f32,
};

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

const CORNERS = array<vec2<f32>, 6>(
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, q: Quad) -> VsOut {
    let corner = CORNERS[vi];
    let local = q.pos + corner * q.size - q.pivot;
    let c = cos(q.rotation);
    let s = sin(q.rotation);
    let p = q.pivot + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    var out: VsOut;
    out.pos = vec4(p.x / g.scene_size.x * 2.0 - 1.0, 1.0 - p.y / g.scene_size.y * 2.0, 0.0, 1.0);
    out.uv = mix(q.uv.xy, q.uv.zw, corner);
    out.color = q.color;
    return out;
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let coverage = textureSample(atlas, atlas_sampler, in.uv).r;
    var rgb = in.color.rgb;
    if (g.linearize > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    let a = in.color.a * coverage;
    return vec4(rgb * a, a);
}
