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
    assets.load_into(&mut renderer);
    for src in scene.video_sources() {
        if let Ok(p) = clips.open(&src) {
            scene::video::set_media_duration(&src, p.duration as f32);
        }
    }

    let mut encoder = Encoder::start(tools, &out, size, scene.fps as f32, req.codec, audio)?;
    let frames = ((scene.duration * scene.fps as f32).round() as u32).max(1);
    for i in 0..frames {
        if cancel.load(Ordering::Relaxed) {
            encoder.cancel();
            let _ = std::fs::remove_file(&out);
            return Err("cancelled".into());
        }
        let t = i as f32 / scene.fps as f32;
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
