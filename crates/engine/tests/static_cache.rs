//! Frames that start with the same layers start from a copy of them: the picture must not change.

use engine::Renderer;
use scene::Scene;

/// A still background with effects (a blurred, glowing card, a shadowed logo, a grade) under a title that
/// moves, then a layer added on top, then the background itself moving.
const SCENE: &str = r##"{"width":320,"height":180,"fps":30,"duration":4,"layers":[
    {"id":"bg","type":"shape","shape":"rect","x":160,"y":90,"w":320,"h":180,"fill":"#1b2433"},
    {"id":"card","type":"shape","shape":"rect","x":160,"y":90,"w":200,"h":110,"radius":16,"fill":"#e5484d","effects":[{"fx":"glow","radius":20,"strength":1},{"fx":"blur","radius":3}]},
    {"id":"logo","type":"shape","shape":"ellipse","x":[{"t":0,"v":60},{"t":2,"v":60},{"t":3,"v":120}],"y":50,"w":40,"h":40,"fill":"#ffffff","effects":[{"fx":"shadow","x":0,"y":6,"blur":10,"color":"#000000","opacity":0.6}]},
    {"id":"grade","type":"shape","shape":"rect","adjustment":true,"x":160,"y":90,"w":320,"h":180,"fill":"#ffffff","effects":[{"fx":"color","exposure":0.1,"contrast":1.1,"vignette":0.3}]},
    {"id":"title","type":"shape","shape":"rect","x":[{"t":0,"v":40},{"t":2,"v":280}],"y":140,"w":60,"h":14,"fill":"#f2c14e"},
    {"id":"late","type":"shape","shape":"ellipse","start":1,"x":250,"y":40,"w":20,"h":20,"fill":"#3d7bff","effects":[{"fx":"glow","radius":8,"strength":1}]}
]}"##;

const TIMES: [f32; 9] = [0.0, 0.3, 0.6, 1.0, 1.4, 2.0, 2.5, 3.0, 0.2];

#[test]
fn cached_static_layers_draw_the_same_picture() {
    let scene = Scene::from_json(SCENE).unwrap();
    pollster::block_on(async {
        let mut cached = Renderer::new_headless(320, 180).await.expect("a GPU adapter");
        let mut full = Renderer::new_headless(320, 180).await.expect("a GPU adapter");
        full.set_cache_static(false);
        for t in TIMES {
            let (a, b) = (cached.render_rgba(&scene, t), full.render_rgba(&scene, t));
            let worst = a.iter().zip(&b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
            assert!(worst <= 1, "t={t}: cached frame differs by {worst}/255");
        }
        // The background, card, logo (until it moves at 2 s) and grade came from the copy.
        assert!(cached.static_reused() >= 3, "only {} frames started from the copy", cached.static_reused());
        assert_eq!(full.static_reused(), 0);
    });
}
