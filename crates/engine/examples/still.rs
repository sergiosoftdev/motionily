//! Render one frame of a scene file to PNG, no window needed:
//! `cargo run -p engine --example still -- scene.json 2.5 out.png [supersample 1|2]`
//! Fonts come from apps/web/public/fonts (the same bundled files the web app uses).

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

/// Bundled families and weights, mirroring apps/web/src/engine/fonts.ts.
const FONTS: &[(&str, u16, &str)] = &[
    ("Inter", 500, "Inter-500.ttf"),
    ("Inter", 700, "Inter-700.ttf"),
    ("Space Grotesk", 500, "SpaceGrotesk-500.ttf"),
    ("Space Grotesk", 700, "SpaceGrotesk-700.ttf"),
    ("Plus Jakarta Sans", 500, "PlusJakartaSans-500.ttf"),
    ("Plus Jakarta Sans", 700, "PlusJakartaSans-700.ttf"),
    ("Fraunces", 500, "Fraunces-500.ttf"),
    ("Fraunces", 700, "Fraunces-700.ttf"),
    ("Baloo 2", 800, "Baloo2-800.ttf"),
    ("Dela Gothic One", 400, "DelaGothicOne-400.ttf"),
];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: still <scene.json> <time_seconds> <out.png> [supersample 1|2]");
        std::process::exit(2);
    }
    let json = std::fs::read_to_string(&args[1]).expect("read scene");
    let scene = scene::Scene::from_json(&json).expect("parse scene");
    let t: f32 = args[2].parse().expect("time in seconds");
    let fonts_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/public/fonts");

    let pixels = pollster::block_on(async {
        let mut renderer = engine::Renderer::new_headless(scene.width, scene.height).await.expect("gpu adapter");
        renderer.set_supersample(args.get(4).map_or(1, |s| s.parse().expect("supersample 1 or 2")));
        for (family, weight, file) in FONTS {
            let bytes = std::fs::read(fonts_dir.join(file)).expect("read font");
            renderer.add_font(family, *weight, &bytes).expect("register font");
        }
        load_media(&mut renderer, &json, &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/api/uploads"));
        for (id, why) in renderer.shader_failures(&scene) {
            eprintln!("shader on '{id}' draws nothing: {why}");
        }
        renderer.render_rgba(&scene, t)
    });

    let mut encoder = png::Encoder::new(BufWriter::new(File::create(&args[3]).expect("create png")), scene.width, scene.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().expect("png header").write_image_data(&pixels).expect("png data");
    println!("{} ({}x{}, t={t}s)", args[3], scene.width, scene.height);
}

/// Image layers name their file as `/media/<name>`; the web host decodes those from the API's upload folder
/// and registers them under that key. The still renderer does the same, so logos show up in a headless frame.
fn load_media(renderer: &mut engine::Renderer, json: &str, uploads: &Path) {
    let mut rest = json;
    while let Some(at) = rest.find("\"/media/") {
        let tail = &rest[at + 1..];
        let end = tail.find('"').expect("closing quote of media src");
        let src = &tail[..end];
        rest = &tail[end..];
        if renderer.has_image(src) {
            continue;
        }
        let file = uploads.join(src.trim_start_matches("/media/"));
        let mut reader = png::Decoder::new(File::open(&file).expect("open media")).read_info().expect("png header");
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).expect("png frame");
        let rgba: Vec<u8> = match info.color_type {
            png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
            png::ColorType::Rgb => buf[..info.buffer_size()].chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
            other => panic!("media {src}: unsupported PNG color {other:?}"),
        };
        renderer.add_image(src, &rgba, info.width, info.height);
    }
}
