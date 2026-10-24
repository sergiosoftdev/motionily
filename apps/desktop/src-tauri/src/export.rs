//! Native export: the scene rendered frame by frame on the GPU at full size (up to 4K) and encoded
//! by ffmpeg (H.264, HEVC 10-bit or ProRes), with the editor's audio mix muxed in.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::assets::Assets;
use crate::ffmpeg::{Clips, Codec, Encoder, Tools};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub scene_json: String,
    /// Output height for vertical/square videos, width for horizontal ones: 720, 1080, 1440 or 2160.
    pub short_side: u32,
    pub codec: Codec,
    /// Only `[in, out]` seconds of the video (its frames are timestamped from 0).
    #[serde(default)]
    pub range: Option<[f32; 2]>,
    /// Draw at 2x and average down: cleaner edges, slower.
    #[serde(default)]
    pub supersample: bool,
    /// Where to write; the Movies folder with the video's name when omitted.
    pub path: Option<PathBuf>,
    pub name: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub frame: u32,
    pub frames: u32,
}

/// Renders and encodes the whole video; `progress` is called after every frame and `cancel` is
/// checked before each one. Returns the written file.
pub fn export(
    req: ExportRequest,
    out: PathBuf,
    assets: &Assets,
    audio: Option<&Path>,
    tools: &Tools,
    clips: &mut Clips,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(Progress),
) -> Result<PathBuf, String> {
    let scene = scene::Scene::from_json(&req.scene_json).map_err(|e| e.to_string())?;
    let k = req.short_side as f32 / scene.width.min(scene.height).max(1) as f32;
    // Encoders want even dimensions.
    let even = |v: u32| ((v as f32 * k / 2.0).round() as u32 * 2).max(2);
    let size = (even(scene.width), even(scene.height));

    let mut renderer = pollster::block_on(engine::Renderer::new_headless(size.0, size.1)).map_err(|e| e.to_string())?;
    if req.supersample {
        renderer.set_supersample(2);
    }
    renderer.set_transparent(req.codec.has_alpha());
    assets.load_into(&mut renderer);
    for src in scene.video_sources() {
        if let Ok(p) = clips.open(&src) {
            scene::video::set_media_duration(&src, p.duration as f32);
        }
    }

    let mut encoder = Encoder::start(tools, &out, size, scene.fps as f32, req.codec, audio)?;
    let (from, to) = match req.range {
        Some([a, b]) => (a.max(0.0), b.min(scene.duration)),
        None => (0.0, scene.duration),
    };
    if to <= from {
        return Err("the export range is empty".into());
    }
    let frames = (((to - from) * scene.fps as f32).round() as u32).max(1);
    for i in 0..frames {
        if cancel.load(Ordering::Relaxed) {
            encoder.cancel();
            let _ = std::fs::remove_file(&out);
            return Err("cancelled".into());
        }
        let t = from + i as f32 / scene.fps as f32;
        let needs = scene.video_frames(t);
        for need in &needs {
            let (px, (w, h)) = clips.frame(&need.src, need.time as f64)?;
            renderer.add_video_frame(&need.key, px, w, h);
        }
        renderer.retain_video_frames(&needs.iter().map(|n| n.key.clone()).collect::<Vec<_>>());
        let rgba = renderer.render_rgba(&scene, t);
        encoder.frame(&rgba)?;
        progress(Progress { frame: i + 1, frames });
    }
    encoder.finish()?;
    Ok(out)
}

