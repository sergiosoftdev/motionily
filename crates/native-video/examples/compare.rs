//! Native decoding against the ffmpeg pipe the desktop app used: `cargo run -p native-video --release --example compare -- clip.mp4`.
//! Sequential decoding (every frame of the clip) and seeks (jumps to random times, first frame out).

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Instant;

fn ffmpeg_from(path: &str, t: f64, w: u32, h: u32, frames: usize) -> f64 {
    let start = Instant::now();
    let mut child = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-hwaccel", "auto", "-ss", &format!("{t:.4}"), "-i", path, "-an", "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("ffmpeg");
    let mut out = child.stdout.take().unwrap();
    let mut buf = vec![0u8; (w * h * 4) as usize];
    for _ in 0..frames {
        if out.read_exact(&mut buf).is_err() {
            break;
        }
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    let _ = child.kill();
    let _ = child.wait();
    ms
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: compare <clip>");
    let mut r = native_video::Reader::open(&path).expect("open");
    let info = r.info();
    let n = (info.duration * info.fps).floor() as usize;
    println!("{path}: {}x{} @{:.2} fps, {:.1} s, {n} frames", info.width, info.height, info.fps, info.duration);

    let start = Instant::now();
    for i in 0..n {
        r.frame_at(i as f64 / info.fps).expect("frame");
    }
    let native_seq = start.elapsed().as_secs_f64() * 1000.0;
    let ffmpeg_seq = ffmpeg_from(&path, 0.0, info.width, info.height, n);

    let times: Vec<f64> = (0..20).map(|i| ((i * 7919) % 97) as f64 / 97.0 * (info.duration - 0.5)).collect();
    let mut native_seek = Vec::new();
    let mut ffmpeg_seek = Vec::new();
    for &t in &times {
        let s = Instant::now();
        r.frame_at(t).expect("seek frame");
        native_seek.push(s.elapsed().as_secs_f64() * 1000.0);
        ffmpeg_seek.push(ffmpeg_from(&path, t, info.width, info.height, 1));
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    println!("sequential, all frames: native {:.0} ms ({:.2} ms/frame) · ffmpeg pipe {:.0} ms ({:.2} ms/frame)", native_seq, native_seq / n as f64, ffmpeg_seq, ffmpeg_seq / n as f64);
    println!("seek to a random time, median: native {:.1} ms · ffmpeg (new process) {:.1} ms", med(&mut native_seek), med(&mut ffmpeg_seek));
}
