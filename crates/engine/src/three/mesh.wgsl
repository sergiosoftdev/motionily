// Toon-shaded glTF meshes with GPU skinning, plus an inverted-hull outline pass, real lights
// (key + sky/ground ambient + point lights) and a key-light shadow map (`vs_shadow`).
// Every finish reduces to its original look with the default lights (key and ambient white at
// intensity 1, no points, no shadows): `three/lights.rs` fills them that way when a stage or
// object layer has no `lights`.

const MAX_POINTS: i32 = 4;

struct Frame {
    view_proj: mat4x4<f32>,
    // World -> key-light shadow clip space.
    light_vp: mat4x4<f32>,
    // xyz: unit vector toward the key light, w: chrome soft-box x.
    light_dir: vec4<f32>,
    // rgb: key color × intensity.
    key: vec4<f32>,
    // rgb: ambient sky × intensity, w: point light count.
    sky: vec4<f32>,
    // rgb: ambient ground × intensity.
    ground: vec4<f32>,
    // x: shadows on, y: PCF tap spacing (shadow-map uv), z: depth bias, w: normal offset (world).
    shadow: vec4<f32>,
    ink: vec4<f32>,
    // x: linearize colors (sRGB surface), y: outline width in world units, z: finish
    // (0 toon, 1 glossy, 2 glass, 3 chrome, 4 matte).
    params: vec4<f32>,
    eye: vec4<f32>,
    // xyz: position, w: range.
    point_pos: array<vec4<f32>, 4>,
    // rgb: color × intensity.
    point_color: array<vec4<f32>, 4>,
};

const MAX_JOINTS: u32 = 16u;

