//! The local Motionily runtime the desktop app starts: the API (Node, SQLite in the app's data folder)
//! and what agents need to reach it (the MCP server). Nothing leaves the machine.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long the API may take to boot (Nest + catalog seed) before the app gives up.
const API_BOOT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(150);
/// The one local account of a desktop install.
const LOCAL_EMAIL: &str = "you@motionily.local";
const LOCAL_NAME: &str = "You";

/// Where the runtime's pieces live: the bundled `runtime/` resource folder in a packaged app,
/// or the repository during development.
pub struct Layout {
    pub node: PathBuf,
    pub api_main: PathBuf,
    pub api_cwd: PathBuf,
    /// How agents start the MCP server: node running the bundled tsx CLI on its source, or the repo's tsx.
    pub mcp_command: PathBuf,
    pub mcp_args: Vec<PathBuf>,
    /// The prompts and manual the API reads (docs/agent).
    pub docs: PathBuf,
    /// The bundled ffmpeg folder (None in development: ffmpeg from PATH).
    pub ffmpeg_dir: Option<PathBuf>,
}

impl Layout {
    pub fn find(resources: Option<&Path>) -> Result<Self, String> {
        let node_override = std::env::var_os("MOTIONILY_NODE").map(PathBuf::from);
        // Debug builds run the repository's API (Tauri also copies the last bundled runtime next to
        // them, which would be stale); MOTIONILY_USE_BUNDLE=1 tries the bundle instead.
        let bundled = !cfg!(debug_assertions) || std::env::var_os("MOTIONILY_USE_BUNDLE").is_some();
        if let Some(runtime) = resources.filter(|_| bundled).map(|r| r.join("runtime")).filter(|r| r.join("api/dist/main.js").exists()) {
            let node = node_override.unwrap_or_else(|| runtime.join(if cfg!(windows) { "node/node.exe" } else { "node/bin/node" }));
            return Ok(Self {
                api_main: runtime.join("api/dist/main.js"),
                api_cwd: runtime.join("api"),
                mcp_command: node.clone(),
                mcp_args: vec![runtime.join("mcp/node_modules/tsx/dist/cli.mjs"), runtime.join("mcp/src/index.ts")],
                docs: runtime.join("docs/agent"),
                ffmpeg_dir: Some(runtime.join("ffmpeg")).filter(|d| d.is_dir()),
                node,
            });
        }
        // Development: the repo next to this crate, with the API built (`pnpm --filter @motionily/api build`).
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let repo = repo.canonicalize().map_err(|e| format!("repository not found: {e}"))?;
        let api = repo.join("apps/api");
        if !api.join("dist/main.js").exists() {
            return Err("apps/api is not built: run `pnpm --filter @motionily/api build`".into());
        }
        let mcp = repo.join("packages/mcp-server");
        Ok(Self {
            node: node_override.unwrap_or_else(|| PathBuf::from("node")),
            api_main: api.join("dist/main.js"),
            api_cwd: api,
            mcp_command: mcp.join("node_modules/.bin/tsx"),
            mcp_args: vec![mcp.join("src/index.ts")],
            docs: repo.join("docs/agent"),
            ffmpeg_dir: None,
        })
    }
}

/// The API's usual port: agents registered with "Connect your agent" keep working across launches.
const DEFAULT_PORT: u16 = 47_310;

/// The install's API port: the one it used last (or the default) when free, else any free port, remembered.
fn api_port(data: &Path) -> Result<u16, String> {
    let file = data.join("port");
    let saved = std::fs::read_to_string(&file).ok().and_then(|s| s.trim().parse::<u16>().ok());
    for port in [saved.unwrap_or(DEFAULT_PORT), DEFAULT_PORT] {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            let _ = std::fs::write(&file, port.to_string());
            return Ok(port);
        }
    }
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    let _ = std::fs::write(&file, port.to_string());
    Ok(port)
}

