//! Native playback viewer (macOS): while the editor plays, a Metal-backed view sits exactly over the
//! preview canvas and the native engine draws each frame (full resolution, clips decoded by ffmpeg).
//! It lets every click through to the web editor underneath. Paused, it hides and the editor's own
//! canvas (with its gizmos and selection) is back. Other systems keep the editor's WebGPU canvas.
//!
//! The view belongs to the main thread; decoding and drawing run on the viewer's own thread, so a
//! heavy frame never stalls the window (and the web editor in it). Frames asked for while one draws
//! collapse to the latest.

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
pub use mac::{Viewer, Worker};

#[cfg(not(target_os = "macos"))]
pub struct Viewer;

#[cfg(not(target_os = "macos"))]
impl Viewer {
    pub const SUPPORTED: bool = false;
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ptr::NonNull;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::{Arc, Mutex};

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

    /// What the main thread asks the viewer's thread to do.
    enum Command {
        /// Load a scene and draw its frame at `t`; answers once it is on the surface.
        Load { json: String, t: f32, done: Sender<Result<(), String>> },
        Frame(f32),
        Resize(u32, u32),
    }

    /// The main thread's handle on the viewer's thread (cheap to clone, usable from any thread).
    #[derive(Clone)]
    pub struct Worker(Sender<Command>);

    impl Worker {
        /// Loads `json` and draws `t`; returns once that frame is drawn (so the view can show it).
        pub fn load(&self, json: String, t: f32) -> Result<(), String> {
            let (done, wait) = mpsc::channel();
            self.0.send(Command::Load { json, t, done }).map_err(|_| "the viewer stopped")?;
            wait.recv().map_err(|_| "the viewer stopped".to_string())?
        }

        /// Draws `t` without waiting.
        pub fn frame(&self, t: f32) {
            let _ = self.0.send(Command::Frame(t));
        }
    }

    pub struct Viewer {
        view: Retained<PassthroughView>,
        worker: Worker,
        adapter: String,
        /// Physical size the surface is configured at.
        size: (u32, u32),
    }

    impl Viewer {
        pub const SUPPORTED: bool = true;

        /// Adds the view on top of the window's content view and starts its thread with a renderer on it.
        /// `content` is the window's NSView (tauri's `ns_view()`). Main thread only.
        pub fn new(content: *mut std::ffi::c_void, rect: Rect, clips: Clips, assets: Arc<Mutex<Assets>>) -> Result<Self, String> {
            let mtm = MainThreadMarker::new().ok_or("the viewer must be created on the main thread")?;
            let content: &NSView = unsafe { (content as *const NSView).as_ref() }.ok_or("no content view")?;
            let view = PassthroughView::new(mtm, frame_in(content, rect));
            view.setWantsLayer(true);
            view.setHidden(true);
            content.addSubview(&view);

            let ptr = NonNull::new(Retained::as_ptr(&view) as *mut std::ffi::c_void).ok_or("null view")?;
            let target = wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: Some(RawDisplayHandle::AppKit(AppKitDisplayHandle::new())),
                raw_window_handle: RawWindowHandle::AppKit(AppKitWindowHandle::new(ptr)),
            };
            let instance = wgpu::Instance::default();
            let surface = unsafe { instance.create_surface_unsafe(target) }.map_err(|e| e.to_string())?;
            let size = physical(rect);
            let (tx, rx) = mpsc::channel();
            let (ready, started) = mpsc::channel();
            // The renderer is made on the thread that draws with it (it keeps GPU futures that stay there).
            std::thread::Builder::new()
                .name("motionily-viewer".into())
                .spawn(move || match pollster::block_on(engine::Renderer::new(&instance, surface, size.0, size.1)) {
                    Ok(renderer) => {
                        let _ = ready.send(Ok(renderer.adapter_info.clone()));
                        run(rx, Drawer { renderer, scene: None, clips, assets, assets_loaded: usize::MAX });
                    }
                    Err(e) => {
                        let _ = ready.send(Err(e.to_string()));
                    }
                })
                .map_err(|e| e.to_string())?;
            let adapter = started.recv().map_err(|_| "the viewer thread stopped".to_string())??;
            Ok(Self { view, worker: Worker(tx), adapter, size })
        }

        pub fn adapter(&self) -> &str {
            &self.adapter
        }

        pub fn worker(&self) -> Worker {
            self.worker.clone()
        }

        /// Follows the canvas (layout changes, window resizes, zoom).
        pub fn place(&mut self, rect: Rect) {
            if let Some(content) = unsafe { self.view.superview() } {
                self.view.setFrame(frame_in(&content, rect));
            }
            let size = physical(rect);
            if size != self.size {
                self.size = size;
                let _ = self.worker.0.send(Command::Resize(size.0, size.1));
            }
        }

        pub fn set_hidden(&self, hidden: bool) {
            self.view.setHidden(hidden);
        }
    }

    impl Drop for Viewer {
        fn drop(&mut self) {
            self.view.removeFromSuperview();
        }
    }

    /// The viewer thread's state: the renderer on the view's surface and what it draws.
    struct Drawer {
        renderer: engine::Renderer,
        scene: Option<scene::Scene>,
        clips: Clips,
        assets: Arc<Mutex<Assets>>,
        assets_loaded: usize,
    }

    /// The viewer thread: runs commands in order, drawing only the latest of the frames queued up.
    fn run(rx: Receiver<Command>, mut d: Drawer) {
        let mut next = rx.recv().ok();
        while let Some(cmd) = next.take() {
            match cmd {
                Command::Frame(mut t) => {
                    // Frames queued behind this one: skip to the newest, keep the next other command.
                    loop {
                        match rx.try_recv() {
                            Ok(Command::Frame(later)) => t = later,
                            Ok(other) => {
                                next = Some(other);
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    d.render(t);
                }
                Command::Load { json, t, done } => {
                    let r = d.load(&json).map(|()| d.render(t));
                    let _ = done.send(r);
                }
                Command::Resize(w, h) => d.renderer.resize(w, h),
            }
            if next.is_none() {
                next = rx.recv().ok();
            }
        }
    }

    impl Drawer {
        fn load(&mut self, json: &str) -> Result<(), String> {
            let scene = scene::Scene::from_json(json).map_err(|e| e.to_string())?;
            for src in scene.video_sources() {
                if let Ok(p) = self.clips.open(&src) {
                    scene::video::set_media_duration(&src, p.duration as f32);
                }
            }
            self.scene = Some(scene);
            // Assets added since the last load (the store only grows). An export holding them: next time.
            if let Ok(assets) = self.assets.try_lock() {
                let count = assets.fonts.len() + assets.models.len() + assets.textures.len() + assets.images.len() + assets.luts.len();
                if count != self.assets_loaded {
                    assets.load_into(&mut self.renderer);
                    self.assets_loaded = count;
                }
            }
            Ok(())
        }

        /// Draws the frame at `t` (seconds), decoding the clips it shows.
        fn render(&mut self, t: f32) {
            let Some(scene) = &self.scene else { return };
            let needs = scene.video_frames(t);
            for need in &needs {
                if let Ok((px, (w, h))) = self.clips.frame(&need.src, need.time as f64) {
                    self.renderer.add_video_frame(&need.key, px, w, h);
                }
            }
            self.renderer.retain_video_frames(&needs.iter().map(|n| n.key.clone()).collect::<Vec<_>>());
            self.renderer.render(scene, t);
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
