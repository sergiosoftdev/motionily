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
    /// `node <mcp_main>` starts the MCP server (bundled), or `tsx <mcp_main>` in the repo.
    pub mcp_command: PathBuf,
    pub mcp_main: PathBuf,
}

impl Layout {
    pub fn find(resources: Option<&Path>) -> Result<Self, String> {
        let node_override = std::env::var_os("MOTIONILY_NODE").map(PathBuf::from);
        if let Some(runtime) = resources.map(|r| r.join("runtime")).filter(|r| r.join("api/main.js").exists()) {
            let node = node_override.unwrap_or_else(|| runtime.join(if cfg!(windows) { "node/node.exe" } else { "node/bin/node" }));
            return Ok(Self {
                api_main: runtime.join("api/main.js"),
                api_cwd: runtime.join("api"),
                mcp_command: node.clone(),
                mcp_main: runtime.join("mcp/index.js"),
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
            mcp_main: mcp.join("src/index.ts"),
        })
    }
}

/// A free local port for the API.
fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
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
    pub session: serde_json::Value,
}

impl Api {
    /// Starts the API on a free port with its data in `data` and waits until it answers.
    pub fn start(layout: &Layout, data: &Path, web_origins: &str) -> Result<Self, String> {
        std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let port = free_port()?;
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
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        if layout.mcp_command == layout.node {
            cmd.env("MOTIONILY_MCP_BUNDLE", &layout.mcp_main);
        } else {
            cmd.env("MOTIONILY_MCP_DIR", layout.mcp_main.parent().and_then(Path::parent).unwrap_or(Path::new(".")));
        }
        let child = cmd.spawn().map_err(|e| format!("could not start the API with {}: {e}", layout.node.display()))?;
        let mut api = Self { child, url, session: serde_json::Value::Null };
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
            if http(port, "GET", "/bricks?slot=palette", None).map(|(code, _)| code == 200).unwrap_or(false) {
                return Ok(());
            }
            std::thread::sleep(POLL);
        }
        Err("the API did not start in time".into())
    }

    /// The single local account, signed in.
    fn local_session(&self, port: u16) -> Result<serde_json::Value, String> {
        let body = serde_json::json!({ "email": LOCAL_EMAIL, "name": LOCAL_NAME }).to_string();
        let (code, text) = http(port, "POST", "/auth/mock-google", Some(&body))?;
        if code != 201 && code != 200 {
            return Err(format!("local sign-in failed ({code}): {text}"));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
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
fn http(port: u16, method: &str, path: &str, body: Option<&str>) -> Result<(u16, String), String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let body = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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
