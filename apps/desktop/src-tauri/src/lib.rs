//! Motionily desktop: one window with the editor, the API running locally on SQLite, and the agents
//! (any MCP client) working on the user's own machine.

mod assets;
mod export;
mod ffmpeg;
mod runtime;
mod viewer;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Origins the editor's webview loads from: Vite in development, Tauri's own scheme once packaged.
const WEB_ORIGINS: &str = "http://localhost:5173,tauri://localhost,http://tauri.localhost,https://tauri.localhost";

struct Runtime(Mutex<Option<runtime::Api>>);

/// The video open in the editor (the web app reports it), for "Save Video as Folder…".
struct OpenProject(Mutex<Option<String>>);

const MENU_OPEN_FOLDER: &str = "open-folder";
const MENU_SAVE_FOLDER: &str = "save-folder";

/// The standard menus plus Motionily's file commands at the top of File.
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let open = MenuItem::with_id(app, MENU_OPEN_FOLDER, "Open Project Folder…", true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, MENU_SAVE_FOLDER, "Save Video as Folder…", true, Some("CmdOrCtrl+Shift+S"))?;
    let file = menu.items()?.into_iter().filter_map(|i| i.as_submenu().cloned()).find(|s| s.text().map(|t| t == "File").unwrap_or(false));
    match file {
        Some(file) => {
            file.insert_items(&[&open, &save, &PredefinedMenuItem::separator(app)?], 0)?;
        }
        None => menu.append(&Submenu::with_items(app, "File", true, &[&open, &save])?)?,
    }
    Ok(menu)
}

/// File menu commands: pick a folder, call the API as the local account, say how it went.
fn on_menu(app: &tauri::AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    // Dialogs block: never on the main thread.
    std::thread::spawn(move || {
        let project = app.state::<OpenProject>().0.lock().ok().and_then(|p| p.clone());
        if id == MENU_SAVE_FOLDER && project.is_none() {
            app.dialog().message("Open a video first, then save it as a folder.").title("No video open").blocking_show();
            return;
        }
        let title = if id == MENU_OPEN_FOLDER { "Open a .motionily project folder" } else { "Where to save the video's folder" };
        let Some(path) = app.dialog().file().set_title(title).blocking_pick_folder() else { return };
        let Ok(path) = path.into_path() else { return };
        let runtime = app.state::<Runtime>();
        let guard = runtime.0.lock();
        let Some(api) = guard.as_ref().ok().and_then(|g| g.as_ref()) else { return };
        let body = serde_json::json!({ "path": path });
        let result = if id == MENU_OPEN_FOLDER {
            api.call("POST", "/projects/import-folder", &body).map(|r| {
                let _ = app.emit("desktop-navigate", format!("/p/{}", r["id"].as_str().unwrap_or_default()));
                None
            })
        } else {
            api.call("POST", &format!("/projects/{}/folder", project.unwrap_or_default()), &body).map(|r| Some(r["folder"].as_str().unwrap_or_default().to_string()))
        };
        drop(guard);
        match result {
            Ok(Some(folder)) => {
                let _ = reveal(folder);
            }
            Ok(None) => {}
            Err(e) => {
                app.dialog().message(e).title("Motionily").kind(MessageDialogKind::Error).blocking_show();
            }
        }
    });
}

/// The editor reports which video is open (none on other screens).
#[tauri::command]
fn desktop_route(state: tauri::State<'_, OpenProject>, project: Option<String>) {
    if let Ok(mut p) = state.0.lock() {
        *p = project;
    }
}

/// The native engine's state shared by the commands: assets mirrored from the editor, the staged
/// export audio and the running export's cancel flag.
struct Native {
    assets: Arc<Mutex<assets::Assets>>,
    audio: Mutex<Option<PathBuf>>,
    cancel: Arc<AtomicBool>,
    tools: ffmpeg::Tools,
    data: PathBuf,
    api_url: String,
}

impl Native {
    /// Scene media src to something ffmpeg opens: uploads from the data folder, the rest by URL.
    fn resolver(&self) -> Box<dyn Fn(&str) -> String + Send> {
        let media = self.data.join("media");
        let api = self.api_url.clone();
        Box::new(move |src: &str| {
            if let Some(file) = src.strip_prefix("/media/") {
                media.join(file).display().to_string()
            } else if src.starts_with('/') {
                format!("{api}{src}")
            } else {
                src.to_string()
            }
        })
    }
}

fn header<'a>(req: &'a tauri::ipc::Request<'_>, name: &str) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

fn raw_body(req: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match req.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("expected a binary body".into()),
    }
}

