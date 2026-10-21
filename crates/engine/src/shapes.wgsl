// Instanced signed-distance shapes: rounded rects and ellipses (radius = half size), with
// gradient fills (up to 4 stops, linear or radial), outlines and soft (feathered) edges.

struct Globals {
    scene_size: vec2<f32>,
    // 1.0 when the surface is sRGB and we must linearize our sRGB colors.
    linearize: f32,
    // Seconds into the scene.
    time: f32,
    // Flat-space origin of the pass: 0 for the scene, the plane origin inside a tilted plane.
    origin: vec2<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;

struct Instance {
    // center.xy, size.xy
    @location(0) box: vec4<f32>,
    @location(1) color: vec4<f32>,
    // radius, rotation, soft, stroke width
    @location(2) params: vec4<f32>,
    @location(3) stroke_color: vec4<f32>,
    // kind (0 none, 1 linear, 2 radial), stop count, angle (rad), radial radius
    @location(4) grad: vec4<f32>,
    @location(5) grad_center: vec2<f32>,
    @location(6) stop_pos: vec4<f32>,
    @location(7) c0: vec4<f32>,
    @location(8) c1: vec4<f32>,
    @location(9) c2: vec4<f32>,
    @location(10) c3: vec4<f32>,
    // inner offset xy, inner blur, bevel width
    @location(11) inner: vec4<f32>,
    @location(12) inner_color: vec4<f32>,
    // sheen angle, position, width, intensity
    @location(13) sheen: vec4<f32>,
    @location(14) bevel: f32,
};

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) local: vec2<f32>,
    @location(1) half: vec2<f32>,
    @location(2) color: vec4<f32>,
    // radius, soft, stroke width, bevel strength
    @location(3) shape: vec4<f32>,
    @location(4) stroke_color: vec4<f32>,
    @location(5) grad: vec4<f32>,
    @location(6) grad_center: vec2<f32>,
    @location(7) stop_pos: vec4<f32>,
    @location(8) c0: vec4<f32>,
    @location(9) c1: vec4<f32>,
    @location(10) c2: vec4<f32>,
    @location(11) c3: vec4<f32>,
    @location(12) inner: vec4<f32>,
    @location(13) inner_color: vec4<f32>,
    @location(14) sheen: vec4<f32>,
};

const CORNERS = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, inst: Instance) -> VsOut {
    let half = inst.box.zw * 0.5;
    let soft = inst.params.z;
    // Pad so the antialiased edge, the outline and the feather are not clipped by the quad.
    let pad = 2.0 + soft + inst.params.w * 0.5;
    let local = CORNERS[vi] * (half + vec2(pad));
    let c = cos(inst.params.y);
    let s = sin(inst.params.y);
    let p = inst.box.xy + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    let ndc = vec2((p.x - g.origin.x) / g.scene_size.x * 2.0 - 1.0, 1.0 - (p.y - g.origin.y) / g.scene_size.y * 2.0);

    var out: VsOut;
    out.pos = vec4(ndc, 0.0, 1.0);
    out.local = local;
    out.half = half;
    out.color = inst.color;
    out.shape = vec4(min(inst.params.x, min(half.x, half.y)), soft, inst.params.w, inst.bevel);
    out.inner = inst.inner;
    out.inner_color = inst.inner_color;
    out.sheen = inst.sheen;
    out.stroke_color = inst.stroke_color;
    out.grad = inst.grad;
    out.grad_center = inst.grad_center;
    out.stop_pos = inst.stop_pos;
    out.c0 = inst.c0;
    out.c1 = inst.c1;
    out.c2 = inst.c2;
    out.c3 = inst.c3;
    return out;
}

