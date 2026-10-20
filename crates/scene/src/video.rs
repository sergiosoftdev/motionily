//! Video clip layers: which frame of the file a layer shows at each instant.
//!
//! The scene only does the timing math (trim, speed, loop, the layer's own time remap). The host
//! decodes the file and uploads that exact frame under [`frame_key`] before each render, so any
//! frame renders the same in any order (export, scrubbing, review).

use crate::{DrawItem, ImageFit, Scene};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;

/// Fastest playback rate a clip accepts (and the fastest a browser plays its sound).
pub const MAX_SPEED: f32 = 16.0;
/// Frames are fetched to the millisecond: finer than any real frame rate (240 fps = 4.2 ms).
const FRAME_MS: f32 = 1000.0;
/// A clip that ran out holds this far before its end, so the decoder still returns its last frame.
const END_HOLD: f32 = 1e-3;
/// Window (s) used to measure how fast the layer clock runs (for the clip's sound).
const RATE_PROBE: f32 = 0.05;

thread_local! {
    /// Duration (s) of each video file the host opened, by src. A fact about the file, shared by
    /// every scene on this thread; until it is known an unbounded clip never wraps.
    static DURATIONS: RefCell<HashMap<String, f32>> = RefCell::new(HashMap::new());
}

/// Record how long a video file is (the host calls it once the file is open).
pub fn set_media_duration(src: &str, seconds: f32) {
    if seconds.is_finite() && seconds > 0.0 {
        DURATIONS.with(|d| d.borrow_mut().insert(src.to_owned(), seconds));
    }
}

pub fn media_duration(src: &str) -> Option<f32> {
    DURATIONS.with(|d| d.borrow().get(src).copied())
}

/// `{"type":"video","src":"/media/….mp4","fit":"cover","in":2,"out":8,"speed":1,"loop":true,"volume":0}`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoClip {
    /// A `/media/…` file the user uploaded (mp4, webm or mov).
    pub src: String,
    #[serde(default)]
    pub fit: ImageFit,
    /// File second the clip starts at.
    #[serde(rename = "in", default, skip_serializing_if = "is_zero")]
    pub trim_in: f32,
    /// File second the clip ends at (`None` = the end of the file).
    #[serde(rename = "out", default, skip_serializing_if = "Option::is_none")]
    pub trim_out: Option<f32>,
    /// Playback rate (0.25 = quarter speed, 2 = double). Ramps and freezes: the layer's `time`.
    #[serde(default = "unit", skip_serializing_if = "is_unit")]
    pub speed: f32,
    /// Wrap from `out` back to `in` instead of holding the last frame.
    #[serde(rename = "loop", default, skip_serializing_if = "std::ops::Not::not")]
    pub looping: bool,
    /// Clip sound, 0 (muted, the default) to 1.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub volume: f32,
}

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}
fn unit() -> f32 {
    1.0
}
fn is_unit(v: &f32) -> bool {
    *v == 1.0
}

impl VideoClip {
    /// Why this clip is invalid, if it is.
    pub fn check(&self) -> Result<(), &'static str> {
        if !self.src.starts_with("/media/") && !self.src.starts_with("http") && !self.src.starts_with("blob:") {
            return Err("video src must be a /media/… file from get_brand or the user");
        }
        if !(self.trim_in >= 0.0) || self.trim_out.is_some_and(|o| !(o > self.trim_in)) {
            return Err("video needs in >= 0 and out > in");
        }
        if !(self.speed > 0.0 && self.speed <= MAX_SPEED) {
            return Err("video speed must be > 0 and <= 16 (freeze or reverse with time=)");
        }
        if !(0.0..=1.0).contains(&self.volume) {
            return Err("video volume must be 0..1");
        }
        Ok(())
    }

    /// Seconds into the file shown at layer time `lt` (after the layer's time remap), for a file
    /// `file_duration` long (unknown: the clip never wraps). Before `in`: `in`; past `out`: the last
    /// frame holds, or with `loop` it wraps back to `in`.
    pub fn media_time(&self, lt: f32, file_duration: Option<f32>) -> f32 {
        let start = self.trim_in.max(0.0);
        let played = lt.max(0.0) * self.speed.clamp(0.0, MAX_SPEED);
        let end = self.trim_out.map_or(file_duration, |o| Some(file_duration.map_or(o, |d| o.min(d)))).filter(|e| *e > start);
        match end {
            Some(end) if self.looping => start + played.rem_euclid(end - start),
            Some(end) => (start + played).min(end - END_HOLD).max(start),
            None => start + played,
        }
    }

    /// Short description for summaries: `in=2 out=8 x0.5 loop vol=0.4`.
    pub fn describe(&self) -> String {
        let mut s = format!("in={}", self.trim_in);
        if let Some(o) = self.trim_out {
            s += &format!(" out={o}");
        }
        if self.speed != 1.0 {
            s += &format!(" x{}", self.speed);
        }
        if self.looping {
            s += " loop";
        }
        if self.volume > 0.0 {
            s += &format!(" vol={}", self.volume);
        }
        s
    }
}

