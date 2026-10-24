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
    // Projected (tilted plane) passes: flat-space origin of the pass (xy).
    origin: vec4<f32>,
    // Layer composite grading: exposure (stops), temperature (-1 cool .. 1 warm), tint (-1 green .. 1 magenta), vibrance.
    grade: vec4<f32>,
    // Layer composite grading: shadows, highlights (-1..1), vignette (0..1), unused.
    tone: vec4<f32>,
    // Color wheels (rgb): lift, gamma - 1, gain - 1, offset (all zero = neutral).
    lift: vec4<f32>,
    gamma: vec4<f32>,
    gain: vec4<f32>,
    offset: vec4<f32>,
    // Points per curve (master, red, green, blue) and the points, 3 vec4 per curve (x0 y0 x1 y1 ...).
    curve_n: vec4<f32>,
    curve: array<vec4<f32>, 12>,
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

/// One point of curve `k` (0 master, 1 red, 2 green, 3 blue).
fn curve_point(k: i32, i: i32) -> vec2<f32> {
    let v = p.curve[k * 3 + i / 2];
    return select(v.zw, v.xy, i % 2 == 0);
}

/// Curve `k` at `x`: straight between its points, flat past the ends; the identity without points.
fn curve_at(k: i32, x: f32) -> f32 {
    let n = i32(p.curve_n[k] + 0.5);
    if (n < 1) {
        return x;
    }
    var prev = curve_point(k, 0);
    if (x <= prev.x) {
        return prev.y;
    }
    for (var i = 1; i < 6; i++) {
        if (i >= n) {
            break;
        }
        let q = curve_point(k, i);
        if (x <= q.x) {
            return mix(prev.y, q.y, (x - prev.x) / max(q.x - prev.x, 1e-5));
        }
        prev = q;
    }
    return prev.y;
}

