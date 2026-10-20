// Shader layer: the agent's `shade` fills the layer box (a rotated quad with rounded corners).
struct MlyGlobals {
    scene_size: vec2f,
    linearize: f32,
    time: f32,
};

@group(0) @binding(0) var<uniform> mly_g: MlyGlobals;
@group(1) @binding(0) var<uniform> mly_u: MlyUniform;
//@shade
const MLY_CORNERS = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
);

struct MlyVsOut {
    @builtin(position) pos: vec4f,
    @location(0) local: vec2f,
};

@vertex
fn mly_vs(@builtin(vertex_index) vi: u32) -> MlyVsOut {
    let local = MLY_CORNERS[vi] * mly_u.box.zw * 0.5;
    let c = cos(mly_u.misc.x);
    let s = sin(mly_u.misc.x);
    let q = mly_u.box.xy + vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
    var o: MlyVsOut;
    o.pos = vec4f(q.x / mly_g.scene_size.x * 2.0 - 1.0, 1.0 - q.y / mly_g.scene_size.y * 2.0, 0.0, 1.0);
    o.local = local;
    return o;
}

@fragment
fn mly_fs(in: MlyVsOut) -> @location(0) vec4f {
    mly_setup();
    let half = mly_u.box.zw * 0.5;
    let uv = in.local / max(mly_u.box.zw, vec2f(1e-4)) + 0.5;
    let col = shade(uv, uv * size);
    // Box edge (and `rad` corners) anti-aliased like a shape layer.
    let d = sd_round_box(in.local, half, min(mly_u.misc.z, min(half.x, half.y)));
    let aa = max(fwidth(d), 1e-4);
    return mly_out(col, (1.0 - smoothstep(-aa * 0.5, aa * 0.5, d)) * mly_u.misc.y);
}