/// One asset from the editor: `x-kind` font|model|texture|image, `x-key` (URI-encoded), `x-a`/`x-b`
/// = weight for fonts, width/height for pixels.
#[tauri::command]
fn engine_add_asset(native: tauri::State<'_, Native>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let kind = header(&request, "x-kind").and_then(assets::AssetKind::parse).ok_or("unknown asset kind")?;
    let key = percent_decode(header(&request, "x-key").ok_or("missing key")?);
    let num = |h: &str| header(&request, h).and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    let body = raw_body(&request)?;
    native.assets.lock().map_err(|e| e.to_string())?.add(kind, &key, body, num("x-a"), num("x-b"));
    Ok(())
}

/// Which of `keys` the native engine does not have yet (so the editor sends only those).
#[tauri::command]
fn engine_missing_assets(native: tauri::State<'_, Native>, kind: String, keys: Vec<String>) -> Result<Vec<String>, String> {
    let kind = assets::AssetKind::parse(&kind).ok_or("unknown asset kind")?;
    let a = native.assets.lock().map_err(|e| e.to_string())?;
    Ok(keys.into_iter().filter(|k| !a.has(kind, k)).collect())
}

/// The voice-over's mono samples (f32, `x-rate` Hz) for audio-reactive expressions; empty clears them.
#[tauri::command]
fn engine_audio_analysis(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let body = raw_body(&request)?;
    let rate = header(&request, "x-rate").and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
    if body.len() < 4 || rate <= 0.0 {
        scene::reactive::set_analysis(None);
        return Ok(());
    }
    let samples: Vec<f32> = body.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    scene::reactive::set_analysis(Some(scene::reactive::analyze(&samples, rate)));
    Ok(())
}

/// The export's audio mix (a WAV the editor rendered), or an empty body for a silent video.
#[tauri::command]
fn export_audio(native: tauri::State<'_, Native>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let body = raw_body(&request)?;
    let mut slot = native.audio.lock().map_err(|e| e.to_string())?;
    if body.is_empty() {
        *slot = None;
        return Ok(());
    }
    let dir = native.data.join("tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("export-audio.wav");
    std::fs::write(&file, body).map_err(|e| e.to_string())?;
    *slot = Some(file);
    Ok(())
}

/// Renders and encodes the video natively; emits `export-progress` and resolves with the file path.
#[tauri::command]
async fn export_video(app: tauri::AppHandle, request: export::ExportRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let native = app.state::<Native>();
        native.cancel.store(false, Ordering::Relaxed);
        let out = match &request.path {
            Some(p) => p.clone(),
            None => {
                let movies = app.path().video_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?;
                export::default_path(&movies, request.name.as_deref().unwrap_or("Motionily video"), request.codec.extension())
            }
        };
        let audio = native.audio.lock().map_err(|e| e.to_string())?.clone();
        let mut clips = ffmpeg::Clips::new(native.tools.clone(), native.resolver());
        let assets = native.assets.lock().map_err(|e| e.to_string())?;
        let emitter = app.clone();
        let path = export::export(request, out, &assets, audio.as_deref(), &native.tools, &mut clips, native.cancel.clone(), |p| {
            let _ = emitter.emit("export-progress", p);
        })?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn export_cancel(native: tauri::State<'_, Native>) {
    native.cancel.store(true, Ordering::Relaxed);
}

thread_local! {
    /// The playback viewer lives on the main thread (AppKit views are not Send); sync commands run there.
    static VIEWER: std::cell::RefCell<Option<viewer::Viewer>> = const { std::cell::RefCell::new(None) };
}

/// Whether this system has the native playback viewer (macOS for now).
#[tauri::command]
fn viewer_supported() -> bool {
    viewer::Viewer::SUPPORTED
}

/// Puts the viewer over the preview canvas at `rect` with `scene_json` loaded and its frame at `t`
/// drawn (so it never shows a stale frame); returns the GPU it draws on.
#[tauri::command]
#[allow(unused_variables)]
async fn viewer_show(app: tauri::AppHandle, window: tauri::WebviewWindow, native: tauri::State<'_, Native>, rect: viewer::Rect, scene_json: String, t: f32) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let (tools, resolver, assets) = (native.tools.clone(), native.resolver(), native.assets.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let made = VIEWER.with(|v| -> Result<(viewer::Worker, String), String> {
                let mut v = v.borrow_mut();
                if v.is_none() {
                    let content = window.ns_view().map_err(|e| e.to_string())?;
                    *v = Some(viewer::Viewer::new(content, rect, ffmpeg::Clips::new(tools, resolver), assets)?);
                }
                let viewer = v.as_mut().expect("created above");
                viewer.place(rect);
                Ok((viewer.worker(), viewer.adapter().to_string()))
            });
            let _ = tx.send(made);
        })
        .map_err(|e| e.to_string())?;
        let (worker, adapter) = tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())??;
        tauri::async_runtime::spawn_blocking(move || worker.load(scene_json, t)).await.map_err(|e| e.to_string())??;
        app.run_on_main_thread(|| {
            VIEWER.with(|v| {
                if let Some(v) = v.borrow().as_ref() {
                    v.set_hidden(false);
                }
            })
        })
        .map_err(|e| e.to_string())?;
        eprintln!("[motionily] native viewer on {adapter} at {:.0}x{:.0}@{}x", rect.width, rect.height, rect.scale);
        Ok(adapter)
    }
    #[cfg(not(target_os = "macos"))]
    Err("the native viewer is not available on this system".into())
}