fn sd_round_box(p: vec2<f32>, half: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - half + vec2(r);
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

fn stop_color(i: i32, in: VsOut) -> vec4<f32> {
    switch i {
        case 0: { return in.c0; }
        case 1: { return in.c1; }
        case 2: { return in.c2; }
        default: { return in.c3; }
    }
}

fn stop_at(i: i32, in: VsOut) -> f32 {
    switch i {
        case 0: { return in.stop_pos.x; }
        case 1: { return in.stop_pos.y; }
        case 2: { return in.stop_pos.z; }
        default: { return in.stop_pos.w; }
    }
}

/// Gradient color at this pixel (box space).
fn gradient_color(in: VsOut, kind: i32) -> vec4<f32> {
    let uv = in.local / max(in.half * 2.0, vec2(1e-3)) + vec2(0.5);
    var t: f32;
    if (kind == 1) {
        let dir = vec2(cos(in.grad.z), sin(in.grad.z));
        let extent = 0.5 * (abs(dir.x) + abs(dir.y));
        t = dot(uv - vec2(0.5), dir) / max(extent, 1e-3) * 0.5 + 0.5;
    } else if (kind == 2) {
        t = length(uv - in.grad_center) / max(in.grad.w * 0.7071, 1e-3);
    } else {
        let d = (uv - in.grad_center) * in.half;
        t = fract((atan2(d.y, d.x) - in.grad.z) / 6.2831853);
    }
    t = clamp(t, 0.0, 1.0);
    let count = i32(in.grad.y + 0.5);
    var col = stop_color(0, in);
    for (var i = 1; i < count; i++) {
        let a = stop_at(i - 1, in);
        let b = stop_at(i, in);
        if (t >= a) {
            let u = clamp((t - a) / max(b - a, 1e-4), 0.0, 1.0);
            col = mix(stop_color(i - 1, in), stop_color(i, in), u);
        }
    }
    return col;
}

/// `top` (straight color, alpha) laid over `base` (straight alpha).
fn over_straight(top: vec4<f32>, base: vec4<f32>) -> vec4<f32> {
    let a = top.a + base.a * (1.0 - top.a);
    if (a <= 1e-5) {
        return vec4(base.rgb, 0.0);
    }
    return vec4((top.rgb * top.a + base.rgb * base.a * (1.0 - top.a)) / a, a);
}

/// Inner shadow/glow, bevel and sheen on top of the fill (straight alpha in and out); they show
/// on glassy, see-through fills too.
fn material(in: VsOut, d: f32, base: vec4<f32>) -> vec4<f32> {
    var c = base;
    if (in.inner_color.a > 0.0) {
        // The shape shifted by the offset: where we are outside it, light is blocked (or glows).
        let shifted = sd_round_box(in.local - in.inner.xy, in.half, in.shape.x);
        let blur = max(in.inner.z, 0.75);
        let k = smoothstep(-blur, blur * 0.35, shifted) * in.inner_color.a;
        c = over_straight(vec4(in.inner_color.rgb, k), c);
    }
    let bevel_w = in.inner.w;
    if (bevel_w > 0.0 && in.shape.w != 0.0) {
        let e = 1.0;
        let nx = sd_round_box(in.local + vec2(e, 0.0), in.half, in.shape.x) - sd_round_box(in.local - vec2(e, 0.0), in.half, in.shape.x);
        let ny = sd_round_box(in.local + vec2(0.0, e), in.half, in.shape.x) - sd_round_box(in.local - vec2(0.0, e), in.half, in.shape.x);
        let n = normalize(vec2(nx, ny) + vec2(1e-5));
        // Light from the top-left: rims facing it brighten, the others darken.
        let lit = dot(n, normalize(vec2(-0.45, -0.9))) * in.shape.w;
        let edge = 1.0 - smoothstep(0.0, bevel_w, -d);
        c = over_straight(vec4(select(vec3(0.0), vec3(1.0), lit > 0.0), clamp(abs(lit) * edge, 0.0, 1.0)), c);
    }
    if (in.sheen.w > 0.0) {
        let dir = vec2(cos(in.sheen.x), sin(in.sheen.x));
        let u = dot(in.local / max(in.half, vec2(1.0)), dir) * 0.5;
        let center = mix(-0.9, 0.9, in.sheen.y);
        let band = exp(-pow((u - center) / max(in.sheen.z, 0.01), 2.0));
        c = over_straight(vec4(vec3(1.0), clamp(band * in.sheen.w, 0.0, 1.0)), c);
    }
    return c;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let d = sd_round_box(in.local, in.half, in.shape.x);
    let aa = max(fwidth(d), 1e-4);
    let soft = in.shape.y;
    let edge = aa * 0.5 + soft;
    let coverage = 1.0 - smoothstep(-edge, edge, d);
    let kind = i32(in.grad.x + 0.5);
    var fill = in.color;
    var stroke_color = in.stroke_color;
    if (kind >= 10) {
        let c = gradient_color(in, kind - 10);
        stroke_color = vec4(c.rgb, c.a * in.stroke_color.a);
    } else if (kind > 0) {
        fill = gradient_color(in, kind);
    }
    fill = material(in, d, fill);
    let sw = in.shape.z;
    var rgb: vec3<f32>;
    var a: f32;
    if (sw > 0.0) {
        // Outline drawn inside the edge; the fill covers what is inside the outline.
        let inner = 1.0 - smoothstep(-edge, edge, d + sw);
        let fa = fill.a * inner;
        let sa = stroke_color.a * max(coverage - inner, 0.0);
        a = fa + sa * (1.0 - fa);
        rgb = (fill.rgb * fa + stroke_color.rgb * sa * (1.0 - fa)) / max(a, 1e-4);
    } else {
        a = fill.a * coverage;
        rgb = fill.rgb;
    }
    if (g.linearize > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    return vec4(rgb * a, a);
}
