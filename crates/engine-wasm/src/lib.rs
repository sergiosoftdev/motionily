//! Browser bindings. The API is deliberately coarse (load, apply ops, render)
//! so JS <-> WASM crossings stay few and cheap.

use engine::Renderer;
use scene::{CaptionStyle, Op, Scene, StylePreset};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct Engine {
    renderer: Renderer,
    scene: Scene,
}

#[wasm_bindgen]
impl Engine {
    /// Create the engine on a canvas. Uses WebGPU when available, WebGL2 otherwise.
    pub async fn create(canvas: HtmlCanvasElement) -> Result<Engine, JsError> {
        let (w, h) = (canvas.width(), canvas.height());
        let instance = wgpu::util::new_instance_with_webgpu_detection(wgpu::InstanceDescriptor::new_without_display_handle()).await;
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| JsError::new(&e.to_string()))?;
        let renderer = Renderer::new(&instance, surface, w, h)
            .await
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Engine { renderer, scene: Scene::default() })
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
        let ops: Vec<Op> = serde_json::from_str(json).map_err(|e| JsError::new(&format!("invalid ops: {e}")))?;
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

    /// `[cx, cy, w, h, rotation]` of a layer at time t in scene pixels, or undefined.
    #[wasm_bindgen(js_name = layerBounds)]
    pub fn layer_bounds(&self, id: &str, t: f32) -> Option<Vec<f32>> {
        self.scene
            .layer_bounds(id, t)
            .map(|b| vec![b.center[0], b.center[1], b.size[0], b.size[1], b.rotation])
    }

    #[wasm_bindgen(js_name = layerJson)]
    pub fn layer_json(&self, id: &str) -> Option<String> {
        self.scene.layer_json(id)
    }

    pub fn duration(&self) -> f32 {
        self.scene.duration
    }

    /// Register a GLB model for the 3D stage.
    #[wasm_bindgen(js_name = addModel)]
    pub fn add_model(&mut self, key: &str, bytes: &[u8]) -> Result<(), JsError> {
        self.renderer.add_model(key, bytes).map_err(|e| JsError::new(&e))
    }

    /// Register the shared texture of a model pack (RGBA8 pixels).
    #[wasm_bindgen(js_name = addTexture)]
    pub fn add_texture(&mut self, pack: &str, rgba: &[u8], width: u32, height: u32) {
        self.renderer.add_texture(pack, rgba, width, height);
    }

    /// Register a decoded image (RGBA8) for image layers.
    #[wasm_bindgen(js_name = addImage)]
    pub fn add_image(&mut self, key: &str, rgba: &[u8], width: u32, height: u32) {
        self.renderer.add_image(key, rgba, width, height);
    }

    /// Image sources the layers use that are not loaded yet.
    #[wasm_bindgen(js_name = missingImages)]
    pub fn missing_images(&self) -> Vec<String> {
        self.scene.image_sources().into_iter().filter(|s| !self.renderer.has_image(s)).collect()
    }

    /// Model keys the current scene uses that are not loaded yet.
    #[wasm_bindgen(js_name = missingModels)]
    pub fn missing_models(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .scene
            .stage
            .iter()
            .flat_map(|s| s.props.iter().map(|p| p.model.clone()))
            .chain(self.scene.library.prefabs.values().flat_map(model_keys))
            .filter(|k| !k.is_empty() && !self.renderer.has_model(k))
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }

    /// Register a font file (TTF/OTF bytes) under a family and weight.
    #[wasm_bindgen(js_name = addFont)]
    pub fn add_font(&mut self, family: &str, weight: u16, bytes: &[u8]) -> Result<(), JsError> {
        self.renderer.add_font(family, weight, bytes).map_err(|e| JsError::new(&e))
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.renderer.resize(width, height);
    }

    pub fn render(&mut self, t: f32) {
        self.renderer.render(&self.scene, t);
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
