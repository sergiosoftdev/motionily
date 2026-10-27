//! Browser bindings. The API is deliberately coarse (load, apply ops, render)
//! so JS <-> WASM crossings stay few and cheap.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use engine::Renderer;
use scene::{CaptionStyle, Op, Scene, StylePreset};
use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, OffscreenCanvas, VideoFrame};

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct Engine {
    renderer: Renderer,
    scene: Scene,
    /// GPU completions counted as they come back, and how many were asked for (see `watchWork`).
    work_done: Arc<AtomicU32>,
    work_asked: u32,
}

#[wasm_bindgen]
impl Engine {
    /// Create the engine on a canvas. Uses WebGPU when available, WebGL2 otherwise.
    pub async fn create(canvas: HtmlCanvasElement) -> Result<Engine, JsError> {
        let (w, h) = (canvas.width(), canvas.height());
        Self::on(wgpu::SurfaceTarget::Canvas(canvas), w, h).await
    }

    /// Create the engine on an `OffscreenCanvas` (in a worker: the playback viewer draws off the main thread).
    #[wasm_bindgen(js_name = createOffscreen)]
    pub async fn create_offscreen(canvas: OffscreenCanvas) -> Result<Engine, JsError> {
        let (w, h) = (canvas.width(), canvas.height());
        Self::on(wgpu::SurfaceTarget::OffscreenCanvas(canvas), w, h).await
    }

