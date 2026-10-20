// ---- Motionily shader prelude (fixed; listed in docs/agent/syntax.md "Custom shaders") ----

struct MlyUniform {
    // Layer: center.xy and drawn size.zw on screen (scene px). Effect: unused.
    box: vec4f,
    // Rotation (rad), opacity, corner radius (drawn px), linearize (1 = sRGB target).
    misc: vec4f,
    // t, T, zoom, unused.
    clock: vec4f,
    // size.xy (px that uv 0..1 spans), unused.
    area: vec4f,
    // The layer's fill color (straight alpha). Effects: white.
    tint: vec4f,
    p: array<vec4f, 2>,
    pal: array<vec4f, 5>,
};

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;

var<private> t: f32;
var<private> T: f32;
var<private> size: vec2f;
var<private> zoom: f32;
var<private> tint: vec4f;
var<private> p0: f32;
var<private> p1: f32;
var<private> p2: f32;
var<private> p3: f32;
var<private> p4: f32;
var<private> p5: f32;
var<private> p6: f32;
var<private> p7: f32;
var<private> background: vec4f;
var<private> surface: vec4f;
var<private> primary: vec4f;
var<private> accent: vec4f;
var<private> text: vec4f;

fn mly_setup() {
    t = mly_u.clock.x;
    T = mly_u.clock.y;
    zoom = mly_u.clock.z;
    size = mly_u.area.xy;
    tint = mly_u.tint;
    p0 = mly_u.p[0].x;
    p1 = mly_u.p[0].y;
    p2 = mly_u.p[0].z;
    p3 = mly_u.p[0].w;
    p4 = mly_u.p[1].x;
    p5 = mly_u.p[1].y;
    p6 = mly_u.p[1].z;
    p7 = mly_u.p[1].w;
    background = mly_u.pal[0];
    surface = mly_u.pal[1];
    primary = mly_u.pal[2];
    accent = mly_u.pal[3];
    text = mly_u.pal[4];
}

fn hash11(x: f32) -> f32 {
    var q = fract(x * 0.1031);
    q *= q + 33.33;
    q *= q + q;
    return fract(q);
}

fn hash21(v: vec2f) -> f32 {
    var q = fract(vec3f(v.x, v.y, v.x) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

fn hash22(v: vec2f) -> vec2f {
    var q = fract(vec3f(v.x, v.y, v.x) * vec3f(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.xx + q.yz) * q.zy);
}

fn hash31(v: vec3f) -> f32 {
    var q = fract(v * 0.1031);
    q += dot(q, q.zyx + 31.32);
    return fract((q.x + q.y) * q.z);
}

fn noise(v: vec2f) -> f32 {
    let i = floor(v);
    let f = fract(v);
    let u = f * f * (3.0 - 2.0 * f);
    let a = mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x);
    let b = mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x);
    return mix(a, b, u.y);
}

