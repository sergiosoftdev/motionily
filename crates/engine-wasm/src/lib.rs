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

    pub fn duration(&self) -> f32 {
        self.scene.duration
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.renderer.resize(width, height);
    }

    pub fn render(&mut self, t: f32) {
        self.renderer.render(&self.scene, t);
    }
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
