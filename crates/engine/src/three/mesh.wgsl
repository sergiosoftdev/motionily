// Toon-shaded glTF meshes with GPU skinning, plus an inverted-hull outline pass.

struct Frame {
    view_proj: mat4x4<f32>,
    light_dir: vec4<f32>,
    ink: vec4<f32>,
    // x: linearize colors (sRGB surface), y: outline width in world units.
    params: vec4<f32>,
};

const MAX_JOINTS: u32 = 16u;

struct Draw {
    model: mat4x4<f32>,
    tint: vec4<f32>,
    // x: skinned, y: textured, z: draw outline, w: unlit (floor).
    flags: vec4<f32>,
    joints: array<mat4x4<f32>, 16>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(2) @binding(0) var tex: texture_2d<f32>;
@group(2) @binding(1) var tex_sampler: sampler;

struct VIn {
    @location(0) pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) joints: vec4<f32>,
    @location(4) weights: vec4<f32>,
};

struct VOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) world: vec3<f32>,
};

fn skin_matrix(v: VIn) -> mat4x4<f32> {
    if (draw.flags.x < 0.5) {
        return mat4x4<f32>(vec4(1.0, 0.0, 0.0, 0.0), vec4(0.0, 1.0, 0.0, 0.0), vec4(0.0, 0.0, 1.0, 0.0), vec4(0.0, 0.0, 0.0, 1.0));
    }
    let j = vec4<u32>(v.joints + vec4(0.5)) % vec4(MAX_JOINTS);
    return draw.joints[j.x] * v.weights.x + draw.joints[j.y] * v.weights.y + draw.joints[j.z] * v.weights.z + draw.joints[j.w] * v.weights.w;
}

fn world_of(v: VIn) -> mat4x4<f32> {
    return draw.model * skin_matrix(v);
}

@vertex
fn vs(v: VIn) -> VOut {
    let m = world_of(v);
    let world = m * vec4(v.pos, 1.0);
    var out: VOut;
    out.clip = frame.view_proj * world;
    out.normal = normalize((m * vec4(v.normal, 0.0)).xyz);
    out.uv = v.uv;
    out.world = world.xyz;
    return out;
}

/// Outline: the back faces, pushed out along the normal, in ink.
@vertex
fn vs_outline(v: VIn) -> VOut {
    let m = world_of(v);
    let n = normalize((m * vec4(v.normal, 0.0)).xyz);
    let world = m * vec4(v.pos, 1.0) + vec4(n * frame.params.y * draw.flags.z, 0.0);
    var out: VOut;
    out.clip = frame.view_proj * world;
    out.normal = n;
    out.uv = v.uv;
    out.world = world.xyz;
    return out;
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
    var base = draw.tint;
    if (draw.flags.y > 0.5) {
        base = base * textureSample(tex, tex_sampler, in.uv);
    }
    var rgb = base.rgb;
    if (draw.flags.w < 0.5) {
        // Toon: two light bands, a cool ambient and a soft rim.
        let l = max(dot(normalize(in.normal), normalize(frame.light_dir.xyz)), 0.0);
        let band = mix(0.68, 1.0, smoothstep(0.38, 0.45, l));
        let up = in.normal.y * 0.5 + 0.5;
        rgb = rgb * band * mix(0.92, 1.04, up);
    }
    if (frame.params.x > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    return vec4(rgb, 1.0);
}

@fragment
fn fs_outline(in: VOut) -> @location(0) vec4<f32> {
    var rgb = frame.ink.rgb;
    if (frame.params.x > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    return vec4(rgb, 1.0);
}
