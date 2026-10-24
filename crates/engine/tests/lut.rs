//! LUTs end to end: a color effect's `.cube` maps every pixel of its layer, `lut_mix` blends it, and a
//! LUT that is not loaded yet leaves the picture as it is.

use engine::Renderer;
use scene::Scene;

/// Red and blue swapped.
const SWAP: &str = "LUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n";

fn scene(effect: &str) -> Scene {
    let json = format!(
        r##"{{"width":200,"height":200,"fps":30,"duration":1,"layers":[{{"id":"bg","type":"shape","shape":"rect","x":100,"y":100,"w":200,"h":200,"fill":"#e01010","effects":[{effect}]}}]}}"##
    );
    Scene::from_json(&json).expect("scene parses")
}

#[test]
fn a_lut_maps_its_layer_and_mixes() {
    pollster::block_on(async {
        let mut renderer = Renderer::new_headless(200, 200).await.expect("a GPU adapter");
        let px = |rgba: &[u8]| [rgba[(100 * 200 + 100) * 4], rgba[(100 * 200 + 100) * 4 + 1], rgba[(100 * 200 + 100) * 4 + 2]];
        let full = scene(r#"{"fx":"color","lut":"/media/swap.cube"}"#);
        let before = px(&renderer.render_rgba(&full, 0.5));
        assert!(before[0] > 200 && before[2] < 40, "not loaded yet: unchanged {before:?}");
        renderer.add_lut("/media/swap.cube", SWAP).unwrap();
        let swapped = px(&renderer.render_rgba(&full, 0.5));
        assert!(swapped[2] > 200 && swapped[0] < 40, "red became blue: {swapped:?}");
        let half = px(&renderer.render_rgba(&scene(r#"{"fx":"color","lut":"/media/swap.cube","lut_mix":0.5}"#), 0.5));
        assert!((100..160).contains(&half[0]) && (100..160).contains(&half[2]), "half way: {half:?}");
        assert!(renderer.add_lut("/media/bad.cube", "LUT_3D_SIZE 3\n0 0 0\n").is_err());
    });
}

/// A soft ellipse adjustment layer grades inside its shape; `invert` grades everything but it.
#[test]
fn windows_grade_inside_or_outside_their_shape() {
    pollster::block_on(async {
        let mut renderer = Renderer::new_headless(200, 200).await.expect("a GPU adapter");
        let scene = |invert: bool| {
            let json = format!(
                r##"{{"width":200,"height":200,"fps":30,"duration":1,"layers":[
                {{"id":"bg","type":"shape","shape":"rect","x":100,"y":100,"w":200,"h":200,"fill":"#808080"}},
                {{"id":"win","type":"shape","shape":"ellipse","adjustment":true,"invert":{invert},"x":100,"y":100,"w":80,"h":80,"soft":6,"effects":[{{"fx":"color","exposure":1}}]}}]}}"##
            );
            Scene::from_json(&json).expect("scene parses")
        };
        let at = |rgba: &[u8], x: usize, y: usize| rgba[(y * 200 + x) * 4];
        let inside = renderer.render_rgba(&scene(false), 0.5);
        assert!(at(&inside, 100, 100) > 200, "brighter inside: {}", at(&inside, 100, 100));
        assert!((120..140).contains(&at(&inside, 10, 10)), "untouched outside: {}", at(&inside, 10, 10));
        let outside = renderer.render_rgba(&scene(true), 0.5);
        assert!((120..140).contains(&at(&outside, 100, 100)), "inverted: untouched inside {}", at(&outside, 100, 100));
        assert!(at(&outside, 10, 10) > 200, "inverted: brighter outside {}", at(&outside, 10, 10));
    });
}
