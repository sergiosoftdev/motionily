//! An export asks to draw only frames that differ from the last one: holds come back as "reuse it".

use engine::Renderer;
use scene::Scene;

#[test]
fn identical_frames_are_not_drawn_again() {
    let json = r##"{"width":320,"height":180,"fps":30,"duration":3,"layers":[
        {"id":"bg","type":"shape","shape":"rect","x":160,"y":90,"w":320,"h":180,"fill":"#1b2433"},
        {"id":"dot","type":"shape","shape":"ellipse","x":[{"t":0,"v":40},{"t":1,"v":280}],"y":90,"w":30,"h":30,"fill":"#f2c14e"}
    ]}"##;
    let scene = Scene::from_json(json).unwrap();
    pollster::block_on(async {
        let mut r = Renderer::new_headless(320, 180).await.expect("a GPU adapter");
        // The dot moves for 1 s, then holds.
        let drawn: Vec<bool> = [0.0, 0.5, 0.5, 1.0, 1.5, 2.0, 2.5].iter().map(|t| r.render_changed(&scene, *t)).collect();
        assert_eq!(drawn, vec![true, true, false, true, false, false, false]);
        // Something the renderer cannot see changed: the next frame is drawn in full.
        r.invalidate_frame();
        assert!(r.render_changed(&scene, 2.5));
    });
}