/// Moves the viewer with the canvas.
#[tauri::command]
#[allow(unused_variables)]
fn viewer_place(rect: viewer::Rect) {
    #[cfg(target_os = "macos")]
    VIEWER.with(|v| {
        if let Some(v) = v.borrow_mut().as_mut() {
            v.place(rect);
        }
    });
}

/// Draws the frame at `t` seconds (on the viewer's thread; returns at once).
#[tauri::command]
#[allow(unused_variables)]
fn viewer_frame(t: f32) {
    #[cfg(target_os = "macos")]
    VIEWER.with(|v| {
        if let Some(v) = v.borrow().as_ref() {
            v.worker().frame(t);
        }
    });
}

#[tauri::command]
fn viewer_hide() {
    #[cfg(target_os = "macos")]
    VIEWER.with(|v| {
        if let Some(v) = v.borrow().as_ref() {
            v.set_hidden(true);
        }
    });
}

/// The folder the user picks (None when they cancel): what the editor asks for to relink missing media.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, title: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title(title).blocking_pick_folder()?.into_path().ok().map(|p| p.display().to_string()))
        .await
        .ok()
        .flatten()
}

/// Writes a subtitle or timeline file next to the exports (`<Movies>/Motionily/<name>.<ext>`) and returns its path.
#[tauri::command]
fn save_side_file(app: tauri::AppHandle, name: String, kind: export::SideFile, contents: String) -> Result<String, String> {
    let movies = app.path().video_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?;
    let path = export::default_path(&movies, &name, kind.extension());
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Shows a written file in Finder / Explorer / the file manager.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let r = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(p).spawn()
    } else if cfg!(windows) {
        std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(p)).spawn()
    };
    r.map(|_| ()).map_err(|e| e.to_string())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the web app reads before it starts (see apps/web/src/desktop.ts).
fn desktop_script(api: Result<&runtime::Api, &str>, layout: Option<&runtime::Layout>, media: &std::path::Path) -> String {
    let info = match api {
        Ok(api) => serde_json::json!({
            "apiUrl": api.url,
            "session": api.session,
            "platform": std::env::consts::OS,
            "mediaDir": media.display().to_string(),
            "mcp": layout.map(|l| serde_json::json!({ "command": l.mcp_command, "args": l.mcp_args })),
        }),
        Err(e) => serde_json::json!({ "error": e, "platform": std::env::consts::OS }),
    };
    format!("window.__MOTIONILY_DESKTOP__ = {info};")
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenProject(Mutex::new(None)))
        .menu(app_menu)
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let resources = app.path().resource_dir().ok();
            let layout = runtime::Layout::find(resources.as_deref());
            let api = layout.as_ref().map_err(String::clone).and_then(|l| runtime::Api::start(l, &data, WEB_ORIGINS));
            #[allow(unused_mut)]
            let mut script = desktop_script(api.as_ref().map_err(String::as_str), layout.as_ref().ok(), &data.join("media"));
            // Development builds only: extra JS for automated checks (e.g. start playback and screenshot).
            #[cfg(debug_assertions)]
            if let Ok(js) = std::env::var("MOTIONILY_DEV_EVAL") {
                script.push_str(&js);
            }
            // `--open /p/<id>` (or MOTIONILY_OPEN) starts on that screen of the editor.
            let route = std::env::args().skip_while(|a| a != "--open").nth(1).or_else(|| std::env::var("MOTIONILY_OPEN").ok());
            let page = route.map_or_else(|| "index.html".to_string(), |r| format!("index.html#{}", r.trim_start_matches('#')));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(page.into()))
                .title("Motionily")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 680.0)
                .initialization_script(&script)
                .build()?;
            let api_url = api.as_ref().map(|a| a.url.clone()).unwrap_or_default();
            app.manage(Native {
                assets: Arc::new(Mutex::new(assets::Assets::default())),
                audio: Mutex::new(None),
                cancel: Arc::new(AtomicBool::new(false)),
                tools: ffmpeg::Tools::find(resources.as_deref().map(|r| r.join("runtime")).as_deref()),
                data: data.clone(),
                api_url,
            });
            app.manage(Runtime(Mutex::new(api.ok())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_add_asset, engine_missing_assets, engine_audio_analysis, export_audio, export_video, export_cancel, save_side_file, reveal, viewer_supported, viewer_show, viewer_place, viewer_frame, viewer_hide, desktop_route, pick_folder])
        .build(tauri::generate_context!())
        .expect("error while building Motionily");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut api) = handle.state::<Runtime>().0.lock().ok().and_then(|mut a| a.take()) {
                api.stop();
            }
        }
    });
}
