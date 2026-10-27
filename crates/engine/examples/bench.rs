//! Render benchmarks on the native renderer, no window needed:
//! `cargo run -p engine --release --example bench -- [--frames N] [--size WxH] [--json out.json] [--baseline old.json]`
//!
//! Each scene renders `frames` frames spread over its length; a frame's time is the whole render
//! including the GPU finishing it (the pixels read back), so the numbers are what playback and export
//! wait for. Synthetic stress scenes (many texts, many shapes, stacked effects) plus the example scenes
//! of the repo. With `--baseline`, it fails when a scene's median got more than 25% slower.

use std::path::Path;
use std::time::Instant;

use serde_json::{json, Value};

/// Bundled fonts the scenes use (as in the still example).
const FONTS: &[(&str, u16, &str)] = &[("Inter", 500, "Inter-500.ttf"), ("Inter", 700, "Inter-700.ttf"), ("Fraunces", 700, "Fraunces-700.ttf")];
/// A scene's median may grow this much over the baseline before the run fails.
const REGRESSION: f64 = 1.25;
const WARMUP: usize = 3;

fn keys(a: f64, b: f64, d: f64) -> Value {
    json!([{ "t": 0, "v": a, "ease": "ease_in_out" }, { "t": d, "v": b }])
}

/// 200 animated texts, a fifth of them animated per character.
fn texts() -> Value {
    let layers: Vec<Value> = (0..200)
        .map(|i| {
            let (x, y) = (60.0 + (i % 10) as f64 * 100.0, 120.0 + (i / 10) as f64 * 88.0);
            let mut l = json!({ "id": format!("t{i}"), "type": "text", "text": format!("Line {i} moves"), "x": keys(x, x + 40.0, 6.0), "y": y, "size": 34, "fill": "text", "rotation": keys(0.0, 8.0, 6.0) });
            if i % 5 == 0 {
                l["animate"] = json!({ "by": "char", "stagger": 0.02, "duration": 0.5, "from": { "y": 30, "opacity": 0, "blur": 8 } });
            }
            l
        })
        .collect();
    json!({ "width": 1080, "height": 1920, "fps": 30, "duration": 6, "layers": layers })
}

/// 800 moving shapes with animated fills.
fn shapes() -> Value {
    let layers: Vec<Value> = (0..800)
        .map(|i| {
            let (x, y) = ((i * 37 % 1080) as f64, (i * 91 % 1920) as f64);
            json!({
                "id": format!("s{i}"), "type": "shape", "shape": if i % 2 == 0 { "rect" } else { "ellipse" },
                "x": keys(x, 1080.0 - x, 6.0), "y": keys(y, y + 200.0, 6.0), "w": 60, "h": 60, "radius": 12,
                "rotation": keys(0.0, 360.0, 6.0),
                "fill": [{ "t": 0, "c": "#e5484d" }, { "t": 6, "c": "#3d7bff" }]
            })
        })
        .collect();
    json!({ "width": 1080, "height": 1920, "fps": 30, "duration": 6, "layers": layers })
}

/// 40 layers each with glow, blur and a shadow, under three full-frame color grades.
fn effects() -> Value {
    let mut layers: Vec<Value> = vec![json!({ "id": "bg", "type": "shape", "shape": "rect", "x": 540, "y": 960, "w": 1080, "h": 1920, "fill": "#141414" })];
    for i in 0..40 {
        let (x, y) = (140.0 + (i % 5) as f64 * 200.0, 200.0 + (i / 5) as f64 * 210.0);
        layers.push(json!({
            "id": format!("e{i}"), "type": "shape", "shape": "ellipse", "x": keys(x, x + 60.0, 6.0), "y": y, "w": 140, "h": 140, "fill": "#f2c14e",
            "effects": [{ "fx": "shadow", "x": 0, "y": 12, "blur": 30, "color": "#000000", "opacity": 0.5 }, { "fx": "glow", "radius": 40, "strength": 1 }, { "fx": "blur", "radius": 6 }]
        }));
    }
    for i in 0..3 {
        layers.push(json!({ "id": format!("grade{i}"), "type": "shape", "shape": "rect", "adjustment": true, "x": 540, "y": 960, "w": 1080, "h": 1920, "fill": "#ffffff", "effects": [{ "fx": "color", "exposure": 0.1, "contrast": 1.05, "saturation": 1.1, "vignette": 0.2 }] }));
    }
    json!({ "width": 1080, "height": 1920, "fps": 30, "duration": 6, "layers": layers })
}

