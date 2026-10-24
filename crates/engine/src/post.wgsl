// Render styles: the scene is drawn into a transparent texture, then composited
// over the background here with a look (shadows, outlines, halftone, paper…).
// Effects only look at coverage (alpha) around each pixel, so they work for any
// pipeline (shapes, text, characters) without knowing about them.

struct Post {
    background: vec4<f32>,
    ink: vec4<f32>,
    shadow: vec4<f32>,
    // x: texture px per scene px, y: style id, z: style amount, w: scene time.
    params: vec4<f32>,
    texel: vec2<f32>,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var scene_tex: texture_2d<f32>;
@group(0) @binding(1) var scene_sampler: sampler;
@group(0) @binding(2) var<uniform> post: Post;

const STYLE_FLAT: f32 = 0.0;
const STYLE_SOFT_DEPTH: f32 = 1.0;
const STYLE_TOON: f32 = 2.0;
const STYLE_CEL: f32 = 3.0;
const STYLE_PAPER: f32 = 4.0;
const STYLE_ISO: f32 = 5.0;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
    // Fullscreen triangle.
    let p = vec2(f32((vi << 1u) & 2u), f32(vi & 2u));
    var out: VsOut;
    out.pos = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2(p.x, 1.0 - p.y);
    return out;
}

fn sample(uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(scene_tex, scene_sampler, uv, 0.0);
}

/// Scene-pixel offset to uv offset.
fn px(v: vec2<f32>) -> vec2<f32> {
    return v * post.params.x * post.texel;
}

fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

/// Soft coverage of the scene shifted by `offset` scene px, blurred over `radius`.
fn soft_alpha(uv: vec2<f32>, offset: vec2<f32>, radius: f32) -> f32 {
    // Two rotated rings of taps plus the center: smooth enough to avoid ghost copies.
    var a = sample(uv + px(offset)).a;
    for (var i = 0; i < 12; i++) {
        let ang = f32(i) * 0.523599;
        a += sample(uv + px(offset + vec2(cos(ang), sin(ang)) * radius)).a;
        a += sample(uv + px(offset + vec2(cos(ang + 0.26), sin(ang + 0.26)) * radius * 0.5)).a;
    }
    return a / 25.0;
}

/// Max coverage within `radius` scene px: the silhouette grown outwards.
fn dilated_alpha(uv: vec2<f32>, radius: f32) -> f32 {
    var a = 0.0;
    for (var i = 0; i < 12; i++) {
        let ang = f32(i) * 0.523599;
        a = max(a, sample(uv + px(vec2(cos(ang), sin(ang)) * radius)).a);
    }
    return a;
}

fn over(dst: vec3<f32>, src: vec4<f32>) -> vec3<f32> {
    // `src` is premultiplied.
    return src.rgb + dst * (1.0 - src.a);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let style = post.params.y;
    let amount = post.params.z;
    var uv = in.uv;
    let scene_px = in.uv / (post.texel * post.params.x);

    if (style == STYLE_PAPER) {
        // Stop-motion: edges wobble a little, re-rolled 8 times per second.
        let frame = floor(post.params.w * 8.0);
        let j = vec2(noise(scene_px * 0.05 + frame * 7.0), noise(scene_px * 0.05 + 31.0 + frame * 3.0)) - 0.5;
        uv += px(j * 2.5);
    }

    var c = sample(uv);
    var bg = post.background.rgb;

    if (style == STYLE_SOFT_DEPTH) {
        let s = soft_alpha(uv, vec2(0.0, 14.0) * amount, 18.0 * amount);
        bg = mix(bg, post.shadow.rgb, s * 0.35);
        // Gentle top light on every element.
        let above = sample(uv + px(vec2(0.0, -6.0))).a;
        c = vec4(c.rgb + vec3(0.07) * c.a * (1.0 - above), c.a);
    } else if (style == STYLE_TOON) {
        let width = 6.0 * amount;
        let grown = dilated_alpha(uv, width);
        bg = mix(bg, post.ink.rgb, clamp(grown - c.a, 0.0, 1.0));
        // Two-tone shading: lower-right part of each element a step darker.
        let lit = sample(uv + px(vec2(-10.0, -10.0))).a;
        c = vec4(c.rgb * mix(0.82, 1.0, step(0.5, lit)), c.a);
    } else if (style == STYLE_CEL) {
        let hard = sample(uv + px(vec2(14.0, 14.0) * amount)).a;
        let dots = step(0.5, length(fract(scene_px / 9.0) - 0.5) * 2.0);
        bg = mix(bg, post.shadow.rgb, hard * (1.0 - dots) * 0.6);
        let grown = dilated_alpha(uv, 3.0);
        bg = mix(bg, post.ink.rgb, clamp(grown - c.a, 0.0, 1.0));
        let lit = sample(uv + px(vec2(-14.0, -14.0))).a;
        c = vec4(c.rgb * mix(0.78, 1.0, step(0.5, lit)), c.a);
    } else if (style == STYLE_PAPER) {
        let s = soft_alpha(uv, vec2(5.0, 9.0) * amount, 6.0);
        bg = mix(bg, post.shadow.rgb, s * 0.45);
        let grain = noise(scene_px * 0.9) * 0.6 + noise(scene_px * 0.15) * 0.4;
        bg = bg * (0.94 + grain * 0.08);
        c = vec4(c.rgb * (0.93 + grain * 0.1), c.a);
    } else if (style == STYLE_ISO) {
        // Three tones per element: lit top band, mid face, darker right/bottom side.
        let top = sample(uv + px(vec2(0.0, -16.0))).a;
        let right = sample(uv + px(vec2(16.0, 0.0))).a;
        let bottom = sample(uv + px(vec2(0.0, 16.0))).a;
        var k = 1.0;
        if (top < 0.5) { k = 1.12; }
        if (right < 0.5 || bottom < 0.5) { k = 0.8; }
        c = vec4(c.rgb * k, c.a);
        let s = sample(uv + px(vec2(-12.0, 10.0))).a;
        bg = mix(bg, post.shadow.rgb, s * 0.3);
    }

    // Transparent output (background alpha 0, exports with alpha): no backdrop, straight alpha.
    if (post.background.a < 0.5) {
        return vec4(select(vec3(0.0), c.rgb / c.a, c.a > 1e-5), c.a);
    }
    // Dither: ±1 code value of noise so soft gradients never band.
    let dither = (hash(in.pos.xy) - 0.5) / 255.0 * 1.5;
    return vec4(over(bg, c) + vec3(dither), 1.0);
}