/// Media time rounded to the millisecond the frame is fetched at.
pub fn quantize(seconds: f32) -> f32 {
    (seconds * FRAME_MS).round() / FRAME_MS
}

/// Texture key of the frame of `src` at `seconds` (already quantized).
pub fn frame_key(src: &str, seconds: f32) -> String {
    format!("{src}#{}", (seconds * FRAME_MS).round() as i64)
}

/// One decoded frame a render needs: upload the frame of `src` shown at `time` (file seconds)
/// under `key` before drawing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FrameNeed {
    pub key: String,
    pub src: String,
    pub time: f32,
}

/// What a video layer plays at one instant (for its sound and for measuring).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClipState {
    pub id: String,
    pub src: String,
    /// File second shown.
    pub time: f32,
    /// File seconds advanced per video second right now (speed × the time remap's slope; 0 = frozen).
    pub rate: f32,
    pub volume: f32,
}

impl Scene {
    /// Video files the layers use (for the host to open).
    pub fn video_sources(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .layers
            .iter()
            .filter_map(|l| match &l.content {
                crate::LayerContent::Video { clip } => Some(clip.src.clone()),
                _ => None,
            })
            .collect();
        v.sort();
        v.dedup();
        v
    }

    /// Every video frame a render at `t` draws (repeater copies, motion-blur samples, mattes and
    /// transitions included), once each.
    pub fn video_frames(&self, t: f32) -> Vec<FrameNeed> {
        if !self.layers.iter().any(|l| matches!(l.content, crate::LayerContent::Video { .. })) {
            return Vec::new();
        }
        let mut out: Vec<FrameNeed> = Vec::new();
        collect_frames(&self.frame(t), &mut out);
        out
    }

    /// Each active video layer's clip state at `t` (repeater copies ignored).
    pub fn video_clips(&self, t: f32) -> Vec<ClipState> {
        self.layers
            .iter()
            .filter(|l| self.active(l, t))
            .filter_map(|l| {
                let crate::LayerContent::Video { clip } = &l.content else { return None };
                let duration = media_duration(&clip.src);
                let (lt, ahead) = crate::expr::with_vars(t, 0.0, 1.0, || (l.local_time(t), l.local_time(t + RATE_PROBE)));
                let time = clip.media_time(lt, duration);
                let next = clip.media_time(ahead, duration);
                // A wrap (loop) or a jump is not a rate: measure the clock itself then.
                let rate = if next >= time { (next - time) / RATE_PROBE } else { clip.speed * (ahead - lt) / RATE_PROBE };
                Some(ClipState { id: l.id.clone(), src: clip.src.clone(), time, rate: rate.max(0.0), volume: clip.volume })
            })
            .collect()
    }
}