/// A per-install secret for the API's tokens and the encryption of the user's API keys.
fn install_secret(data: &Path) -> Result<String, String> {
    let file = data.join("secret");
    if let Ok(s) = std::fs::read_to_string(&file) {
        if s.trim().len() >= 32 {
            return Ok(s.trim().to_string());
        }
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(&file, &secret).map_err(|e| e.to_string())?;
    Ok(secret)
}

pub struct Api {
    child: Child,
    pub url: String,
    port: u16,
    pub session: serde_json::Value,
}

/// The PATH the user's terminal has. An app opened from Finder or the Dock gets only the system's
/// (`/usr/bin:/bin:…`), so the agent CLIs the API starts (`claude`, `codex`…) would not be found.
fn user_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    if cfg!(windows) {
        return current;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // A login, interactive shell reads the profile files where installers add their folders.
    let from_shell = Command::new(&shell)
        .args(["-ilc", "printf '%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let usual = [format!("{home}/.local/bin"), format!("{home}/.npm-global/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    let mut dirs: Vec<String> = Vec::new();
    for d in from_shell.split(':').chain(current.split(':')).map(str::to_string).chain(usual) {
        if !d.is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs.join(":")
}

impl Api {
    /// Starts the API on its port with its data in `data` and waits until it answers.
    pub fn start(layout: &Layout, data: &Path, web_origins: &str) -> Result<Self, String> {
        std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let port = api_port(data)?;
        let url = format!("http://127.0.0.1:{port}");
        let secret = install_secret(data)?;
        let log = std::fs::File::create(data.join("api.log")).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&layout.node);
        cmd.arg(&layout.api_main)
            .current_dir(&layout.api_cwd)
            .env("PORT", port.to_string())
            .env("DATABASE_URL", format!("sqlite:{}", data.join("motionily.db").display()))
            .env("MEDIA_DIR", data.join("media"))
            .env("MODELS_DIR", data.join("models"))
            .env("JWT_SECRET", &secret)
            .env("SECRETS_KEY", &secret)
            .env("WEB_ORIGIN", web_origins)
            .env("PUBLIC_API_URL", &url)
            .env("MOTIONILY_DESKTOP", "1")
            .env("MOTIONILY_PARENT_PID", std::process::id().to_string())
            .env("PATH", user_path())
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        let args: Vec<String> = layout.mcp_args.iter().map(|a| a.display().to_string()).collect();
        cmd.env("MOTIONILY_MCP_COMMAND", &layout.mcp_command)
            .env("MOTIONILY_MCP_ARGS", serde_json::to_string(&args).map_err(|e| e.to_string())?)
            .env("MOTIONILY_DOCS_DIR", &layout.docs);
        if let Some(dir) = &layout.ffmpeg_dir {
            let exe = if cfg!(windows) { ".exe" } else { "" };
            cmd.env("FFMPEG_PATH", dir.join(format!("ffmpeg{exe}"))).env("FFPROBE_PATH", dir.join(format!("ffprobe{exe}")));
        }
        let child = cmd.spawn().map_err(|e| format!("could not start the API with {}: {e}", layout.node.display()))?;
        let mut api = Self { child, url, port, session: serde_json::Value::Null };
        api.wait_ready(port, data)?;
        api.session = api.local_session(port)?;
        Ok(api)
    }

    fn wait_ready(&mut self, port: u16, data: &Path) -> Result<(), String> {
        let t0 = Instant::now();
        while t0.elapsed() < API_BOOT {
            if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
                let log = std::fs::read_to_string(data.join("api.log")).unwrap_or_default();
                let tail: String = log.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
                return Err(format!("the API exited ({status}):\n{tail}"));
            }
            if http(port, "GET", "/bricks?slot=palette", None, None).map(|(code, _)| code == 200).unwrap_or(false) {
                return Ok(());
            }
            std::thread::sleep(POLL);
        }
        Err("the API did not start in time".into())
    }

    /// The single local account, signed in.
    fn local_session(&self, port: u16) -> Result<serde_json::Value, String> {
        let body = serde_json::json!({ "email": LOCAL_EMAIL, "name": LOCAL_NAME }).to_string();
        let (code, text) = http(port, "POST", "/auth/mock-google", Some(&body), None)?;
        if code != 201 && code != 200 {
            return Err(format!("local sign-in failed ({code}): {text}"));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    /// A call to the API as the local account; the JSON answer, or the API's error message.
    pub fn call(&self, method: &str, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        let token = self.session["token"].as_str().unwrap_or_default();
        let (code, text) = http(self.port, method, path, Some(&body.to_string()), Some(token))?;
        let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        if (200..300).contains(&code) {
            Ok(json)
        } else {
            Err(json["message"].as_str().map(String::from).unwrap_or_else(|| format!("the API answered {code}")))
        }
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A tiny blocking HTTP/1.1 call to the local API (no client crate needed for two requests).
fn http(port: u16, method: &str, path: &str, body: Option<&str>, token: Option<&str>) -> Result<(u16, String), String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(120))).ok();
    let body = body.unwrap_or("");
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let code = text.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or("bad HTTP answer")?;
    let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let payload = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(rest) } else { rest.to_string() };
    Ok((code, payload))
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = s.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || rest.len() < n {
            break;
        }
        out.push_str(&rest[..n]);
        s = rest[n..].trim_start_matches("\r\n");
    }
    out
}
