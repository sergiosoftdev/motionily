//! Tilted planes paint wherever the camera looks: the plane's flat space follows the plane, not the
//! frame. Renders a card at the frame center and far right of the frame, with the camera on it.

use engine::Renderer;
use scene::Scene;

const CARD: [u8; 3] = [0xff, 0x4d, 0x6d];

/// A 1920x1080 scene with one tilted card (rx 55) on a plane at (plane_x, 700), seen by a camera at (cam_x, 540).
fn scene(cam_x: f32, plane_x: f32) -> Scene {
    let json = format!(
        r##"{{"width":1920,"height":1080,"fps":30,"duration":1,"layers":[
            {{"id":"cam","type":"shape","shape":"rect","x":{cam_x},"y":540,"w":1,"h":1,"visible":false,"camera":{{"focal":1800}}}},
            {{"id":"floor","type":"shape","shape":"rect","x":{plane_x},"y":700,"w":1,"h":1,"visible":false,"rotate_x":55}},
            {{"id":"card","type":"shape","shape":"rect","parent":"floor","x":0,"y":0,"w":600,"h":300,"fill":"#ff4d6d"}}]}}"##
    );
    Scene::from_json(&json).expect("scene parses")
}

/// Pixels that are the card's color (RGBA8, rows top to bottom).
fn card_pixels(rgba: &[u8]) -> usize {
    rgba.chunks_exact(4)
        .filter(|p| p[3] > 250 && p[0].abs_diff(CARD[0]) < 6 && p[1].abs_diff(CARD[1]) < 6 && p[2].abs_diff(CARD[2]) < 6)
        .count()
}

#[test]
fn tilted_card_paints_the_same_wherever_the_camera_looks() {
    pollster::block_on(async {
        let mut renderer = Renderer::new_headless(1920, 1080).await.expect("a GPU adapter");
        let centered = card_pixels(&renderer.render_rgba(&scene(960.0, 960.0), 0.5));
        let far_right = card_pixels(&renderer.render_rgba(&scene(2400.0, 2400.0), 0.5));
        assert!(centered > 50_000, "the card paints when centered: {centered} px");
        assert_eq!(far_right, centered, "the same card, moved with the camera, must paint the same");
    });
}

/// A card far wider than the frame, on a plane at (800, 540), seen from a camera at `cam_x`.
fn wide_scene(cam_x: f32) -> Scene {
    let json = format!(
        r##"{{"width":1080,"height":1920,"fps":30,"duration":1,"layers":[
            {{"id":"cam","type":"shape","shape":"rect","x":{cam_x},"y":540,"w":1,"h":1,"visible":false,"camera":{{"focal":1800}}}},
            {{"id":"floor","type":"shape","shape":"rect","x":800,"y":540,"w":1,"h":1,"visible":false,"rotate_x":55}},
            {{"id":"card","type":"shape","shape":"rect","parent":"floor","x":0,"y":0,"w":4000,"h":2000,"fill":"#ff4d6d"}}]}}"##
    );
    Scene::from_json(&json).expect("scene parses")
}

#[test]
fn a_card_wider_than_the_frame_covers_the_same_frame_from_a_displaced_camera() {
    pollster::block_on(async {
        let mut renderer = Renderer::new_headless(1080, 1920).await.expect("a GPU adapter");
        let centered = card_pixels(&renderer.render_rgba(&wide_scene(800.0), 0.5));
        let displaced = card_pixels(&renderer.render_rgba(&wide_scene(400.0), 0.5));
        assert!(centered > 1_000_000, "the card covers the frame when centered: {centered} px");
        // Both cover the whole frame; the displaced one must not lose the part past its old window edge.
        let gap = centered.abs_diff(displaced) as f32 / centered as f32;
        assert!(gap < 0.01, "displaced {displaced} px vs centered {centered} px ({:.2}% apart)", gap * 100.0);
    });
}

/// A custom shader layer on a tilted plane at `plane_x`, seen by a camera on it, with a black background.
fn plane_layer_scene(plane_x: f32, shader: bool) -> Scene {
    let child = if shader {
        r##"{"id":"sh","type":"shader","parent":"floor","x":0,"y":0,"w":600,"h":300,"code":"fn shade(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.1, 0.6, 0.3, 1.0); }"}"##
    } else {
        r##"{"id":"sh","type":"shape","shape":"rect","parent":"floor","x":0,"y":0,"w":600,"h":300,"fill":"#1a9a4d"}"##
    };
    let json = format!(
        r##"{{"width":1080,"height":1920,"fps":30,"duration":1,"palette":{{"background":"#000000","surface":"#000000","primary":"#000000","accent":"#000000","text":"#ffffff"}},"layers":[
            {{"id":"cam","type":"shape","shape":"rect","x":{plane_x},"y":540,"w":1,"h":1,"visible":false,"camera":{{"focal":1800}}}},
            {{"id":"floor","type":"shape","shape":"rect","x":{plane_x},"y":540,"w":1,"h":1,"visible":false,"rotate_x":55}},
            {child}]}}"##
    );
    Scene::from_json(&json).expect("scene parses")
}

#[test]
fn a_shader_layer_on_a_far_plane_paints_like_a_shape() {
    pollster::block_on(async {
        let mut renderer = Renderer::new_headless(1080, 1920).await.expect("a GPU adapter");
        let lit = |rgba: &[u8]| rgba.chunks_exact(4).filter(|p| p[3] > 250 && (p[0] as u32 + p[1] as u32 + p[2] as u32) > 60).count();
        let shape = lit(&renderer.render_rgba(&plane_layer_scene(2400.0, false), 0.5));
        let shader = lit(&renderer.render_rgba(&plane_layer_scene(2400.0, true), 0.5));
        assert!(shape > 50_000, "the plain card paints: {shape} px");
        assert_eq!(shader, shape, "the shader layer must cover the same pixels as a shape of its size");
    });
}

#[test]
fn a_backdrop_blend_on_a_far_plane_blends_with_what_is_below() {
    pollster::block_on(async {
        let json = r##"{"width":1080,"height":1920,"fps":30,"duration":1,"palette":{"background":"#000000","surface":"#000000","primary":"#000000","accent":"#000000","text":"#ffffff"},"layers":[
            {"id":"cam","type":"shape","shape":"rect","x":2400,"y":540,"w":1,"h":1,"visible":false,"camera":{"focal":1800}},
            {"id":"floor","type":"shape","shape":"rect","x":2400,"y":540,"w":1,"h":1,"visible":false,"rotate_x":55},
            {"id":"card","type":"shape","shape":"rect","parent":"floor","x":0,"y":0,"w":600,"h":300,"fill":"#ff4d6d"},
            {"id":"glow","type":"shape","shape":"rect","parent":"floor","x":0,"y":0,"w":300,"h":200,"fill":"#3c8cff","blend":"overlay"}]}"##;
        let mut renderer = Renderer::new_headless(1080, 1920).await.expect("a GPU adapter");
        let rgba = renderer.render_rgba(&Scene::from_json(json).expect("scene parses"), 0.5);
        // The frame center is the plane's center: red under blue, blended by overlay (hard light of the
        // blue over the red): (255, 85, 218). A normal blend would show the blue (60, 140, 255).
        let at = (960 * 1080 + 540) * 4;
        let (r, g, b) = (rgba[at] as i32, rgba[at + 1] as i32, rgba[at + 2] as i32);
        assert!((r - 255).abs() <= 12 && (g - 85).abs() <= 12 && (b - 218).abs() <= 12, "overlay pixel: ({r}, {g}, {b})");
    });
}