/// `<Movies>/Motionily/<name>.<ext>`, numbered when the name is taken.
pub fn default_path(movies: &Path, name: &str, codec: Codec) -> PathBuf {
    let dir = movies.join("Motionily");
    let _ = std::fs::create_dir_all(&dir);
    let clean: String = name.chars().map(|c| if c.is_alphanumeric() || " -_".contains(c) { c } else { '-' }).collect();
    let base = if clean.trim().is_empty() { "Motionily video".to_string() } else { clean.trim().to_string() };
    let mut path = dir.join(format!("{base}.{}", codec.extension()));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} {n}.{}", codec.extension()));
        n += 1;
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::Probe;

    /// Bundled fonts the web editor ships (apps/web/public/fonts), enough for the example scenes.
    fn fonts() -> Assets {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/public/fonts");
        let mut a = Assets::default();
        for (family, weight, file) in [("Inter", 500, "Inter-500.ttf"), ("Inter", 700, "Inter-700.ttf"), ("Space Grotesk", 700, "SpaceGrotesk-700.ttf"), ("Plus Jakarta Sans", 700, "PlusJakartaSans-700.ttf")] {
            if let Ok(bytes) = std::fs::read(dir.join(file)) {
                a.add(crate::assets::AssetKind::Font, family, bytes, weight, 0);
            }
        }
        a
    }

    /// With an alpha codec, what the scene does not draw comes out transparent (the palette background is left out).
    #[test]
    fn alpha_codecs_keep_the_frame_transparent() {
        let tools = Tools::find(None);
        if std::process::Command::new(&tools.ffmpeg).arg("-version").output().is_err() {
            return;
        }
        let scene = r##"{"width":720,"height":720,"fps":30,"duration":0.5,"layers":[{"id":"dot","type":"shape","shape":"rect","x":360,"y":360,"w":200,"h":200,"fill":"#ff0000"}]}"##;
        let dir = std::env::temp_dir().join("motionily-alpha-test");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("alpha.mov");
        let req = ExportRequest { scene_json: scene.into(), short_side: 720, codec: Codec::Prores4444, range: None, supersample: false, path: None, name: None };
        let mut clips = Clips::new(tools.clone(), Box::new(|s: &str| s.to_string()));
        let file = export(req, out, &Assets::default(), None, &tools, &mut clips, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        // First frame back as RGBA: corner pixel and center pixel.
        let px = std::process::Command::new(&tools.ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(&file)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
            .output()
            .unwrap()
            .stdout;
        assert_eq!(px.len(), 720 * 720 * 4);
        let at = |x: usize, y: usize| &px[(y * 720 + x) * 4..(y * 720 + x) * 4 + 4];
        assert!(at(5, 5)[3] < 8, "corner is transparent: {:?}", at(5, 5));
        let c = at(360, 360);
        assert!(c[3] > 240 && c[0] > 200 && c[1] < 40, "center is opaque red: {c:?}");
    }

    /// One second of the demo scene through every codec, checked with ffprobe. Skips without ffmpeg.
    #[test]
    fn exports_every_codec() {
        let tools = Tools::find(None);
        if std::process::Command::new(&tools.ffmpeg).arg("-version").output().is_err() {
            eprintln!("ffmpeg not found: skipped");
            return;
        }
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/demo.scene.json");
        let mut scene: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        scene["duration"] = 1.0.into();
        let fps = scene["fps"].as_f64().unwrap_or(30.0);
        let dir = std::env::temp_dir().join("motionily-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        for codec in [Codec::H264, Codec::Hevc, Codec::Prores, Codec::Prores4444, Codec::Vp9Alpha] {
            let out = dir.join(format!("demo.{}", codec.extension()));
            let req = ExportRequest { scene_json: scene.to_string(), short_side: 720, codec, range: None, supersample: false, path: None, name: None };
            let mut clips = Clips::new(tools.clone(), Box::new(|s: &str| s.to_string()));
            let mut last = None;
            let file = export(req, out, &fonts(), None, &tools, &mut clips, Arc::new(AtomicBool::new(false)), |p| last = Some(p)).unwrap();
            let p: Probe = tools.probe(&file.display().to_string()).unwrap();
            assert_eq!(p.width.min(p.height), 720, "{codec:?} size {}x{}", p.width, p.height);
            assert!((p.duration - 1.0).abs() < 0.1, "{codec:?} lasts {}", p.duration);
            let last = last.unwrap();
            assert_eq!(last.frame, last.frames);
            assert_eq!(last.frames as f64, fps);
        }
    }
}