fn noise3(v: vec3f) -> f32 {
    let i = floor(v);
    let f = fract(v);
    let u = f * f * (3.0 - 2.0 * f);
    let a = mix(mix(hash31(i), hash31(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(hash31(i + vec3f(0.0, 1.0, 0.0)), hash31(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y);
    let b = mix(mix(hash31(i + vec3f(0.0, 0.0, 1.0)), hash31(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(hash31(i + vec3f(0.0, 1.0, 1.0)), hash31(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y);
    return mix(a, b, u.z);
}

fn mly_permute(x: vec3f) -> vec3f {
    let y = ((x * 34.0) + 10.0) * x;
    return y - floor(y * (1.0 / 289.0)) * 289.0;
}

// 2D simplex noise (Ashima Arts, MIT), -1..1.
fn snoise(v: vec2f) -> f32 {
    let C = vec4f(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    var i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);
    let i1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
    var x12 = x0.xyxy + C.xxzz;
    x12 = vec4f(x12.xy - i1, x12.zw);
    i = i - floor(i * (1.0 / 289.0)) * 289.0;
    let q = mly_permute(mly_permute(i.y + vec3f(0.0, i1.y, 1.0)) + i.x + vec3f(0.0, i1.x, 1.0));
    var m = max(0.5 - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
    m = m * m;
    m = m * m;
    let x = 2.0 * fract(q * C.www) - 1.0;
    let h = abs(x) - 0.5;
    let a0 = x - floor(x + 0.5);
    m = m * (1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h));
    let g = vec3f(a0.x * x0.x + h.x * x0.y, a0.yz * x12.xz + h.yz * x12.yw);
    return 130.0 * dot(m, g);
}

fn rot2(a: f32) -> mat2x2f {
    let c = cos(a);
    let s = sin(a);
    return mat2x2f(c, s, -s, c);
}

fn fbm(v: vec2f) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var q = v;
    for (var o = 0; o < 5; o++) {
        sum += amp * noise(q);
        q = rot2(0.5) * q * 2.02 + vec2f(17.3, 9.1);
        amp *= 0.5;
    }
    return sum / 0.96875;
}

fn fbm3(v: vec3f) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var q = v;
    for (var o = 0; o < 5; o++) {
        sum += amp * noise3(q);
        q = vec3f(rot2(0.5) * q.xy, q.z) * 2.02 + vec3f(17.3, 9.1, 4.7);
        amp *= 0.5;
    }
    return sum / 0.96875;
}

fn wrap(x: f32, y: f32) -> f32 {
    return x - y * floor(x / y);
}

fn sd_circle(q: vec2f, r: f32) -> f32 {
    return length(q) - r;
}

fn sd_box(q: vec2f, half: vec2f) -> f32 {
    let d = abs(q) - half;
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sd_round_box(q: vec2f, half: vec2f, r: f32) -> f32 {
    return sd_box(q, half - vec2f(r)) - r;
}

fn sd_segment(q: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = q - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    return length(pa - ba * h);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = max(k - abs(a - b), 0.0) / max(k, 1e-6);
    return min(a, b) - h * h * k * 0.25;
}

fn smax(a: f32, b: f32, k: f32) -> f32 {
    return -smin(-a, -b, k);
}

fn fill(d: f32) -> f32 {
    let w = max(fwidth(d), 1e-4) * 0.5;
    return 1.0 - smoothstep(-w, w, d);
}

fn stroke(d: f32, width: f32) -> f32 {
    return fill(abs(d) - width * 0.5);
}

fn cos_palette(x: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
    return a + b * cos(TAU * (c * x + d));
}

fn luma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn hsv2rgb(c: vec3f) -> vec3f {
    let k = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    let q = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
    return c.z * mix(k.xxx, clamp(q - k.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

fn rgb2hsv(c: vec3f) -> vec3f {
    let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    let q = select(vec4f(c.bg, k.wz), vec4f(c.gb, k.xy), c.g >= c.b);
    let r = select(vec4f(q.xyw, c.r), vec4f(c.r, q.yzx), c.r >= q.x);
    let d = r.x - min(r.w, r.y);
    return vec3f(abs(r.z + (r.w - r.y) / (6.0 * d + 1e-10)), d / (r.x + 1e-10), r.x);
}

fn over(top: vec4f, below: vec4f) -> vec4f {
    let a = top.a + below.a * (1.0 - top.a);
    let rgb = (top.rgb * top.a + below.rgb * below.a * (1.0 - top.a)) / max(a, 1e-5);
    return vec4f(rgb, a);
}

fn mly_to_linear(c: vec3f) -> vec3f {
    return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn mly_to_srgb(c: vec3f) -> vec3f {
    return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

// Straight alpha in, clamped and premultiplied out (times `cover`).
fn mly_out(c: vec4f, cover: f32) -> vec4f {
    var rgb = clamp(c.rgb, vec3f(0.0), vec3f(1.0));
    if (mly_u.misc.w > 0.5) {
        rgb = mly_to_linear(rgb);
    }
    let a = clamp(c.a, 0.0, 1.0) * cover;
    return vec4f(rgb * a, a);
}
