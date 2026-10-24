//! ffmpeg as a child process: it decodes the scene's video clips (hardware decoding where the OS
//! has it) and encodes exports. The app ships its own ffmpeg in `runtime/ffmpeg/`; a system one on
//! PATH works too.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Seek instead of decoding forward when a clip jumps further than this (seconds).
const MAX_FORWARD_DECODE: f64 = 2.0;
/// Decoded clips are scaled down to this long side at most: bigger frames only cost memory.
const MAX_CLIP_SIDE: u32 = 3840;

#[derive(Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// `runtime/ffmpeg/` of the packaged app, MOTIONILY_FFMPEG, or ffmpeg on PATH.
    pub fn find(runtime: Option<&Path>) -> Self {
        let exe = |name: &str| if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
        if let Ok(dir) = std::env::var("MOTIONILY_FFMPEG_DIR") {
            let dir = PathBuf::from(dir);
            return Self { ffmpeg: dir.join(exe("ffmpeg")), ffprobe: dir.join(exe("ffprobe")) };
        }
        if let Some(dir) = runtime.map(|r| r.join("ffmpeg")).filter(|d| d.join(exe("ffmpeg")).exists()) {
            return Self { ffmpeg: dir.join(exe("ffmpeg")), ffprobe: dir.join(exe("ffprobe")) };
        }
        Self { ffmpeg: PathBuf::from("ffmpeg"), ffprobe: PathBuf::from("ffprobe") }
    }

    pub fn encoders(&self) -> String {
        Command::new(&self.ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    }

    /// Width, height, frame rate and duration of a video file's first video stream.
    pub fn probe(&self, input: &str) -> Result<Probe, String> {
        let out = Command::new(&self.ffprobe)
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:format=duration", "-of", "json", input])
            .output()
            .map_err(|e| format!("ffprobe: {e}"))?;
        if !out.status.success() {
            return Err(format!("ffprobe could not read {input}: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        let s = &v["streams"][0];
        let rate = |k: &str| {
            let r = s[k].as_str().unwrap_or("0/1");
            let (n, d) = r.split_once('/').unwrap_or((r, "1"));
            n.parse::<f64>().unwrap_or(0.0) / d.parse::<f64>().unwrap_or(1.0).max(1.0)
        };
        let fps = [rate("avg_frame_rate"), rate("r_frame_rate"), 30.0].into_iter().find(|f| f.is_finite() && *f > 0.0).unwrap_or(30.0);
        Ok(Probe {
            width: s["width"].as_u64().unwrap_or(0) as u32,
            height: s["height"].as_u64().unwrap_or(0) as u32,
            fps,
            duration: v["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0),
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Probe {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
}

/// One clip decoded forward as RGBA frames, restarted with a seek when playback jumps.
struct Decoder {
    input: String,
    size: (u32, u32),
    fps: f64,
    child: Option<Child>,
    stdout: Option<ChildStdout>,
    /// File time of the frame in `frame`, and the next frame's.
    time: f64,
    frame: Vec<u8>,
    has_frame: bool,
}

impl Decoder {
    fn new(probe: Probe, input: String) -> Self {
        let k = (MAX_CLIP_SIDE as f64 / probe.width.max(probe.height).max(1) as f64).min(1.0);
        let even = |v: f64| ((v * k / 2.0).round() as u32 * 2).max(2);
        let size = (even(probe.width as f64), even(probe.height as f64));
        Self { input, size, fps: probe.fps, child: None, stdout: None, time: f64::NEG_INFINITY, frame: vec![0; (size.0 * size.1 * 4) as usize], has_frame: false }
    }

    fn start(&mut self, tools: &Tools, at: f64) -> Result<(), String> {
        self.stop();
        let mut child = Command::new(&tools.ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-hwaccel", "auto", "-ss"])
            .arg(format!("{:.4}", at.max(0.0)))
            .args(["-i", &self.input, "-an", "-sn", "-vf"])
            .arg(format!("scale={}:{}:flags=bicubic", self.size.0, self.size.1))
            .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        self.stdout = child.stdout.take();
        self.child = Some(child);
        // The first frame read lands on the seek point.
        self.time = at.max(0.0) - 1.0 / self.fps;
        self.has_frame = false;
        Ok(())
    }

    fn read_frame(&mut self) -> bool {
        let Some(out) = self.stdout.as_mut() else { return false };
        if out.read_exact(&mut self.frame).is_err() {
            return false;
        }
        self.time += 1.0 / self.fps;
        self.has_frame = true;
        true
    }

    /// The frame shown at file second `t` (the last one when the clip has ended).
    fn frame_at(&mut self, tools: &Tools, t: f64) -> Result<&[u8], String> {
        let half = 0.5 / self.fps;
        if self.child.is_none() || t < self.time - half || t > self.time + MAX_FORWARD_DECODE {
            self.start(tools, t)?;
        }
        while self.time + 1.0 / self.fps <= t + half {
            if !self.read_frame() {
                break;
            }
        }
        if !self.has_frame && !self.read_frame() {
            return Err(format!("no frame at {t:.2}s in {}", self.input));
        }
        Ok(&self.frame)
    }

    fn stop(&mut self) {
        self.stdout = None;
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Every clip a render needs, by scene source; `resolve` turns a scene src into a path or URL.
pub struct Clips {
    tools: Tools,
    decoders: HashMap<String, Decoder>,
    resolve: Box<dyn Fn(&str) -> String + Send>,
}

impl Clips {
    pub fn new(tools: Tools, resolve: Box<dyn Fn(&str) -> String + Send>) -> Self {
        Self { tools, decoders: HashMap::new(), resolve }
    }

    /// Opens `src` (probing size, rate and duration) the first time it is asked for.
    pub fn open(&mut self, src: &str) -> Result<Probe, String> {
        let input = (self.resolve)(src);
        let probe = self.tools.probe(&input)?;
        self.decoders.entry(src.to_string()).or_insert_with(|| Decoder::new(probe, input));
        Ok(probe)
    }

    /// RGBA pixels and size of `src` at file second `t`.
    pub fn frame(&mut self, src: &str, t: f64) -> Result<(&[u8], (u32, u32)), String> {
        if !self.decoders.contains_key(src) {
            self.open(src)?;
        }
        let d = self.decoders.get_mut(src).expect("opened above");
        let size = d.size;
        let px = d.frame_at(&self.tools, t)?;
        Ok((px, size))
    }
}

/// Output codecs the exporter offers.
#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    /// H.264 in MP4: plays everywhere.
    H264,
    /// HEVC 10-bit in MP4: smaller files, HDR-ready.
    Hevc,
    /// ProRes 422 HQ in MOV: for further editing.
    Prores,
}

impl Codec {
    pub fn extension(self) -> &'static str {
        match self {
            Codec::Prores => "mov",
            _ => "mp4",
        }
    }

    /// ffmpeg arguments for the best encoder this ffmpeg has.
    fn video_args(self, encoders: &str) -> Vec<String> {
        let has = |e: &str| encoders.lines().any(|l| l.split_whitespace().nth(1) == Some(e));
        let v: Vec<&str> = match self {
            Codec::H264 if has("libx264") => vec!["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
            Codec::H264 if has("h264_videotoolbox") => vec!["-c:v", "h264_videotoolbox", "-q:v", "70", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
            Codec::H264 => vec!["-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p"],
            Codec::Hevc if has("libx265") => vec!["-c:v", "libx265", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-movflags", "+faststart"],
            Codec::Hevc => vec!["-c:v", "hevc_videotoolbox", "-q:v", "70", "-pix_fmt", "p010le", "-tag:v", "hvc1", "-movflags", "+faststart"],
            Codec::Prores if has("prores_ks") => vec!["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"],
            Codec::Prores => vec!["-c:v", "prores_videotoolbox", "-profile:v", "hq"],
        };
        v.into_iter().map(String::from).collect()
    }

    fn audio_args(self) -> Vec<String> {
        match self {
            Codec::Prores => vec!["-c:a".into(), "pcm_s16le".into()],
            _ => vec!["-c:a".into(), "aac".into(), "-b:a".into(), "256k".into()],
        }
    }
}

/// An encoder fed raw RGBA frames on stdin; the audio (a WAV) is muxed in.
pub struct Encoder {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl Encoder {
    pub fn start(tools: &Tools, out: &Path, size: (u32, u32), fps: f32, codec: Codec, audio: Option<&Path>) -> Result<Self, String> {
        let encoders = tools.encoders();
        let mut cmd = Command::new(&tools.ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s"])
            .arg(format!("{}x{}", size.0, size.1))
            .arg("-r")
            .arg(format!("{fps}"))
            .args(["-i", "-"]);
        if let Some(a) = audio {
            cmd.arg("-i").arg(a);
        }
        cmd.args(codec.video_args(&encoders));
        if audio.is_some() {
            cmd.args(codec.audio_args()).arg("-shortest");
        }
        let mut child = cmd.arg(out).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ffmpeg: {e}"))?;
        let stdin = child.stdin.take();
        Ok(Self { child, stdin })
    }

    pub fn frame(&mut self, rgba: &[u8]) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("encoder closed")?;
        stdin.write_all(rgba).map_err(|e| format!("ffmpeg stopped reading frames: {e}"))
    }

    pub fn finish(mut self) -> Result<(), String> {
        drop(self.stdin.take());
        let out = self.child.wait_with_output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    }

    pub fn cancel(mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
