//! Native playback viewer (macOS): while the editor plays, a Metal-backed view sits exactly over the
//! preview canvas and the native engine draws each frame (full resolution, clips decoded by ffmpeg).
//! It lets every click through to the web editor underneath. Paused, it hides and the editor's own
//! canvas (with its gizmos and selection) is back. Other systems keep the editor's WebGPU canvas.

use serde::Deserialize;

/// Where the preview canvas is, in CSS pixels of the window's content (top-left origin).
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// devicePixelRatio: the surface is sized in physical pixels.
    pub scale: f64,
}

#[cfg(target_os = "macos")]
pub use mac::Viewer;

#[cfg(not(target_os = "macos"))]
pub struct Viewer;

#[cfg(not(target_os = "macos"))]
impl Viewer {
    pub const SUPPORTED: bool = false;
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ptr::NonNull;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::NSView;
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use raw_window_handle::{AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle};

    use super::Rect;
    use crate::assets::Assets;
    use crate::ffmpeg::Clips;

    define_class!(
        // A plain layer-backed view that is invisible to the mouse: clicks reach the webview below.
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[name = "MotionilyViewerView"]
        struct PassthroughView;

        impl PassthroughView {
            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> *mut NSView {
                std::ptr::null_mut()
            }
        }
    );

    impl PassthroughView {
        fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), initWithFrame: frame] }
        }
    }

    pub struct Viewer {
        view: Retained<PassthroughView>,
        renderer: engine::Renderer,
        scene: Option<scene::Scene>,
        clips: Clips,
        /// Physical size the surface is configured at.
        size: (u32, u32),
        assets_loaded: usize,
    }

    impl Viewer {
        pub const SUPPORTED: bool = true;

        /// Adds the view on top of the window's content view and builds a renderer on it.
        /// `content` is the window's NSView (tauri's `ns_view()`). Main thread only.
        pub fn new(content: *mut std::ffi::c_void, rect: Rect, clips: Clips) -> Result<Self, String> {
            let mtm = MainThreadMarker::new().ok_or("the viewer must be created on the main thread")?;
            let content: &NSView = unsafe { (content as *const NSView).as_ref() }.ok_or("no content view")?;
            let view = PassthroughView::new(mtm, frame_in(content, rect));
            view.setWantsLayer(true);
            content.addSubview(&view);

            let ptr = NonNull::new(Retained::as_ptr(&view) as *mut std::ffi::c_void).ok_or("null view")?;
            let target = wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: Some(RawDisplayHandle::AppKit(AppKitDisplayHandle::new())),
                raw_window_handle: RawWindowHandle::AppKit(AppKitWindowHandle::new(ptr)),
            };
            let instance = wgpu::Instance::default();
            let surface = unsafe { instance.create_surface_unsafe(target) }.map_err(|e| e.to_string())?;
            let size = physical(rect);
            let renderer = pollster::block_on(engine::Renderer::new(&instance, surface, size.0, size.1)).map_err(|e| e.to_string())?;
            Ok(Self { view, renderer, scene: None, clips, size, assets_loaded: 0 })
        }

        pub fn adapter(&self) -> &str {
            &self.renderer.adapter_info
        }

        /// Follows the canvas (layout changes, window resizes, zoom).
        pub fn place(&mut self, rect: Rect) {
            if let Some(content) = unsafe { self.view.superview() } {
                self.view.setFrame(frame_in(&content, rect));
            }
            let size = physical(rect);
            if size != self.size {
                self.size = size;
                self.renderer.resize(size.0, size.1);
            }
        }

        pub fn set_hidden(&self, hidden: bool) {
            self.view.setHidden(hidden);
        }

        pub fn load_scene(&mut self, json: &str) -> Result<(), String> {
            let scene = scene::Scene::from_json(json).map_err(|e| e.to_string())?;
            for src in scene.video_sources() {
                if let Ok(p) = self.clips.open(&src) {
                    scene::video::set_media_duration(&src, p.duration as f32);
                }
            }
            self.scene = Some(scene);
            Ok(())
        }

        /// Loads assets added since the last call (the store only grows).
        pub fn sync_assets(&mut self, assets: &Assets) {
            let count = assets.fonts.len() + assets.models.len() + assets.textures.len() + assets.images.len();
            if count != self.assets_loaded {
                assets.load_into(&mut self.renderer);
                self.assets_loaded = count;
            }
        }

        /// Draws the frame at `t` (seconds), decoding the clips it shows.
        pub fn render(&mut self, t: f32) -> Result<(), String> {
            let Some(scene) = &self.scene else { return Ok(()) };
            let needs = scene.video_frames(t);
            for need in &needs {
                if let Ok((px, (w, h))) = self.clips.frame(&need.src, need.time as f64) {
                    self.renderer.add_video_frame(&need.key, px, w, h);
                }
            }
            self.renderer.retain_video_frames(&needs.iter().map(|n| n.key.clone()).collect::<Vec<_>>());
            self.renderer.render(scene, t);
            Ok(())
        }
    }

    impl Drop for Viewer {
        fn drop(&mut self) {
            self.view.removeFromSuperview();
        }
    }

    fn physical(r: Rect) -> (u32, u32) {
        (((r.width * r.scale).round() as u32).max(1), ((r.height * r.scale).round() as u32).max(1))
    }

    /// CSS rect (top-left origin) to the content view's coordinates (bottom-left unless flipped).
    fn frame_in(content: &NSView, r: Rect) -> NSRect {
        let h = content.frame().size.height;
        let flipped: bool = unsafe { msg_send![content as &AnyObject, isFlipped] };
        let y = if flipped { r.y } else { h - r.y - r.height };
        NSRect::new(NSPoint::new(r.x, y), NSSize::new(r.width, r.height))
    }
}
