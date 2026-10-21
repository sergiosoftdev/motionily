// Liquid glass: a convex slab over the backdrop. Light entering the rim bends by Snell's law (the
// surface normal comes from the bevel's height field), each color channel with its own index of
// refraction, so the rim disperses a little. The body shows the blurred backdrop, tinted; a Fresnel
// rim and a specular highlight catch the light.

struct Glass {
    // xy: center (scene px), zw: half size (scene px)
    shape: vec4<f32>,
    // x: corner radius, y: rotation (rad), z: thickness (px), w: bevel (px)
    optics: vec4<f32>,
    // x: index of refraction, y: dispersion, z: specular, w: unused
    look: vec4<f32>,
    // rgb: tint, a: tint amount (0 = none)
    tint: vec4<f32>,
    // xy: scene size (px)
    scene: vec4<f32>,
};

@group(0) @binding(0) var sharp: texture_2d<f32>;
@group(0) @binding(1) var blurred: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> g: Glass;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
    let xy = vec2(f32((vi << 1u) & 2u), f32(vi & 2u));
    var o: VsOut;
    o.pos = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2(xy.x, 1.0 - xy.y);
    return o;
}

// Signed distance (scene px) from a scene point to the glass box: a rounded rectangle, rotated.
fn sd_glass(px: vec2<f32>) -> f32 {
    let q = px - g.shape.xy;
    let c = cos(-g.optics.y);
    let s = sin(-g.optics.y);
    let p = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
    let half = g.shape.zw;
    let r = min(g.optics.x, min(half.x, half.y));
    let k = abs(p) - half + vec2(r);
    return min(max(k.x, k.y), 0.0) + length(max(k, vec2(0.0))) - r;
}

// A vector from the glass frame back to the scene.
fn to_scene(v: vec2<f32>) -> vec2<f32> {
    let c = cos(g.optics.y);
    let s = sin(g.optics.y);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let px = uv * g.scene.xy;
    let d = sd_glass(px);
    let backdrop = textureSampleLevel(sharp, samp, uv, 0.0);
    if (d > 0.0) {
        return backdrop;
    }
    // Depth below the rim (u = 0 at the edge) and the outward normal of the rim.
    let u = -d;
    let e = 1.5;
    let gx = sd_glass(px + vec2(e, 0.0)) - sd_glass(px - vec2(e, 0.0));
    let gy = sd_glass(px + vec2(0.0, e)) - sd_glass(px - vec2(0.0, e));
    let nout = normalize(vec2(gx, gy) + vec2(1e-6, 0.0));
    // The bevel is a quarter circle: height h(u) = bevel * sqrt(1 - (1 - t)^2), t = u / bevel. Its slope
    // (1 - t) / sqrt(1 - (1 - t)^2) is zero past the bevel and capped at the edge, so the normal stays finite.
    // The bevel stays inside the corner radius (and half the short side): past it the normal's medial
    // axis cuts a crease through the corners.
    let short = min(g.shape.z, g.shape.w);
    let limit = max(min(g.optics.x, short), 1.0);
    let bevel = clamp(g.optics.w, 1.0, max(limit, short * 0.5));
    let t = clamp(u / bevel, 0.0, 1.0);
    let root = sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 1e-4));
    let slope = min((1.0 - t) / root, 3.0);
    let N = normalize(vec3(nout * slope, 1.0));
    // Snell per channel: the ray comes straight down, bends at the surface, and travels the thickness.
    let thick = g.optics.z;
    let ior = g.look.x;
    let spread = g.look.y;
    var refracted = vec3(0.0);
    var offset_green = vec2(0.0);
    for (var c = 0; c < 3; c++) {
        let n_c = ior + (f32(c) - 1.0) * spread;
        let T = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / n_c);
        var off = to_scene(T.xy / max(-T.z, 0.2) * thick);
        let mag = length(off);
        off = off * min(1.0, max(thick * 3.0, 60.0) / max(mag, 1e-4));
        refracted[c] = textureSampleLevel(sharp, samp, (px + off) / g.scene.xy, 0.0)[c];
        if (c == 1) {
            offset_green = off;
        }
    }
    // The body: the blurred backdrop, seen through the glass.
    let body = textureSampleLevel(blurred, samp, (px + offset_green * 0.5) / g.scene.xy, 0.0).rgb;
    // How much of the rim shows: 1 at the edge (the crisp bent image), 0 in the body (frosted).
    let rim = 0.5 * (1.0 - t) * (1.0 - t);
    var col = mix(body, refracted, rim);
    // Tint and a little brightness, as clear glass has.
    col = mix(col, g.tint.rgb, g.tint.a) + vec3(0.02);
    // Underside a touch darker.
    let band = 1.0 - smoothstep(0.0, 16.0, u);
    col = col * (1.0 - 0.12 * band * clamp(nout.y, 0.0, 1.0));
    // Fresnel: the rim turns to light at grazing angles.
    let fres = 0.04 + 0.96 * pow(1.0 - N.z, 5.0);
    let spec_amount = g.look.z;
    col = mix(col, vec3(1.0), clamp(fres * 0.6 * spec_amount, 0.0, 1.0));
    // Specular highlight from the light above and to the left.
    let L = normalize(vec3(-0.5, -0.6, 0.8));
    let H = normalize(L + vec3(0.0, 0.0, 1.0));
    let spec = pow(max(dot(N, H), 0.0), 90.0);
    col = mix(col, vec3(1.0), clamp(spec * spec_amount, 0.0, 1.0) * 0.9);
    // A thin bright line just inside the edge.
    let line = 1.0 - smoothstep(0.0, 1.4, abs(d + 1.2));
    col = mix(col, vec3(1.0), line * 0.45);
    return vec4(clamp(col, vec3(0.0), vec3(1.0)), 1.0);
}