fn collect_frames(items: &[DrawItem], out: &mut Vec<FrameNeed>) {
    for item in items {
        match item {
            DrawItem::Image(img) => {
                if let Some(time) = img.frame {
                    let key = frame_key(&img.src, time);
                    if !out.iter().any(|n| n.key == key) {
                        out.push(FrameNeed { key, src: img.src.clone(), time });
                    }
                }
            }
            DrawItem::Group(items) => collect_frames(items, out),
            DrawItem::Fx(fx) => {
                collect_frames(&fx.items, out);
                if let Some((matte, _)) = &fx.matte {
                    collect_frames(matte, out);
                }
                for s in &fx.samples {
                    collect_frames(s, out);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LayerContent, Op};

    fn clip(json: &str) -> VideoClip {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn media_time_trims_speeds_holds_and_loops() {
        let c = clip(r#"{"src":"/media/a.mp4","in":2,"out":6}"#);
        assert_eq!(c.media_time(0.0, Some(10.0)), 2.0);
        assert_eq!(c.media_time(1.5, Some(10.0)), 3.5);
        // Past `out` the last frame holds (1 ms before the end).
        assert!((c.media_time(9.0, Some(10.0)) - 5.999).abs() < 1e-4);
        // Negative layer time (time remap) shows the first frame.
        assert_eq!(c.media_time(-1.0, Some(10.0)), 2.0);
        let fast = clip(r#"{"src":"/media/a.mp4","in":1,"speed":2}"#);
        assert_eq!(fast.media_time(1.0, Some(10.0)), 3.0);
        // Without `out` the file end bounds it; unknown duration never wraps.
        assert!((fast.media_time(20.0, Some(10.0)) - 9.999).abs() < 1e-4);
        assert_eq!(fast.media_time(20.0, None), 41.0);
        let lp = clip(r#"{"src":"/media/a.mp4","in":1,"out":3,"loop":true}"#);
        assert_eq!(lp.media_time(2.5, Some(10.0)), 1.5);
        assert_eq!(lp.media_time(4.0, Some(10.0)), 1.0);
        // `out` past the end of the file is cut to the file.
        let long = clip(r#"{"src":"/media/a.mp4","out":30,"loop":true}"#);
        assert_eq!(long.media_time(12.0, Some(10.0)), 2.0);
    }

    #[test]
    fn clips_validate_and_round_trip() {
        let c = clip(r#"{"src":"/media/a.mp4","in":2,"out":6,"speed":0.5,"loop":true,"volume":0.4}"#);
        assert!(c.check().is_ok());
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains(r#""in":2.0"#) && json.contains(r#""out":6.0"#) && json.contains(r#""loop":true"#), "{json}");
        assert_eq!(clip(&json), c);
        assert!(clip(r#"{"src":"/media/a.mp4","in":4,"out":2}"#).check().is_err());
        assert!(clip(r#"{"src":"/media/a.mp4","speed":0}"#).check().is_err());
        assert!(clip(r#"{"src":"/media/a.mp4","volume":2}"#).check().is_err());
        assert!(clip(r#"{"src":"a.mp4"}"#).check().is_err());
        // Defaults stay out of the JSON.
        assert_eq!(serde_json::to_string(&clip(r#"{"src":"/media/a.mp4"}"#)).unwrap(), r#"{"src":"/media/a.mp4","fit":"cover"}"#);
    }

    #[test]
    fn scene_lists_the_exact_frames_a_render_needs() {
        let mut scene = Scene::default();
        let layer = |json: &str| Op::AddLayer { layer: serde_json::from_str(json).unwrap() };
        scene
            .apply(&[
                layer(r#"{"id":"clip","type":"video","src":"/media/v.mp4","in":1,"start":0.5,"x":540,"y":960,"w":800,"h":450}"#),
                layer(r#"{"id":"wall","type":"video","src":"/media/v.mp4","x":540,"y":300,"w":200,"h":200,"repeat":{"count":3,"x":210,"y":0,"delay":0.25}}"#),
            ])
            .unwrap();
        assert!(matches!(scene.layers[0].content, LayerContent::Video { .. }));
        set_media_duration("/media/v.mp4", 4.0);
        let needs = scene.video_frames(1.0);
        let times: Vec<f32> = needs.iter().map(|n| n.time).collect();
        // clip: in 1 + (1.0 - 0.5); wall copies at 1.0, 0.75, 0.5 (delay 0.25 each).
        assert_eq!(times, [1.5, 1.0, 0.75, 0.5]);
        assert_eq!(needs[0].key, "/media/v.mp4#1500");
        assert_eq!(scene.video_sources(), ["/media/v.mp4"]);
        // Same instant, same frames (any order).
        assert_eq!(scene.video_frames(1.0), needs);
        let clips = scene.video_clips(1.0);
        assert_eq!(clips.len(), 2);
        assert!((clips[0].rate - 1.0).abs() < 1e-3 && clips[0].time == 1.5);
        assert!(scene.summary().contains("video v.mp4 in=1"));
        // Bounds are the layer box, like an image.
        let b = scene.layer_bounds("clip", 1.0).unwrap();
        assert_eq!(b.size, [800.0, 450.0]);
        // Invalid clips are rejected by add_layer.
        assert!(scene.apply(&[layer(r#"{"id":"bad","type":"video","src":"/media/v.mp4","speed":-1,"w":1,"h":1}"#)]).is_err());
    }
}