    async fn on(target: wgpu::SurfaceTarget<'static>, w: u32, h: u32) -> Result<Engine, JsError> {
        let instance = wgpu::util::new_instance_with_webgpu_detection(wgpu::InstanceDescriptor::new_without_display_handle()).await;
        let surface = instance.create_surface(target).map_err(|e| JsError::new(&e.to_string()))?;
        let renderer = Renderer::new(&instance, surface, w, h)
            .await
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Engine { renderer, scene: Scene::default(), work_done: Arc::new(AtomicU32::new(0)), work_asked: 0 })
    }

    #[wasm_bindgen(js_name = adapterInfo)]
    pub fn adapter_info(&self) -> String {
        self.renderer.adapter_info.clone()
    }

    #[wasm_bindgen(js_name = loadScene)]
    pub fn load_scene(&mut self, json: &str) -> Result<(), JsError> {
        self.scene = Scene::from_json(json).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(())
    }

    /// Apply a JSON array of ops atomically. Errors name the failing op index.
    #[wasm_bindgen(js_name = applyOps)]
    pub fn apply_ops(&mut self, json: &str) -> Result<(), JsError> {
        let ops = Op::parse_list(json).map_err(|e| JsError::new(&e))?;
        self.scene
            .apply(&ops)
            .map_err(|(i, e)| JsError::new(&format!("op #{i}: {e}")))
    }

    #[wasm_bindgen(js_name = sceneJson)]
    pub fn scene_json(&self) -> String {
        self.scene.to_json()
    }

    pub fn summary(&self) -> String {
        self.scene.summary()
    }

    /// Layer id under scene point (x, y) at time t, or undefined.
    pub fn pick(&self, t: f32, x: f32, y: f32) -> Option<String> {
        self.scene.pick(t, x, y)
    }

    /// JSON `[{id, cover}]` of every layer under scene point (x, y) at time t, front to back.
    #[wasm_bindgen(js_name = pickStack)]
    pub fn pick_stack(&self, t: f32, x: f32, y: f32) -> String {
        serde_json::to_string(&self.scene.pick_stack(t, x, y)).expect("hits always serialize")
    }

    /// `[cx, cy, w, h, rotation]` of a layer at time t in scene pixels, or undefined.
    #[wasm_bindgen(js_name = layerBounds)]
    pub fn layer_bounds(&self, id: &str, t: f32) -> Option<Vec<f32>> {
        self.scene
            .layer_bounds(id, t)
            .map(|b| vec![b.center[0], b.center[1], b.size[0], b.size[1], b.rotation])
    }

    /// `[x0, y0, x1, y1]` the glyphs of a text layer really cover at time t, or undefined.
    #[wasm_bindgen(js_name = textInk)]
    pub fn text_ink(&mut self, id: &str, t: f32) -> Option<Vec<f32>> {
        self.renderer.text_ink(&self.scene, id, t).map(|b| b.to_vec())
    }

    /// JSON of `Scene::layout` at time t (where every layer lands on screen), with text rows
    /// narrowed to their glyph ink and marked `ink: true`.
    pub fn layout(&mut self, t: f32) -> String {
        let layout = self.scene.layout(t);
        let mut json = serde_json::to_value(&layout).expect("layout always serializes");
        if let Some(rows) = json.get_mut("layers").and_then(|l| l.as_array_mut()) {
            for row in rows.iter_mut() {
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                // Also layers inside component instances (`card1/title`).
                let is_text = self.scene.resolve_layer(&id).is_some_and(|l| matches!(l.content, scene::LayerContent::Text { .. }));
                if let Some(ink) = is_text.then(|| self.renderer.text_ink(&self.scene, &id, t)).flatten() {
                    row["screen"] = serde_json::json!(ink);
                    row["ink"] = serde_json::Value::Bool(true);
                }
            }
            // Video rows say which second of the file is on screen.
            let clips = self.scene.video_clips(t);
            for row in rows.iter_mut() {
                if let Some(c) = clips.iter().find(|c| row["id"].as_str() == Some(c.id.as_str())) {
                    row["video"] = serde_json::json!({ "src": c.src, "at": (c.time * 1000.0).round() / 1000.0 });
                }
            }
        }
        json.to_string()
    }

    /// JSON `{prop: value}` of a layer's animatable numbers at scene time t, or undefined.
    #[wasm_bindgen(js_name = propValues)]
    pub fn prop_values(&self, id: &str, t: f32) -> Option<String> {
        self.scene.prop_values(id, t).map(|v| serde_json::to_string(&v).expect("numbers always serialize"))
    }

    /// A layer prop (`set_prop` name) sampled by the engine at each scene time (keys, bezier,
    /// formulas, time remap; no parents), or undefined for an unknown layer or prop.
    #[wasm_bindgen(js_name = sampleProp)]
    pub fn sample_prop(&self, id: &str, prop: &str, times: &[f32]) -> Option<Vec<f32>> {
        let prop: scene::Prop = serde_json::from_value(serde_json::Value::String(prop.to_owned())).ok()?;
        self.scene.sample_prop(id, prop, times)
    }

    #[wasm_bindgen(js_name = layerJson)]
    pub fn layer_json(&self, id: &str) -> Option<String> {
        self.scene.layer_json(id)
    }

    /// JSON array of every layer, each component instance followed by its layers (ids
    /// `instance/layer`, start/end in scene seconds): what reviews walk.
    #[wasm_bindgen(js_name = flatLayers)]
    pub fn flat_layers(&self) -> String {
        self.scene.flat_layers_json()
    }

    /// Every image source the scene draws, also inside component instances.
    #[wasm_bindgen(js_name = imageSources)]
    pub fn image_sources(&self) -> Vec<String> {
        self.scene.image_sources()
    }

    pub fn duration(&self) -> f32 {
        self.scene.duration
    }

    /// The Edit timeline for another editor (`format` "fcpxml" | "otio" | "edl"); `media_root` replaces
    /// `/media/` in sources, `voice_src` is the voice-over file (it lives outside the scene).
    #[wasm_bindgen(js_name = timelineFile)]
    pub fn timeline_file(&self, format: &str, name: &str, media_root: &str, voice_src: Option<String>) -> Result<String, JsError> {
        use scene::interchange::{TimelineFormat, Voice};
        let format = match format {
            "fcpxml" => TimelineFormat::Fcpxml,
            "otio" => TimelineFormat::Otio,
            "edl" => TimelineFormat::Edl,
            other => return Err(JsError::new(&format!("unknown timeline format {other}"))),
        };
        let voice = voice_src.as_deref().map(|src| Voice { src });
        Ok(self.scene.timeline_file(format, name, media_root, voice.as_ref()))
    }

    /// The captions as a subtitle file (`format` "srt" | "vtt"), cue by cue as on screen; empty
    /// without captions. `from`/`to` keep only an exported range, timed from its start.
    pub fn subtitles(&self, format: &str, from: Option<f32>, to: Option<f32>) -> Result<String, JsError> {
        let format: scene::subtitles::SubtitleFormat = serde_json::from_value(serde_json::Value::String(format.into())).map_err(|e| JsError::new(&e.to_string()))?;
        let range = from.zip(to).map(|(a, b)| [a, b]);
        Ok(self.scene.captions.as_ref().map(|c| c.subtitles(format, range)).unwrap_or_default())
    }

    /// Register a GLB model for the 3D stage.
    #[wasm_bindgen(js_name = addModel)]
    pub fn add_model(&mut self, key: &str, bytes: &[u8]) -> Result<(), JsError> {
        self.renderer.add_model(key, bytes).map_err(|e| JsError::new(&e))
    }

    /// Register a decoded texture (RGBA8 pixels): a model pack's shared one ("characters") or a
    /// model image by its key from `missingTextures`.
    #[wasm_bindgen(js_name = addTexture)]
    pub fn add_texture(&mut self, key: &str, rgba: &[u8], width: u32, height: u32) {
        self.renderer.add_texture(key, rgba, width, height);
    }

    /// Image keys loaded models need that no texture answers yet: `dir/file.png` (fetch it from
    /// /models/<key>) or `model#index` (decode `embeddedTexture(key)`).
    #[wasm_bindgen(js_name = missingTextures)]
    pub fn missing_textures(&self) -> Vec<String> {
        self.renderer.missing_textures()
    }

    /// PNG/JPEG bytes of an image packed inside a model, or undefined.
    #[wasm_bindgen(js_name = embeddedTexture)]
    pub fn embedded_texture(&self, key: &str) -> Option<Vec<u8>> {
        self.renderer.embedded_texture(key).map(<[u8]>::to_vec)
    }

    /// Every texture key registered so far (to give another engine the same textures).
    #[wasm_bindgen(js_name = textureKeys)]
    pub fn texture_keys(&self) -> Vec<String> {
        self.renderer.texture_keys()
    }

    /// Every glTF model key the scene uses: stage props, procedural trees (props, prefabs,
    /// object layers).
    #[wasm_bindgen(js_name = modelKeys)]
    pub fn model_keys(&self) -> Vec<String> {
        let stage = self.scene.stage.iter().flat_map(|s| &s.props);
        let mut keys: Vec<String> = stage
            .flat_map(|p| std::iter::once(p.model.clone()).chain(p.node.iter().flat_map(model_keys)))
            .chain(self.scene.library.prefabs.values().flat_map(model_keys))
            .chain(self.scene.layers.iter().filter_map(|l| match &l.content {
                scene::LayerContent::Object { node, .. } => Some(model_keys(node)),
                _ => None,
            }).flatten())
            .filter(|k| !k.is_empty())
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }

    /// Register a decoded image (RGBA8) for image layers.
    #[wasm_bindgen(js_name = addImage)]
    pub fn add_image(&mut self, key: &str, rgba: &[u8], width: u32, height: u32) {
        self.renderer.add_image(key, rgba, width, height);
    }

    /// Load a `.cube` LUT a color effect names by `src` (errors say what is wrong with the file).
    #[wasm_bindgen(js_name = addLut)]
    pub fn add_lut(&mut self, src: &str, cube: &str) -> Result<(), JsError> {
        self.renderer.add_lut(src, cube).map_err(|e| JsError::new(&e))
    }

    /// LUTs the color effects use (loaded or not).
    #[wasm_bindgen(js_name = lutSources)]
    pub fn lut_sources(&self) -> Vec<String> {
        self.scene.lut_sources()
    }

    /// LUTs the color effects use that are not loaded yet.
    #[wasm_bindgen(js_name = missingLuts)]
    pub fn missing_luts(&self) -> Vec<String> {
        self.scene.lut_sources().into_iter().filter(|s| !self.renderer.has_lut(s)).collect()
    }

    /// Image sources the layers use that are not loaded yet.
    #[wasm_bindgen(js_name = missingImages)]
    pub fn missing_images(&self) -> Vec<String> {
        self.scene.image_sources().into_iter().filter(|s| !self.renderer.has_image(s)).collect()
    }

    // --- video layers (see scene::video) ---

    /// Video files the layers use (for the host to open).
    #[wasm_bindgen(js_name = videoSources)]
    pub fn video_sources(&self) -> Vec<String> {
        self.scene.video_sources()
    }

    /// JSON `[{key, src, time}]`: every decoded frame a render at `t` draws. Upload each with
    /// `setVideoFrame(key, …)` (the frame of `src` shown at file second `time`) before `render(t)`.
    #[wasm_bindgen(js_name = videoFrames)]
    pub fn video_frames(&self, t: f32) -> String {
        serde_json::to_string(&self.scene.video_frames(t)).expect("frames serialize")
    }

    /// JSON `[{id, src, time, rate, volume}]`: what each active video layer plays at `t`.
    #[wasm_bindgen(js_name = videoClips)]
    pub fn video_clips(&self, t: f32) -> String {
        serde_json::to_string(&self.scene.video_clips(t)).expect("clips serialize")
    }

    /// Store a decoded frame drawn into `canvas` under `key` (GPU copy; works on WebGPU and WebGL2).
    #[wasm_bindgen(js_name = setVideoFrame)]
    pub fn set_video_frame(&mut self, key: &str, canvas: &HtmlCanvasElement) {
        let source = wgpu::CopyExternalImageSourceInfo {
            source: wgpu::ExternalImageSource::HTMLCanvasElement(canvas.clone()),
            origin: wgpu::Origin2d::ZERO,
            flip_y: false,
        };
        self.renderer.copy_video_frame(key, &source);
    }

    /// Store a decoder's frame under `key` without drawing it anywhere first: the browser copies it
    /// GPU to GPU (converting from YUV). WebGPU only; on WebGL2 draw it into a canvas and use `setVideoFrame`.
    #[wasm_bindgen(js_name = setVideoFrameFrom)]
    pub fn set_video_frame_from(&mut self, key: &str, frame: VideoFrame) {
        let source = wgpu::CopyExternalImageSourceInfo {
            source: wgpu::ExternalImageSource::VideoFrame(frame),
            origin: wgpu::Origin2d::ZERO,
            flip_y: false,
        };
        self.renderer.copy_video_frame(key, &source);
    }

    #[wasm_bindgen(js_name = hasVideoFrame)]
    pub fn has_video_frame(&self, key: &str) -> bool {
        self.renderer.has_video_frame(key)
    }

    /// Free the frames a render no longer needs (call with the keys of the next render).
    #[wasm_bindgen(js_name = retainVideoFrames)]
    pub fn retain_video_frames(&mut self, keys: Vec<String>) {
        self.renderer.retain_video_frames(&keys);
    }

    /// Model keys the current scene uses that are not loaded yet.
    #[wasm_bindgen(js_name = missingModels)]
    pub fn missing_models(&self) -> Vec<String> {
        self.model_keys().into_iter().filter(|k| !self.renderer.has_model(k)).collect()
    }

    /// Register a font file (TTF/OTF bytes) under a family and weight.
    #[wasm_bindgen(js_name = addFont)]
    pub fn add_font(&mut self, family: &str, weight: u16, bytes: &[u8]) -> Result<(), JsError> {
        self.renderer.add_font(family, weight, bytes).map_err(|e| JsError::new(&e))
    }

    /// Custom shaders of the current scene that cannot draw, as JSON `[[layer id, reason], …]`
    /// (code saved broken, or refused by the browser's GPU compiler). Review checks report them.
    #[wasm_bindgen(js_name = shaderFailures)]
    pub fn shader_failures(&self) -> String {
        serde_json::to_string(&self.renderer.shader_failures(&self.scene)).unwrap_or_default()
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.renderer.resize(width, height);
    }

    /// Draw at 2x and average down (every edge supersampled) when 2; 1 is the default and the fastest.
    #[wasm_bindgen(js_name = setSupersample)]
    pub fn set_supersample(&mut self, factor: u32) {
        self.renderer.set_supersample(factor);
    }

    pub fn render(&mut self, t: f32) {
        self.renderer.render(&self.scene, t);
    }

    /// A ticket for everything submitted so far: `workDone(ticket)` turns true once the GPU has
    /// finished it (render() returns as soon as the work is queued; this is when it is drawn).
    #[wasm_bindgen(js_name = watchWork)]
    pub fn watch_work(&mut self) -> u32 {
        self.work_asked += 1;
        let done = self.work_done.clone();
        self.renderer.on_work_done(move || {
            done.fetch_add(1, Ordering::Release);
        });
        self.work_asked
    }

    #[wasm_bindgen(js_name = workDone)]
    pub fn work_done(&self, ticket: u32) -> bool {
        self.work_done.load(Ordering::Acquire) >= ticket
    }
}

