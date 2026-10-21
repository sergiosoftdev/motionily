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