/// Luma of a premultiplied color (un-premultiplied first; 0 where the pixel is empty).
fn lum_of(c: vec4<f32>) -> f32 {
    return dot(select(vec3(0.0), c.rgb / c.a, c.a > 1e-5), vec3(0.2126, 0.7152, 0.0722));
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
        // Flat space is shifted by the plane's origin (see DrawFx::plane_origin).
        // origin.xy: where the flat window starts; origin.zw: its size. The screen uses h1/h2 as before.
        base = (s.xy / s.z - p.origin.xy) / p.origin.zw;
    }
    // Adjustment passes read the screen as it is (only their matte is projected).
    var uv = select(base, in.uv, p.b.w > 0.5) - p.b.xy;
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
    let wheels = any(p.lift != vec4(0.0)) || any(p.gamma != vec4(0.0)) || any(p.gain != vec4(0.0)) || any(p.offset != vec4(0.0));
    let curves = any(p.curve_n != vec4(0.0));
    if (mode == 0 && (any(p.adj != vec4(0.0)) || any(p.grade != vec4(0.0)) || any(p.tone != vec4(0.0)) || wheels || curves || p.grain.x > 0.0) && c.a > 0.0) {
        var rgb = c.rgb / c.a;
        // Exposure in stops, then white balance: warm lifts red and lowers blue, magenta lowers green.
        rgb = rgb * exp2(p.grade.x);
        rgb = rgb * vec3(1.0 + 0.2 * p.grade.y + 0.06 * p.grade.z, 1.0 - 0.12 * p.grade.z, 1.0 - 0.2 * p.grade.y + 0.06 * p.grade.z);
        if (wheels) {
            // Lift / gamma / gain / offset, per channel (Resolve's primaries).
            let lifted = (1.0 + p.gain.rgb) * (rgb + p.lift.rgb * (1.0 - rgb));
            rgb = pow(max(lifted, vec3(0.0)), 1.0 / max(1.0 + p.gamma.rgb, vec3(0.1))) + p.offset.rgb;
        }
        rgb = rgb + p.adj.z;
        rgb = (rgb - 0.5) * (1.0 + p.adj.w) + 0.5;
        // Shadows and highlights move only their end of the range (soft masks on luma).
        let tone_luma = dot(clamp(rgb, vec3(0.0), vec3(1.0)), vec3(0.2126, 0.7152, 0.0722));
        rgb = rgb + p.tone.x * 0.3 * (1.0 - smoothstep(0.0, 0.55, tone_luma));
        rgb = rgb + p.tone.y * 0.3 * smoothstep(0.45, 1.0, tone_luma);
        let luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        rgb = mix(vec3(luma), rgb, 1.0 + p.adj.y);
        // Vibrance: dull colors (small max - min) get more of it than vivid ones.
        let chroma = max(rgb.r, max(rgb.g, rgb.b)) - min(rgb.r, min(rgb.g, rgb.b));
        rgb = mix(vec3(luma), rgb, 1.0 + p.grade.w * (1.0 - clamp(chroma, 0.0, 1.0)));
        rgb = rotate_hue(rgb, p.adj.x);
        if (curves) {
            let m = clamp(rgb, vec3(0.0), vec3(1.0));
            let mm = vec3(curve_at(0, m.r), curve_at(0, m.g), curve_at(0, m.b));
            rgb = vec3(curve_at(1, mm.r), curve_at(2, mm.g), curve_at(3, mm.b));
        }
        // Vignette from the frame's center (screen space, so a full-frame clip and an adjustment agree).
        let d = length((in.uv - vec2(0.5)) * 1.41421);
        rgb = rgb * (1.0 - p.tone.z * smoothstep(0.35, 1.05, d));
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
    } else if (mode == 3) {
        // Glow threshold: keep the pixels whose luma is above adj.x (soft edge of 0.08).
        let luma = lum_of(c);
        c = c * smoothstep(p.adj.x, p.adj.x + 0.08, luma);
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

// ---- Backdrop blend modes (W3C compositing, premultiplied in and out). ----
// `src` is the layer as composited, `matte` slot holds the scene so far (both premultiplied).
// Mode ids match `BlendMode::shader_id` in scene/paint.rs.

fn screen_c(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
    return a + b - a * b;
}

// Hard light with `base` as the backdrop and `top` deciding multiply vs screen. Overlay is the
// same with the roles swapped.
fn hard_c(base: vec3<f32>, top: vec3<f32>) -> vec3<f32> {
    return select(screen_c(base, 2.0 * top - 1.0), base * 2.0 * top, top <= vec3(0.5));
}

fn soft_d(x: vec3<f32>) -> vec3<f32> {
    return select(sqrt(x), ((16.0 * x - 12.0) * x + 4.0) * x, x <= vec3(0.25));
}

fn lum_c(c: vec3<f32>) -> f32 {
    return dot(c, vec3(0.3, 0.59, 0.11));
}

fn clip_c(c: vec3<f32>) -> vec3<f32> {
    let l = lum_c(c);
    let n = min(c.r, min(c.g, c.b));
    let x = max(c.r, max(c.g, c.b));
    var o = c;
    if (n < 0.0) {
        o = l + (o - l) * l / max(l - n, 1e-6);
    }
    if (x > 1.0) {
        o = l + (o - l) * (1.0 - l) / max(x - l, 1e-6);
    }
    return o;
}

fn set_lum_c(c: vec3<f32>, l: f32) -> vec3<f32> {
    return clip_c(c + (l - lum_c(c)));
}

fn sat_c(c: vec3<f32>) -> f32 {
    return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
}

fn set_sat_c(c: vec3<f32>, s: f32) -> vec3<f32> {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    if (mx <= mn) {
        return vec3(0.0);
    }
    return (c - mn) * s / (mx - mn);
}

/// B(cb, cs): the blend function, backdrop `cb` and layer `cs` un-premultiplied.
fn blend_color(mode: i32, cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    if (mode == 4) { return min(cb, cs); }
    if (mode == 5) { return max(cb, cs); }
    if (mode == 6) { return abs(cb - cs); }
    if (mode == 7) { return cb + cs - 2.0 * cb * cs; }
    if (mode == 8) { return hard_c(cs, cb); }
    if (mode == 9) {
        let below = cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
        let above = cb + (2.0 * cs - 1.0) * (soft_d(cb) - cb);
        return select(above, below, cs <= vec3(0.5));
    }
    if (mode == 10) { return hard_c(cb, cs); }
    if (mode == 11) {
        var d = min(vec3(1.0), cb / max(1.0 - cs, vec3(1e-6)));
        d = select(d, vec3(1.0), cs >= vec3(1.0));
        return select(d, vec3(0.0), cb <= vec3(0.0));
    }
    if (mode == 12) {
        var b = 1.0 - min(vec3(1.0), (1.0 - cb) / max(cs, vec3(1e-6)));
        b = select(b, vec3(0.0), cs <= vec3(0.0));
        return select(b, vec3(1.0), cb >= vec3(1.0));
    }
    if (mode == 13) { return max(vec3(0.0), cb + cs - 1.0); }
    if (mode == 14) { return set_lum_c(set_sat_c(cs, sat_c(cb)), lum_c(cb)); }
    if (mode == 15) { return set_lum_c(set_sat_c(cb, sat_c(cs)), lum_c(cb)); }
    if (mode == 16) { return set_lum_c(cs, lum_c(cb)); }
    if (mode == 17) { return set_lum_c(cb, lum_c(cs)); }
    return cs;
}

@fragment
fn fs_blend(in: VsOut) -> @location(0) vec4<f32> {
    let s = textureSampleLevel(src, samp, in.uv, 0.0);
    let d = textureSampleLevel(matte, samp, in.uv, 0.0);
    let mode = i32(p.a.x + 0.5);
    let as_ = s.a;
    let ab = d.a;
    let cs = select(vec3(0.0), s.rgb / as_, as_ > 1e-5);
    let cb = select(vec3(0.0), d.rgb / ab, ab > 1e-5);
    // co = (1 - ab) * Cs_pre + (1 - as) * Cb_pre + as * ab * B(cb, cs)  (W3C, premultiplied).
    let rgb = (1.0 - ab) * s.rgb + (1.0 - as_) * d.rgb + as_ * ab * blend_color(mode, cb, cs);
    return vec4(rgb, as_ + ab - as_ * ab);
}