/// glTF model keys used inside a procedural tree.
fn model_keys(node: &scene::Node3D) -> Vec<String> {
    let mut keys = match &node.kind {
        scene::NodeKind::Model { model } => vec![model.clone()],
        _ => vec![],
    };
    keys.extend(node.children.iter().flat_map(model_keys));
    keys
}

/// Why a scene's custom shaders do not compile (layer id, WGSL line, message), or undefined.
/// Agents' `load_scene` runs it first so a broken shader is an error, like it is for ops.
#[wasm_bindgen(js_name = checkSceneShaders)]
pub fn check_scene_shaders(json: &str) -> Option<String> {
    Scene::from_json(json).ok()?.check_shaders().err()
}

/// A timeline from another editor (FCPXML, Final Cut Pro 7 XML or OpenTimelineIO) as JSON: its clips by
/// track with their file name, original location, position and file in, plus what was skipped.
#[wasm_bindgen(js_name = parseTimeline)]
pub fn parse_timeline(text: &str) -> Result<String, JsError> {
    let t = scene::timeline_import::import_timeline(text).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&t).map_err(|e| JsError::new(&e.to_string()))
}

/// Duration (s) of a video file once the host opened it: loops and holds need it.
#[wasm_bindgen(js_name = setMediaDuration)]
pub fn set_media_duration(src: &str, seconds: f32) {
    scene::video::set_media_duration(src, seconds);
}

