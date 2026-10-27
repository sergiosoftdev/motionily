//! Effect layers shaded only where they can reach draw the same picture as shading the whole frame:
//! shadows, glows (with a threshold), blurs, blend modes that read the backdrop, motion blur, text.

use engine::Renderer;
use scene::Scene;

fn scene() -> Scene {
    let mut layers = String::from(r##"{"id":"bg","type":"shape","shape":"rect","x":540,"y":960,"w":1080,"h":1920,"fill":"#1b2433"},{"id":"stripe","type":"shape","shape":"rect","x":540,"y":700,"w":1080,"h":180,"fill":"#e9573f"}"##);
    for i in 0..12 {
        let (x, y) = (140 + (i % 4) * 260, 300 + (i / 4) * 420);
        let fx = match i % 4 {
            0 => r##"[{"fx":"shadow","x":10,"y":30,"blur":24,"color":"#000000","opacity":0.6}]"##,
            1 => r#"[{"fx":"glow","radius":36,"strength":1.2,"threshold":0.5}]"#,
            2 => r#"[{"fx":"blur","radius":12},{"fx":"glow","radius":20,"strength":1}]"#,
            _ => r##"[{"fx":"shadow","x":-20,"y":0,"blur":10,"color":"#ffffff","opacity":0.4}]"##,
        };
        let blend = if i % 3 == 0 { r#","blend":"overlay""# } else { "" };
        layers.push_str(&format!(r##",{{"id":"s{i}","type":"shape","shape":"ellipse","x":[{{"t":0,"v":{x}}},{{"t":1,"v":{}}}],"y":{y},"w":150,"h":150,"fill":"#f2c14e","effects":{fx}{blend}}}"##, x + 80));
    }
    layers.push_str(r##",{"id":"title","type":"text","text":"Glow on type","x":540,"y":1700,"size":110,"fill":"#ffffff","effects":[{"fx":"glow","radius":30,"strength":1}]}"##);
    layers.push_str(r##",{"id":"fast","type":"shape","shape":"rect","x":[{"t":0,"v":100},{"t":1,"v":980}],"y":1450,"w":120,"h":60,"fill":"#3d7bff","mblur":[180,6]}"##);
    let json = format!(r##"{{"width":1080,"height":1920,"fps":30,"duration":1,"layers":[{layers}]}}"##);
    Scene::from_json(&json).expect("scene parses")
}

#[test]
fn clipped_effect_passes_draw_the_same_picture() {
    pollster::block_on(async {
        let mut r = Renderer::new_headless(1080, 1920).await.expect("a GPU adapter");
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/web/public/fonts/Inter-700.ttf")).expect("font");
        r.add_font("Inter", 700, &bytes).expect("font");
        let s = scene();
        for t in [0.0, 0.37, 0.8] {
            r.set_clip_effects(false);
            let full = r.render_rgba(&s, t);
            r.set_clip_effects(true);
            let clipped = r.render_rgba(&s, t);
            let diff: Vec<u32> = full.iter().zip(&clipped).map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs()).collect();
            let max = *diff.iter().max().unwrap();
            let mean = diff.iter().map(|d| *d as f64).sum::<f64>() / diff.len() as f64;
            assert!(max <= 2 && mean < 0.01, "t={t}: clipped passes differ (max {max}, mean {mean:.4})");
        }
    });
}

/// A frame identical to the last one is not drawn again (its pixels come back), and anything it
/// depends on (an asset, a setting) draws the next one in full.
#[test]
fn identical_frames_are_not_drawn_twice() {
    pollster::block_on(async {
        let mut r = Renderer::new_headless(540, 960).await.expect("a GPU adapter");
        let still = Scene::from_json(r##"{"width":540,"height":960,"fps":30,"duration":2,"layers":[{"id":"bg","type":"shape","shape":"rect","x":270,"y":480,"w":540,"h":960,"fill":"#202833"},{"id":"dot","type":"shape","shape":"ellipse","x":270,"y":480,"w":200,"h":200,"fill":"#f2c14e","effects":[{"fx":"glow","radius":60,"strength":1},{"fx":"blur","radius":20}]}]}"##).unwrap();
        let first = r.render_rgba(&still, 0.0);
        let t0 = std::time::Instant::now();
        let again = r.render_rgba(&still, 1.0);
        let reused = t0.elapsed();
        assert_eq!(first, again, "a still scene at another time is the same picture");
        r.set_clip_effects(true);
        let t1 = std::time::Instant::now();
        let redrawn = r.render_rgba(&still, 1.0);
        let full = t1.elapsed();
        assert_eq!(first, redrawn);
        assert!(reused < full, "the reused frame skipped the GPU ({reused:?} vs {full:?})");
        // Something that changes the picture: the next frame is drawn, not reused.
        let moving = Scene::from_json(r##"{"width":540,"height":960,"fps":30,"duration":2,"layers":[{"id":"dot","type":"shape","shape":"ellipse","x":[{"t":0,"v":100},{"t":2,"v":440}],"y":480,"w":200,"h":200,"fill":"#f2c14e"}]}"##).unwrap();
        assert_ne!(r.render_rgba(&moving, 0.0), r.render_rgba(&moving, 1.0));
    });
}
