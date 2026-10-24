//! Motionily desktop: one window with the editor, the API running locally on SQLite, and the agents
//! (any MCP client) working on the user's own machine.

mod assets;
mod export;
mod ffmpeg;
mod runtime;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Origins the editor's webview loads from: Vite in development, Tauri's own scheme once packaged.
const WEB_ORIGINS: &str = "http://localhost:5173,tauri://localhost,http://tauri.localhost,https://tauri.localhost";

struct Runtime(Mutex<Option<runtime::Api>>);

/// The native engine's state shared by the commands: assets mirrored from the editor, the staged
/// export audio and the running export's cancel flag.
struct Native {
    assets: Mutex<assets::Assets>,
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
                export::default_path(&movies, request.name.as_deref().unwrap_or("Motionily video"), request.codec)
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
fn desktop_script(api: Result<&runtime::Api, &str>, layout: Option<&runtime::Layout>) -> String {
    let info = match api {
        Ok(api) => serde_json::json!({
            "apiUrl": api.url,
            "session": api.session,
            "platform": std::env::consts::OS,
            "mcp": layout.map(|l| serde_json::json!({ "command": l.mcp_command, "args": [l.mcp_main] })),
        }),
        Err(e) => serde_json::json!({ "error": e, "platform": std::env::consts::OS }),
    };
    format!("window.__MOTIONILY_DESKTOP__ = {info};")
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let resources = app.path().resource_dir().ok();
            let layout = runtime::Layout::find(resources.as_deref());
            let api = layout.as_ref().map_err(String::clone).and_then(|l| runtime::Api::start(l, &data, WEB_ORIGINS));
            let script = desktop_script(api.as_ref().map_err(String::as_str), layout.as_ref().ok());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Motionily")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 680.0)
                .initialization_script(&script)
                .build()?;
            let api_url = api.as_ref().map(|a| a.url.clone()).unwrap_or_default();
            app.manage(Native {
                assets: Mutex::new(assets::Assets::default()),
                audio: Mutex::new(None),
                cancel: Arc::new(AtomicBool::new(false)),
                tools: ffmpeg::Tools::find(resources.as_deref().map(|r| r.join("runtime")).as_deref()),
                data: data.clone(),
                api_url,
            });
            app.manage(Runtime(Mutex::new(api.ok())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_add_asset, engine_missing_assets, export_audio, export_video, export_cancel, reveal])
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