/// Analyse the project audio (mono samples at `rate` Hz, ideally `audioSampleRate()`) for the
/// audio-reactive expressions of every engine. Returns `{duration, beats, bpm}` as JSON.
#[wasm_bindgen(js_name = analyzeAudio)]
pub fn analyze_audio(samples: &[f32], rate: f32) -> String {
    let a = scene::reactive::analyze(samples, rate);
    let json = serde_json::json!({ "duration": a.duration, "beats": a.beats, "bpm": a.bpm }).to_string();
    scene::reactive::set_analysis(Some(a));
    json
}

/// No project audio: audio-reactive expressions read 0.
#[wasm_bindgen(js_name = clearAudioAnalysis)]
pub fn clear_audio_analysis() {
    scene::reactive::set_analysis(None);
}

/// Sample rate the audio should be decoded at before `analyzeAudio`.
#[wasm_bindgen(js_name = audioSampleRate)]
pub fn audio_sample_rate() -> f32 {
    scene::reactive::SAMPLE_RATE
}

/// Style presets, as JSON, so the UI never hardcodes the list.
#[wasm_bindgen(js_name = stylePresets)]
pub fn style_presets() -> String {
    serde_json::to_string(&StylePreset::ALL).unwrap()
}

#[wasm_bindgen(js_name = captionStyles)]
pub fn caption_styles() -> String {
    serde_json::to_string(&CaptionStyle::ALL).unwrap()
}

/// Palette of every style as `{ style: [background, surface, primary, accent, text] }`
/// in CSS hex, so the UI can preview styles without duplicating colors.
#[wasm_bindgen(js_name = stylePalettes)]
pub fn style_palettes() -> String {
    let hex = |c: scene::Rgba| {
        let [r, g, b, _] = c.0.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
        format!("#{r:02x}{g:02x}{b:02x}")
    };
    let map: serde_json::Map<String, serde_json::Value> = StylePreset::ALL
        .iter()
        .map(|s| {
            let p = s.palette();
            let key = serde_json::to_value(s).unwrap().as_str().unwrap().to_owned();
            let colors = [p.background, p.surface, p.primary, p.accent, p.text].map(hex);
            (key, serde_json::json!(colors))
        })
        .collect();
    serde_json::Value::Object(map).to_string()
}
