//! Video frames from the operating system's own decoders, in-process: AVFoundation (VideoToolbox) on
//! macOS and Media Foundation on Windows. A clip is read forward frame by frame; a jump backwards or
//! far ahead reopens the reader at the new time (no process to start, unlike piping ffmpeg), so
//! scrubbing and playback both stay quick. Frames come out as tightly packed RGBA, upright (the
//! file's rotation applied), at the video's display size.

/// Decode forward instead of reopening when the next frame asked for is at most this far ahead (s).
const MAX_FORWARD: f64 = 2.0;

/// What a reader produces: display size, frame rate, length.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Info {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
}

/// What each platform provides: open, (re)start reading at a time, and the next frame as RGBA.
trait Backend: Sized {
    fn open(path: &str) -> Result<(Self, Info), String>;
    /// Start reading at file second `t` (the first frame read is the one shown at `t`, or just before).
    fn seek(&mut self, t: f64) -> Result<(), String>;
    /// The next frame into `out` (resized to width × height × 4), and its time; None at the end.
    fn next(&mut self, out: &mut Vec<u8>) -> Result<Option<f64>, String>;
}

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac::Platform;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::Platform;

/// Whether this system has a native decoder (macOS, Windows); elsewhere use ffmpeg.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

/// One video file, read with the system's decoder.
#[cfg(any(target_os = "macos", windows))]
pub struct Reader {
    backend: Platform,
    info: Info,
    started: bool,
    /// The frame on screen and its time, and one read ahead that is not due yet.
    cur: Vec<u8>,
    cur_time: f64,
    has_cur: bool,
    ahead: Vec<u8>,
    ahead_time: Option<f64>,
}

#[cfg(any(target_os = "macos", windows))]
impl Reader {
    /// Open a local file. Fails when the system cannot decode it (the caller falls back to ffmpeg).
    pub fn open(path: &str) -> Result<Self, String> {
        let (backend, info) = Platform::open(path)?;
        if info.width == 0 || info.height == 0 {
            return Err(format!("{path}: no video size"));
        }
        Ok(Self { backend, info, started: false, cur: Vec::new(), cur_time: f64::NEG_INFINITY, has_cur: false, ahead: Vec::new(), ahead_time: None })
    }

    pub fn info(&self) -> Info {
        self.info
    }

    /// RGBA pixels of the frame shown at file second `t` (the last one past the end).
    pub fn frame_at(&mut self, t: f64) -> Result<&[u8], String> {
        let half = 0.5 / self.info.fps.max(1.0);
        // Past the end: the last frame.
        let t = if self.info.duration > 0.0 { t.min(self.info.duration - half) } else { t };
        if !self.started || t + half < self.cur_time || t > self.cur_time + MAX_FORWARD {
            self.backend.seek(t.max(0.0))?;
            self.started = true;
            self.has_cur = false;
            self.cur_time = f64::NEG_INFINITY;
            self.ahead_time = None;
        }
        loop {
            let next = match self.ahead_time {
                Some(at) => at,
                None => match self.backend.next(&mut self.ahead)? {
                    Some(at) => {
                        self.ahead_time = Some(at);
                        at
                    }
                    None => break,
                },
            };
            // Due (or the first frame after a seek): it becomes the current one.
            if next <= t + half || !self.has_cur {
                std::mem::swap(&mut self.cur, &mut self.ahead);
                self.cur_time = next;
                self.has_cur = true;
                self.ahead_time = None;
            } else {
                break;
            }
        }
        if !self.has_cur {
            return Err(format!("no frame at {t:.2}s"));
        }
        Ok(&self.cur)
    }
}

/// BGRA rows (with padding) → tightly packed RGBA, opaque, turned `turns` quarter turns clockwise.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn bgra_to_rgba(src: &[u8], stride: usize, w: usize, h: usize, turns: u8, out: &mut Vec<u8>) {
    out.resize(w * h * 4, 0);
    // Output size and, for each output pixel, where it comes from.
    let ow = if turns % 2 == 1 { h } else { w };
    for oy in 0..(w * h / ow) {
        for ox in 0..ow {
            let (x, y) = match turns % 4 {
                0 => (ox, oy),
                1 => (oy, h - 1 - ox),
                2 => (w - 1 - ox, h - 1 - oy),
                _ => (w - 1 - oy, ox),
            };
            let s = &src[y * stride + x * 4..y * stride + x * 4 + 4];
            let d = &mut out[(oy * ow + ox) * 4..(oy * ow + ox) * 4 + 4];
            d[0] = s[2];
            d[1] = s[1];
            d[2] = s[0];
            d[3] = 255;
        }
    }
}

#[cfg(all(test, any(target_os = "macos", windows)))]
mod tests {
    use super::*;
    use std::process::Command;