struct Draw {
    model: mat4x4<f32>,
    tint: vec4<f32>,
    // x: skinned, y: textured, z: draw outline, w: floor.
    flags: vec4<f32>,
    joints: array<mat4x4<f32>, 16>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
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

/// Depth from the key light, for the shadow map.
@vertex
fn vs_shadow(v: VIn) -> @builtin(position) vec4<f32> {
    return frame.light_vp * (world_of(v) * vec4(v.pos, 1.0));
}

@fragment
fn fs_shadow() {}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

/// 0 (in the key light's shadow) .. 1 (lit): 4×4 hardware-filtered comparisons on a grid
/// turned per pixel (noise instead of banding when the edge is soft).
fn key_visibility(world: vec3<f32>, n: vec3<f32>, frag: vec2<f32>) -> f32 {
    if (frame.shadow.x < 0.5) {
        return 1.0;
    }
    let p = frame.light_vp * vec4(world + n * frame.shadow.w, 1.0);
    let uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
    let depth = p.z - frame.shadow.z;
    let turn = 6.2831853 * fract(52.9829189 * fract(dot(frag, vec2(0.06711056, 0.00583715))));
    let rot = mat2x2<f32>(cos(turn), sin(turn), -sin(turn), cos(turn));
    var sum = 0.0;
    for (var i = 0; i < 16; i++) {
        let o = rot * (vec2(f32(i % 4) - 1.5, f32(i / 4) - 1.5) * frame.shadow.y);
        sum += textureSampleCompareLevel(shadow_map, shadow_sampler, uv + o, depth);
    }
    // Outside the map nothing casts a shadow.
    let inside = all(uv >= vec2(0.0)) && all(uv <= vec2(1.0)) && depth <= 1.0;
    return select(1.0, sum / 16.0, inside);
}

/// Light reaching a surface, per shading model, summed over the key and the point lights.
struct Light {
    // Σ E·max(n·l, 0)
    lambert: vec3<f32>,
    // Σ E·(max(n·l, 0)·0.5 + 0.5)
    wrap: vec3<f32>,
    // Σ E·toon band of n·l
    band: vec3<f32>,
    // Σ E·(n·h)^80
    spec: vec3<f32>,
    // Σ E (floor: light that reaches it at all)
    reach: vec3<f32>,
};

fn add_light(acc: ptr<function, Light>, e: vec3<f32>, l: vec3<f32>, n: vec3<f32>, v: vec3<f32>) {
    let ndl = max(dot(n, l), 0.0);
    (*acc).lambert += e * ndl;
    (*acc).wrap += e * (ndl * 0.5 + 0.5);
    (*acc).band += e * smoothstep(0.38, 0.45, ndl);
    (*acc).spec += e * pow(max(dot(n, normalize(l + v)), 0.0), 80.0);
    (*acc).reach += e;
}

fn gather(n: vec3<f32>, v: vec3<f32>, world: vec3<f32>, floor: bool, frag: vec2<f32>) -> Light {
    var acc: Light;
    acc.lambert = vec3(0.0);
    acc.wrap = vec3(0.0);
    acc.band = vec3(0.0);
    acc.spec = vec3(0.0);
    acc.reach = vec3(0.0);
    let l = normalize(frame.light_dir.xyz);
    var key = frame.key.rgb * key_visibility(world, n, frag);
    if (floor) {
        // The floor only loses the key below the horizon.
        key *= smoothstep(0.0, 0.05, l.y);
    }
    add_light(&acc, key, l, n, v);
    let count = i32(frame.sky.w + 0.5);
    for (var i = 0; i < MAX_POINTS; i++) {
        if (i >= count) {
            break;
        }
        let to = frame.point_pos[i].xyz - world;
        let d = length(to);
        let fall = max(1.0 - pow(d / max(frame.point_pos[i].w, 1e-3), 2.0), 0.0);
        add_light(&acc, frame.point_color[i].rgb * fall * fall, to / max(d, 1e-4), n, v);
    }
    return acc;
}

/// Ambient sky/ground light on a surface facing `n`.
fn ambient(n: vec3<f32>) -> vec3<f32> {
    return mix(frame.ground.rgb, frame.sky.rgb, n.y * 0.5 + 0.5);
}

fn max3(c: vec3<f32>) -> f32 {
    return max(c.r, max(c.g, c.b));
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
    var base = draw.tint;
    if (draw.flags.y > 0.5) {
        base = base * textureSample(tex, tex_sampler, in.uv);
    }
    var rgb = base.rgb;
    var alpha = 1.0;
    let n = normalize(in.normal);
    let v = normalize(frame.eye.xyz - in.world);
    let floor = draw.flags.w > 0.5;
    let lit = gather(n, v, in.world, floor, in.clip.xy);
    let amb = ambient(n);
    let finish = i32(frame.params.z + 0.5);
    if (finish > 0 && !floor) {
        let ndv = max(dot(n, v), 0.0);
        let fres = pow(1.0 - ndv, 3.0);
        if (finish == 1) {
            // Glossy plastic: wrapped diffuse, a crisp highlight and a soft rim.
            rgb = base.rgb * (0.38 * amb + 0.62 * lit.wrap) + lit.spec * 0.85 + mix(base.rgb, vec3(1.0), 0.6) * fres * 0.35 * amb;
        } else if (finish == 2) {
            // Glass: mostly see-through, bright where it turns away and where light glints.
            rgb = base.rgb * 0.35 * amb + lit.spec * 1.4 + mix(base.rgb, vec3(1.0), 0.7) * fres * amb;
            alpha = clamp(0.22 + fres * 0.8 + max3(lit.spec), 0.0, 1.0);
        } else if (finish == 3) {
            // Chrome: a studio environment (bright top, dark horizon, a soft box toward the key) reflected.
            let r = reflect(-v, n);
            let up = smoothstep(-0.15, 0.55, r.y);
            var env = mix(vec3(0.04) * frame.ground.rgb, vec3(0.95) * frame.sky.rgb, up);
            env = env * (1.0 - 0.7 * exp(-pow(r.y * 7.0, 2.0)));
            env += frame.key.rgb * exp(-pow((r.x - frame.light_dir.w) * 5.0, 2.0)) * smoothstep(-0.2, 0.4, r.y) * 0.8;
            rgb = env * mix(vec3(1.0), base.rgb, 0.65) + lit.spec;
        } else {
            // Matte clay: soft light, darker toward the back.
            rgb = base.rgb * (0.42 * amb + 0.58 * lit.lambert) * mix(0.85, 1.0, in.normal.y * 0.5 + 0.5);
        }
        if (frame.params.x > 0.5) {
            rgb = srgb_to_linear(clamp(rgb, vec3(0.0), vec3(1.0)));
        }
        return vec4(clamp(rgb, vec3(0.0), vec3(1.0)) * alpha, alpha);
    }
    if (floor) {
        // The floor keeps its exact color in full light; shadows take away the key's share.
        rgb = rgb * (0.68 * frame.sky.rgb + 0.32 * lit.reach);
    } else {
        // Toon: two light bands, a cool ambient and a soft rim.
        let up = in.normal.y * 0.5 + 0.5;
        rgb = rgb * (0.68 * amb + 0.32 * lit.band) * mix(0.92, 1.04, up);
    }
    rgb = clamp(rgb, vec3(0.0), vec3(1.0));
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