struct Result {
    name: String,
    p50: f64,
    p95: f64,
    max: f64,
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let frames: usize = arg("--frames").map_or(40, |v| v.parse().expect("--frames N"));
    let size = arg("--size").map(|v| {
        let (w, h) = v.split_once('x').expect("--size WxH");
        (w.parse::<u32>().expect("width"), h.parse::<u32>().expect("height"))
    });
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");

    let mut scenes: Vec<(String, String)> = vec![("texts_200".into(), texts().to_string()), ("shapes_800".into(), shapes().to_string()), ("effects_40".into(), effects().to_string())];
    for entry in std::fs::read_dir(root.join("examples")).expect("examples dir") {
        let path = entry.expect("entry").path();
        if path.extension().is_some_and(|e| e == "json") {
            let name = path.file_name().unwrap().to_string_lossy().replace(".scene.json", "");
            scenes.push((name, std::fs::read_to_string(&path).expect("read example")));
        }
    }
    scenes.sort_by(|a, b| a.0.cmp(&b.0));

    // `--export scene.json`: every frame in order, as an export renders it, with and without reusing
    // frames identical to the last one.
    if let Some(path) = arg("--export") {
        let json = std::fs::read_to_string(&path).expect("read scene");
        let scene = scene::Scene::from_json(&json).expect("parse scene");
        let frames = (scene.duration * scene.fps).round() as usize;
        pollster::block_on(async {
            let (w, h) = size.unwrap_or((scene.width, scene.height));
            let mut renderer = engine::Renderer::new_headless(w, h).await.expect("gpu adapter");
            for reuse in [false, true] {
                let start = Instant::now();
                for i in 0..frames {
                    if !reuse {
                        renderer.invalidate_frame();
                    }
                    renderer.render_rgba(&scene, i as f32 / scene.fps);
                }
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                println!("{path}: {frames} frames {}: {ms:.0} ms ({:.2} ms/frame)", if reuse { "reusing identical frames" } else { "all drawn" }, ms / frames as f64);
            }
        });
        return;
    }

    let results: Vec<Result> = pollster::block_on(async {
        let mut out = Vec::new();
        for (name, json) in &scenes {
            let scene = scene::Scene::from_json(json).unwrap_or_else(|e| panic!("scene {name}: {e}"));
            let (w, h) = size.unwrap_or((scene.width, scene.height));
            let mut renderer = engine::Renderer::new_headless(w, h).await.expect("gpu adapter");
            for (family, weight, file) in FONTS {
                let bytes = std::fs::read(root.join("apps/web/public/fonts").join(file)).expect("read font");
                renderer.add_font(family, *weight, &bytes).expect("register font");
            }
            let mut times = Vec::with_capacity(frames);
            for i in 0..frames + WARMUP {
                let t = scene.duration * (i % frames) as f32 / frames as f32;
                let start = Instant::now();
                let px = renderer.render_rgba(&scene, t);
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                assert!(!px.is_empty(), "{name}: no pixels");
                if i >= WARMUP {
                    times.push(ms);
                }
            }
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            out.push(Result { name: format!("{name} @{w}x{h}"), p50: percentile(&times, 0.5), p95: percentile(&times, 0.95), max: *times.last().unwrap() });
        }
        out
    });

    println!("{:<32} {:>9} {:>9} {:>9} {:>8}", "scene", "p50 ms", "p95 ms", "max ms", "fps@p50");
    for r in &results {
        println!("{:<32} {:>9.2} {:>9.2} {:>9.2} {:>8.0}", r.name, r.p50, r.p95, r.max, 1000.0 / r.p50);
    }
    let report = json!(results.iter().map(|r| json!({ "scene": r.name, "p50": r.p50, "p95": r.p95, "max": r.max })).collect::<Vec<_>>());
    if let Some(path) = arg("--json") {
        std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).expect("write json");
    }
    if let Some(path) = arg("--baseline") {
        let base: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&path).expect("read baseline")).expect("baseline json");
        let mut slower = Vec::new();
        for r in &results {
            if let Some(b) = base.iter().find(|b| b["scene"] == r.name).and_then(|b| b["p50"].as_f64()) {
                if r.p50 > b * REGRESSION {
                    slower.push(format!("{} {:.2} ms → {:.2} ms", r.name, b, r.p50));
                }
            }
        }
        if !slower.is_empty() {
            eprintln!("slower than the baseline (> {:.0}%):\n  {}", (REGRESSION - 1.0) * 100.0, slower.join("\n  "));
            std::process::exit(1);
        }
    }
}
