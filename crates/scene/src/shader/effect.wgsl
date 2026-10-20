// Shader effect: the agent's `shade` rewrites every pixel of the layer's offscreen image (an
// adjustment layer's image is everything drawn below it).
@group(0) @binding(0) var mly_src: texture_2d<f32>;
@group(0) @binding(1) var mly_samp: sampler;
@group(0) @binding(2) var<uniform> mly_u: MlyUniform;

fn src_pm(uv: vec2f) -> vec4f {
    let c = textureSampleLevel(mly_src, mly_samp, uv, 0.0);
    if (mly_u.misc.w > 0.5) {
        return vec4f(mly_to_srgb(c.rgb / max(c.a, 1e-5)) * c.a, c.a);
    }
    return c;
}

fn src(uv: vec2f) -> vec4f {
    let c = src_pm(uv);
    if (c.a <= 1e-5) {
        return vec4f(0.0);
    }
    return vec4f(c.rgb / c.a, c.a);
}
//@shade
struct MlyVsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn mly_vs(@builtin(vertex_index) vi: u32) -> MlyVsOut {
    let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
    var o: MlyVsOut;
    o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2f(xy.x, 1.0 - xy.y);
    return o;
}

@fragment
fn mly_fs(in: MlyVsOut) -> @location(0) vec4f {
    mly_setup();
    return mly_out(shade(in.uv, in.uv * size), 1.0);
}
