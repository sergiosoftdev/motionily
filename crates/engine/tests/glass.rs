//! Liquid glass end to end: a glass shape over a grid refracts and blurs what is behind it, and leaves
//! everything outside its box exactly as it was.

use engine::Renderer;
use scene::Scene;

/// Navy grid lines on cream, 1080x1920, plus an optional glass adjustment layer (a rounded rect).
fn scene(with_glass: bool) -> Scene {
    let mut layers = String::from(r##"{"id":"bg","type":"shape","shape":"rect","x":540,"y":960,"w":1080,"h":1920,"fill":"#f4f1ea"}"##);
    for i in 0..13 {
        layers.push_str(&format!(r##",{{"id":"v{i}","type":"shape","shape":"rect","x":{},"y":960,"w":6,"h":1920,"fill":"#0f1733"}}"##, 60 + i * 90));
    }
    for j in 0..22 {
        layers.push_str(&format!(r##",{{"id":"h{j}","type":"shape","shape":"rect","x":540,"y":{},"w":1080,"h":6,"fill":"#0f1733"}}"##, 60 + j * 90));
    }
    if with_glass {
        layers.push_str(r##",{"id":"glass","type":"shape","shape":"rect","adjustment":true,"x":540,"y":960,"w":760,"h":440,"radius":90,"effects":[{"fx":"glass","thickness":60,"bevel":120,"blur":6}]}"##);
    }
    let json = format!(r##"{{"width":1080,"height":1920,"fps":30,"duration":1,"palette":{{"background":"#f4f1ea","surface":"#ffffff","primary":"#3c6cff","accent":"#ff3d7f","text":"#0f1733"}},"layers":[{layers}]}}"##);
    Scene::from_json(&json).expect("scene parses")
}

/// Pixels in the box x 200..880, y 740..1180 (the glass) that are nearly black: the grid's lines.
fn dark_inside(rgba: &[u8]) -> usize {
    let mut n = 0;
    for y in 740..1180 {
        for x in 200..880 {
            let i = (y * 1080 + x) * 4;
            if rgba[i] < 90 && rgba[i + 1] < 90 && rgba[i + 2] < 120 {
                n += 1;
            }
        }
    }
    n
}

#[test]
fn glass_refracts_and_blurs_inside_and_leaves_the_rest_alone() {
    pollster::block_on(async {
        let mut renderer = Renderer::new_headless(1080, 1920).await.expect("a GPU adapter");
        let plain = renderer.render_rgba(&scene(false), 0.5);
        let glass = renderer.render_rgba(&scene(true), 0.5);
        let px = |rgba: &[u8], x: usize, y: usize| {
            let i = (y * 1080 + x) * 4;
            [rgba[i], rgba[i + 1], rgba[i + 2]]
        };
        // Outside the glass's box nothing changes.
        assert_eq!(px(&glass, 40, 40), px(&plain, 40, 40));
        assert_eq!(px(&glass, 1040, 1880), px(&plain, 1040, 1880));
        assert_eq!(px(&glass, 540, 300), px(&plain, 540, 300));
        // Inside, the body is blurred: the grid's sharp dark lines lose their darkness.
        let (dark_plain, dark_glass) = (dark_inside(&plain), dark_inside(&glass));
        assert!(dark_plain > 2000, "the grid lines are there without glass: {dark_plain}");
        assert!(dark_glass * 2 < dark_plain, "the body is blurred: {dark_glass} dark px vs {dark_plain}");
        // Near the rim the light is bent: the picture there differs from the plain one.
        let rim_changed = (760..800).any(|x| px(&glass, x, 960) != px(&plain, x, 960));
        assert!(rim_changed, "the rim refracts the backdrop");
    });
}