    /// A 4 s clip: red for 1 s, green, blue, then white; 320×240 at 25 fps (made with ffmpeg if present).
    fn clip(rotate: Option<i32>) -> Option<std::path::PathBuf> {
        let dir = std::env::temp_dir().join(format!("native-video-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join(format!("bands{}.mp4", rotate.map_or(String::new(), |r| format!("-r{r}"))));
        let colors = ["red", "green", "blue", "white"];
        let inputs: Vec<String> = colors.iter().flat_map(|c| ["-f".into(), "lavfi".into(), "-i".into(), format!("color=c={c}:s=320x240:r=25:d=1")]).collect();
        let _ = rotate;
        let ok = Command::new("ffmpeg")
            .args(["-loglevel", "error", "-y"])
            .args(&inputs)
            .args(["-filter_complex", "concat=n=4:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25"])
            .arg(&path)
            .status()
            .ok()?
            .success();
        ok.then_some(path)
    }

    /// Without ffmpeg there is nothing to compare with; CI sets `NATIVE_VIDEO_REQUIRE_FFMPEG` so it cannot pass by skipping.
    fn skip() {
        assert!(std::env::var_os("NATIVE_VIDEO_REQUIRE_FFMPEG").is_none(), "ffmpeg is required here");
        eprintln!("ffmpeg not found: skipped");
    }

    fn color(px: &[u8], width: u32, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * width + x) * 4) as usize;
        [px[i], px[i + 1], px[i + 2]]
    }

    fn close(a: [u8; 3], b: [u8; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| (*x as i32 - y as i32).abs() < 40)
    }

    #[test]
    fn frames_at_times_forward_back_and_after_jumps() {
        let Some(path) = clip(None) else { return skip() };
        let mut r = Reader::open(path.to_str().unwrap()).expect("open");
        let info = r.info();
        assert_eq!((info.width, info.height), (320, 240));
        assert!((info.fps - 25.0).abs() < 0.5, "fps {}", info.fps);
        assert!((info.duration - 4.0).abs() < 0.1, "duration {}", info.duration);
        let at = |r: &mut Reader, t: f64| color(r.frame_at(t).unwrap(), 320, 160, 120);
        assert!(close(at(&mut r, 0.5), [255, 0, 0]), "red at 0.5");
        assert!(close(at(&mut r, 1.5), [0, 128, 0]), "green at 1.5 (decoded forward)");
        assert!(close(at(&mut r, 3.5), [255, 255, 255]), "white at 3.5 (a jump: reopened)");
        assert!(close(at(&mut r, 0.2), [255, 0, 0]), "red again at 0.2 (backwards)");
        assert!(close(at(&mut r, 2.04), [0, 0, 255]), "blue right after the 2 s cut");
        assert!(close(at(&mut r, 9.0), [255, 255, 255]), "past the end: the last frame");
    }

    /// An asymmetric picture (ffmpeg's test pattern) with a display rotation of `degrees`; H.264 High 4:2:0, as phones
    /// record (Media Foundation has no 4:4:4 decoder).
    fn rotated(degrees: i32) -> Option<std::path::PathBuf> {
        let dir = std::env::temp_dir().join(format!("native-video-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let plain = dir.join("pattern.mp4");
        let path = dir.join(format!("pattern-{degrees}.mp4"));
        let ok = Command::new("ffmpeg").args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "8"]).arg(&plain).status().ok()?.success()
            && Command::new("ffmpeg").args(["-loglevel", "error", "-y", "-display_rotation:v:0", &degrees.to_string(), "-i"]).arg(&plain).args(["-c", "copy"]).arg(&path).status().ok()?.success();
        ok.then_some(path)
    }

    /// ffmpeg's own upright frame at `t` (it applies the display rotation), RGBA.
    fn ffmpeg_frame(path: &std::path::Path, t: f64) -> Vec<u8> {
        Command::new("ffmpeg").args(["-loglevel", "error", "-ss", &t.to_string(), "-i"]).arg(path).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).output().expect("ffmpeg").stdout
    }

    #[test]
    fn rotation_matches_ffmpeg() {
        for degrees in [90, 180, 270] {
            let Some(path) = rotated(degrees) else { return skip() };
            let mut r = Reader::open(path.to_str().unwrap()).expect("open");
            let info = r.info();
            let want = ffmpeg_frame(&path, 0.5);
            let got = r.frame_at(0.5).unwrap().to_vec();
            assert_eq!(got.len(), want.len(), "{degrees}°: size {}x{}", info.width, info.height);
            let diff: f64 = got.iter().zip(&want).map(|(a, b)| (*a as f64 - *b as f64).abs()).sum::<f64>() / got.len() as f64;
            assert!(diff < 8.0, "{degrees}°: mean difference {diff:.1} from ffmpeg's upright frame ({}x{})", info.width, info.height);
        }
    }
}
