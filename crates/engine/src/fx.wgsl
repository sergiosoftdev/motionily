// Per-layer effects on offscreen textures (premultiplied alpha): separable gaussian blur, and a
// composite that puts a layer (or its shadow / glow) back on the scene, through a track matte.

struct Params {
    // Blur: texel step direction (x, y), sigma in texels, unused.
    // Composite: mode (0 layer, 1 shadow, 2 glow), matte mode (0 none, 1 alpha, 2 inverted), strength, use color.
    a: vec4<f32>,
    // Composite: uv offset (shadow), clamp edges (adjustment layers: warps never pull in emptiness), unused.
    b: vec4<f32>,
    // Composite: tint color (straight alpha).
    color: vec4<f32>,
    // Layer composite color correction: hue (radians), saturation - 1, brightness, contrast - 1.
    adj: vec4<f32>,
    // Layer composite distortion: wave amplitude (uv x), wave cycles per uv y, wave phase, RGB split (uv x).
    warp: vec4<f32>,
    // Layer composite grain: amount, seed.
    grain: vec4<f32>,
    // Turbulent displacement: amount (uv x, uv y), noise cells per uv x, flow time.
    turb: vec4<f32>,
    // 3D layers: screen px -> flat layer px (rows), enabled in h0.w, scene size in h1.w / h2.w.
    h0: vec4<f32>,
    h1: vec4<f32>,
    h2: vec4<f32>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var matte: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> p: Params;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
    // One triangle covering the screen.
    let xy = vec2(f32((vi << 1u) & 2u), f32(vi & 2u));
    var o: VsOut;
    o.pos = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2(xy.x, 1.0 - xy.y);
    return o;
}

const TAPS: i32 = 16;

@fragment
fn fs_blur(in: VsOut) -> @location(0) vec4<f32> {
    let sigma = max(p.a.z, 0.01);
    // Spread the taps over ±3 sigma; bilinear filtering fills the gaps for large blurs.
    let step = max(1.0, 3.0 * sigma / f32(TAPS));
    let dir = p.a.xy * step;
    var acc = vec4(0.0);
    var wsum = 0.0;
    for (var i = -TAPS; i <= TAPS; i++) {
        let x = f32(i) * step;
        let w = exp(-0.5 * x * x / (sigma * sigma));
        acc += textureSampleLevel(src, samp, in.uv + dir * f32(i), 0.0) * w;
        wsum += w;
    }
    return acc / wsum;
}

fn sample_in(uv_in: vec2<f32>) -> vec4<f32> {
    var uv = uv_in;
    if (p.b.z > 0.5) {
        uv = clamp(uv, vec2(0.0), vec2(1.0));
    }
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
        return vec4(0.0);
    }
    return textureSampleLevel(src, samp, uv, 0.0);
}

fn hash(q: vec2<f32>) -> f32 {
    return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453);
}

fn value_noise(q: vec2<f32>) -> f32 {
    let i = floor(q);
    let f = fract(q);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

/// Four octaves of flowing value noise in -0.5..0.5.
fn fbm(q: vec2<f32>, time: f32) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var p = q;
    for (var o = 0; o < 4; o++) {
        sum += amp * value_noise(p + vec2(time * 0.35, -time * 0.22));
        p = p * 2.03 + vec2(17.1, 9.2);
        amp *= 0.5;
    }
    return sum - 0.47;
}

/// Hue rotation around the grey axis (Rodrigues).
fn rotate_hue(c: vec3<f32>, angle: f32) -> vec3<f32> {
    let k = vec3(0.57735);
    let cs = cos(angle);
    return c * cs + cross(k, c) * sin(angle) + k * dot(k, c) * (1.0 - cs);
}

@fragment
fn fs_composite(in: VsOut) -> @location(0) vec4<f32> {
    let mode = i32(p.a.x + 0.5);
    let matte_mode = i32(p.a.y + 0.5);
    var base = in.uv;
    if (p.h0.w > 0.5) {
        let size = vec2(p.h1.w, p.h2.w);
        let q = vec3(in.uv * size, 1.0);
        let s = vec3(dot(p.h0.xyz, q), dot(p.h1.xyz, q), dot(p.h2.xyz, q));
        if (s.z <= 0.0) {
            return vec4(0.0);
        }
        base = s.xy / s.z / size;
    }
    var uv = base - p.b.xy;
    if (mode == 0) {
        uv.x += p.warp.x * sin(uv.y * p.warp.y * 6.2831853 + p.warp.z);
        if (p.turb.x != 0.0) {
            // Aspect-correct noise space: cells are square on screen.
            let q = vec2(uv.x, uv.y * p.turb.x / p.turb.y) * p.turb.z;
            uv += vec2(fbm(q, p.turb.w), fbm(q + vec2(31.7, 11.3), p.turb.w)) * p.turb.xy * 2.0;
        }
    }
    var c = sample_in(uv);
    if (mode == 0 && p.warp.w != 0.0) {
        let r = sample_in(uv + vec2(p.warp.w, 0.0));
        let b = sample_in(uv - vec2(p.warp.w, 0.0));
        c = vec4(r.r, c.g, b.b, max(c.a, max(r.a, b.a)));
    }
    if (mode == 0 && (any(p.adj != vec4(0.0)) || p.grain.x > 0.0) && c.a > 0.0) {
        var rgb = c.rgb / c.a;
        rgb = rgb + p.adj.z;
        rgb = (rgb - 0.5) * (1.0 + p.adj.w) + 0.5;
        let luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        rgb = mix(vec3(luma), rgb, 1.0 + p.adj.y);
        rgb = rotate_hue(rgb, p.adj.x);
        rgb = rgb + (hash(floor(in.pos.xy) + p.grain.y) - 0.5) * p.grain.x;
        c = vec4(clamp(rgb, vec3(0.0), vec3(1.0)) * c.a, c.a);
    }
    if (mode == 1) {
        // Shadow: the layer's alpha tinted.
        let a = c.a * p.color.a;
        c = vec4(p.color.rgb * a, a);
    } else if (mode == 2) {
        // Glow: the blurred layer (or tint) boosted; drawn with additive blending.
        if (p.a.w > 0.5) {
            c = vec4(p.color.rgb * c.a, c.a);
        }
        c = c * p.a.z;
    }
    if (matte_mode > 0) {
        // A projected layer's matte lives in the same flat space as the layer.
        let mt = textureSampleLevel(matte, samp, select(in.uv, base, p.h0.w > 0.5), 0.0);
        var m = mt.a;
        if (matte_mode >= 3) {
            // Premultiplied, so this is luma times coverage.
            m = dot(mt.rgb, vec3(0.2126, 0.7152, 0.0722));
        }
        c = c * select(m, 1.0 - m, matte_mode == 2 || matte_mode == 4);
    }
    return c;
}
