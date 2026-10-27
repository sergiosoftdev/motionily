//! The keyer: chroma keys a green screen out (and takes its spill out of what stays), luma keys the
//! dark end out; `invert` keeps what would go.

use engine::Renderer;
use scene::Scene;

/// A red background and, over it, four 100 px squares in a row (x 50, 150, 250, 350) with one effect.
fn scene(fills: [&str; 4], key: &str) -> Scene {
    let squares: Vec<String> = fills
        .iter()
        .enumerate()
        .map(|(i, f)| format!(r##"{{"id":"s{i}","type":"shape","shape":"rect","x":{},"y":50,"w":100,"h":100,"fill":"{f}","effects":[{key}]}}"##, 50 + i * 100))
        .collect();
    let json = format!(r##"{{"width":400,"height":100,"fps":30,"duration":1,"layers":[{{"id":"bg","type":"shape","shape":"rect","x":200,"y":50,"w":400,"h":100,"fill":"#ff0000"}},{}]}}"##, squares.join(","));
    Scene::from_json(&json).expect("scene parses")
}

fn px(rgba: &[u8], x: usize) -> [u8; 3] {
    let i = (50 * 400 + x) * 4;
    [rgba[i], rgba[i + 1], rgba[i + 2]]
}

#[test]
fn chroma_and_luma_keys() {
    pollster::block_on(async {
        let mut r = Renderer::new_headless(400, 100).await.expect("a GPU adapter");
        let chroma = r.render_rgba(&scene(["#00ff00", "#2050ff", "#7fbf7f", "#ffffff"], r##"{"fx":"key","color":"#00ff00","tolerance":0.2,"softness":0.05,"spill":1}"##), 0.0);
        let [r0, g0, _] = px(&chroma, 50);
        assert!(r0 > 230 && g0 < 30, "the green square is keyed out: the red background shows ({:?})", px(&chroma, 50));
        let [_, _, b1] = px(&chroma, 150);
        assert!(b1 > 200, "blue stays ({:?})", px(&chroma, 150));
        let [r2, g2, b2] = px(&chroma, 250);
        assert!((g2 as i32 - r2.max(b2) as i32) < 25, "a greenish grey loses its green spill ({:?})", px(&chroma, 250));
        assert_eq!(px(&chroma, 350), [255, 255, 255], "white stays white");

        let luma = r.render_rgba(&scene(["#000000", "#ffffff", "#101010", "#c0c0c0"], r##"{"fx":"key","mode":"luma","tolerance":0.15,"softness":0.05}"##), 0.0);
        assert!(px(&luma, 50)[0] > 230 && px(&luma, 50)[1] < 30, "black is keyed out ({:?})", px(&luma, 50));
        assert_eq!(px(&luma, 150), [255, 255, 255], "white stays");
        assert!(px(&luma, 250)[1] < 30, "near black goes too ({:?})", px(&luma, 250));

        let inverted = r.render_rgba(&scene(["#000000", "#ffffff", "#000000", "#ffffff"], r##"{"fx":"key","mode":"luma","tolerance":0.15,"softness":0.05,"invert":true}"##), 0.0);
        assert_eq!(px(&inverted, 50), [0, 0, 0], "inverted: black stays");
        assert!(px(&inverted, 150)[1] < 30, "inverted: white goes ({:?})", px(&inverted, 150));
    });
}
