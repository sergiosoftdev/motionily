//! What the native engine needs besides the scene: the fonts, models, textures and images the web
//! editor already loaded. The editor sends each one once (binary IPC); every native renderer (the
//! exporter, the viewer) is filled from here.

use std::collections::HashMap;

#[derive(Default)]
pub struct Assets {
    pub fonts: Vec<(String, u16, Vec<u8>)>,
    pub models: HashMap<String, Vec<u8>>,
    pub textures: HashMap<String, (Vec<u8>, u32, u32)>,
    pub images: HashMap<String, (Vec<u8>, u32, u32)>,
}

/// The kinds the editor sends, named by the `x-kind` header of `engine_add_asset`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Font,
    Model,
    Texture,
    Image,
}

impl AssetKind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "font" => Self::Font,
            "model" => Self::Model,
            "texture" => Self::Texture,
            "image" => Self::Image,
            _ => return None,
        })
    }
}

impl Assets {
    pub fn add(&mut self, kind: AssetKind, key: &str, bytes: Vec<u8>, a: u32, b: u32) {
        match kind {
            AssetKind::Font => {
                // `a` is the weight; a family+weight sent again replaces the old file.
                self.fonts.retain(|(f, w, _)| !(f == key && *w == a as u16));
                self.fonts.push((key.to_string(), a as u16, bytes));
            }
            AssetKind::Model => {
                self.models.insert(key.to_string(), bytes);
            }
            AssetKind::Texture => {
                self.textures.insert(key.to_string(), (bytes, a, b));
            }
            AssetKind::Image => {
                self.images.insert(key.to_string(), (bytes, a, b));
            }
        }
    }

    pub fn has(&self, kind: AssetKind, key: &str) -> bool {
        match kind {
            AssetKind::Font => self.fonts.iter().any(|(f, _, _)| f == key),
            AssetKind::Model => self.models.contains_key(key),
            AssetKind::Texture => self.textures.contains_key(key),
            AssetKind::Image => self.images.contains_key(key),
        }
    }

    /// Loads everything into a renderer (fonts that fail to parse are skipped, like in the web engine).
    pub fn load_into(&self, r: &mut engine::Renderer) {
        for (family, weight, bytes) in &self.fonts {
            let _ = r.add_font(family, *weight, bytes);
        }
        for (key, bytes) in &self.models {
            let _ = r.add_model(key, bytes);
        }
        for (key, (rgba, w, h)) in &self.textures {
            r.add_texture(key, rgba, *w, *h);
        }
        for (key, (rgba, w, h)) in &self.images {
            r.add_image(key, rgba, *w, *h);
        }
    }
}
