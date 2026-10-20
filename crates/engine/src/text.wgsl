// Textured quads from the glyph atlas: coverage in the red channel, or a signed distance field
// (large text, `sdf` = 1) that is thresholded here at the screen's pixel size.

struct Globals {
    scene_size: vec2<f32>,
    linearize: f32,
    time: f32,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(1) @binding(0) var atlas: texture_2d<f32>;
@group(1) @binding(1) var atlas_sampler: sampler;

struct Quad {
    @location(0) pos: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) uv: vec4<f32>,
    @location(3) color: vec4<f32>,
    @location(4) pivot: vec2<f32>,
    @location(5) rotation: f32,
    @location(6) blur: f32,
    @location(7) sdf: f32,
};

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    // Glyph rect in the atlas (samples outside it are empty) and blur radius in uv.
    @location(2) @interpolate(flat) rect: vec4<f32>,
    @location(3) @interpolate(flat) blur_uv: vec2<f32>,
    @location(4) @interpolate(flat) sdf: f32,
};

const CORNERS = array<vec2<f32>, 6>(
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, q: Quad) -> VsOut {
    let corner = CORNERS[vi];
    // A blurred glyph spills out of its box: grow the quad (and its uv) by the radius.
    let uv_per_px = (q.uv.zw - q.uv.xy) / max(q.size, vec2(1e-3));
    let grow = vec2(q.blur);
    let local = q.pos - grow + corner * (q.size + grow * 2.0) - q.pivot;
    let c = cos(q.rotation);
    let s = sin(q.rotation);
    let p = q.pivot + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    var out: VsOut;
    out.pos = vec4(p.x / g.scene_size.x * 2.0 - 1.0, 1.0 - p.y / g.scene_size.y * 2.0, 0.0, 1.0);
    out.uv = mix(q.uv.xy - grow * uv_per_px, q.uv.zw + grow * uv_per_px, corner);
    out.color = q.color;
    out.rect = q.uv;
    out.blur_uv = q.blur * uv_per_px;
    out.sdf = q.sdf;
    return out;
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

/// Coverage at `uv` inside the glyph rect: the atlas value, or for distance fields the smooth
/// threshold at 0.5 with a ramp `edge` wide (about one screen pixel).
fn cover(uv: vec2<f32>, rect: vec4<f32>, sdf: f32, edge: f32) -> f32 {
    let inside = all(uv >= rect.xy) && all(uv <= rect.zw);
    let v = textureSampleLevel(atlas, atlas_sampler, uv, 0.0).r;
    let shaped = smoothstep(0.5 - edge, 0.5 + edge, v);
    return select(0.0, select(v, shaped, sdf > 0.5), inside);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    // The field's change per screen pixel sets the ramp: half of it gives a one-pixel edge.
    let edge = 0.5 * fwidth(textureSampleLevel(atlas, atlas_sampler, clamp(in.uv, in.rect.xy, in.rect.zw), 0.0).r);
    var coverage = 0.0;
    if (in.blur_uv.x > 0.0) {
        // Disc of taps over the blur radius, ignoring neighbours in the atlas.
        let taps = 24;
        var sum = 0.0;
        for (var k = 0; k < taps; k++) {
            let f = f32(k) + 0.5;
            let r = sqrt(f / f32(taps));
            let a = f * 2.39996;
            let uv = in.uv + vec2(cos(a), sin(a)) * r * in.blur_uv;
            sum += cover(uv, in.rect, in.sdf, edge);
        }
        coverage = sum / f32(taps);
    } else {
        coverage = cover(in.uv, in.rect, in.sdf, edge);
    }
    var rgb = in.color.rgb;
    if (g.linearize > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    let a = in.color.a * coverage;
    return vec4(rgb * a, a);
}
