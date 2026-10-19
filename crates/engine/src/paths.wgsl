// Path strokes as instanced capsules (antialiased, round caps, optional dash, color varying
// along the path) and path fills as a triangle mesh with per-vertex color.

struct Globals {
    scene_size: vec2<f32>,
    linearize: f32,
    time: f32,
};

@group(0) @binding(0) var<uniform> g: Globals;

fn to_ndc(p: vec2<f32>) -> vec4<f32> {
    return vec4(p.x / g.scene_size.x * 2.0 - 1.0, 1.0 - p.y / g.scene_size.y * 2.0, 0.0, 1.0);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

fn out_color(rgb_in: vec3<f32>, a: f32) -> vec4<f32> {
    var rgb = rgb_in;
    if (g.linearize > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    return vec4(rgb * a, a);
}

struct Seg {
    // a.xy, b.xy
    @location(0) ends: vec4<f32>,
    // half width, dash on, dash off, length before a
    @location(1) params: vec4<f32>,
    @location(2) color_a: vec4<f32>,
    @location(3) color_b: vec4<f32>,
};

struct SegOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) p: vec2<f32>,
    @location(1) a: vec2<f32>,
    @location(2) b: vec2<f32>,
    @location(3) params: vec4<f32>,
    @location(4) color_a: vec4<f32>,
    @location(5) color_b: vec4<f32>,
};

const CORNERS = array<vec2<f32>, 6>(
    vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(0.0, -1.0), vec2(1.0, 1.0), vec2(0.0, 1.0),
);

@vertex
fn vs_seg(@builtin(vertex_index) vi: u32, s: Seg) -> SegOut {
    let a = s.ends.xy;
    let b = s.ends.zw;
    let r = s.params.x + 1.5;
    let d = b - a;
    let len = max(length(d), 1e-4);
    let dir = d / len;
    let n = vec2(-dir.y, dir.x);
    let k = CORNERS[vi];
    // Quad covering the capsule (extended by the radius at both ends).
    let p = a - dir * r + dir * (len + 2.0 * r) * k.x + n * r * k.y;
    var o: SegOut;
    o.pos = to_ndc(p);
    o.p = p;
    o.a = a;
    o.b = b;
    o.params = s.params;
    o.color_a = s.color_a;
    o.color_b = s.color_b;
    return o;
}

@fragment
fn fs_seg(o: SegOut) -> @location(0) vec4<f32> {
    let pa = o.p - o.a;
    let ba = o.b - o.a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    let d = length(pa - ba * h) - o.params.x;
    let aa = max(fwidth(d), 1e-4);
    var cov = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);
    // Dashes: along-path distance modulo (on + off).
    let on = o.params.y;
    let off = o.params.z;
    if (on > 0.0 && off > 0.0) {
        let along = o.params.w + h * length(ba);
        let m = along - floor(along / (on + off)) * (on + off);
        cov *= 1.0 - smoothstep(on - 0.75, on + 0.75, m);
    }
    let c = mix(o.color_a, o.color_b, h);
    return out_color(c.rgb, c.a * cov);
}

struct MeshIn {
    @location(0) pos: vec2<f32>,
    @location(1) color: vec4<f32>,
};

struct MeshOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_mesh(v: MeshIn) -> MeshOut {
    var o: MeshOut;
    o.pos = to_ndc(v.pos);
    o.color = v.color;
    return o;
}

@fragment
fn fs_mesh(o: MeshOut) -> @location(0) vec4<f32> {
    return out_color(o.color.rgb, o.color.a);
}
