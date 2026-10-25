//! Video clip layers: which frame of the file a layer shows at each instant.
//!
//! The scene only does the timing math (trim, speed, loop, the layer's own time remap). The host
//! decodes the file and uploads that exact frame under [`frame_key`] before each render, so any
//! frame renders the same in any order (export, scrubbing, review).

use crate::{Animated, DrawItem, ImageFit, Scene};
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
    /// Clip sound, 0 (muted, the default) to 1. Keyframes (seconds from the layer start, like any
    /// property) make fades and dips: `[{"t":0,"v":0},{"t":0.5,"v":1,"ease":"linear"}]`.
    #[serde(default, skip_serializing_if = "is_muted")]
    pub volume: Animated,
    /// Where the clip's sound sits, −1 (left) .. 1 (right); animatable like `volume`. The track's pan adds to it.
    #[serde(default, skip_serializing_if = "is_muted")]
    pub pan: Animated,
    /// EQ, compressor and limiter on the clip's sound (see `audio_fx`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_fx: Option<crate::audio_fx::AudioFx>,
}

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}
fn is_muted(v: &Animated) -> bool {
    matches!(v, Animated::Static(x) if *x == 0.0)
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
        if let Some(fx) = &self.audio_fx {
            fx.check()?;
        }
        match &self.volume {
            Animated::Static(v) if !(0.0..=1.0).contains(v) => return Err("video volume must be 0..1"),
            Animated::Keys(keys) if keys.iter().any(|k| !(0.0..=1.0).contains(&k.v)) => return Err("video volume keyframes must be 0..1"),
            Animated::Keys(keys) if keys.windows(2).any(|w| w[1].t < w[0].t) => return Err("video volume keyframes must be in time order"),
            _ => {}
        }
        Ok(())
    }

    /// Sound level at layer time `lt` (expressions are clamped to 0..1).
    pub fn volume_at(&self, lt: f32) -> f32 {
        self.volume.sample(lt).clamp(0.0, 1.0)
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
        match &self.volume {
            Animated::Static(v) if *v > 0.0 => s += &format!(" vol={v}"),
            Animated::Static(_) => {}
            Animated::Keys(keys) => s += &format!(" vol={}", keys.iter().map(|k| k.v.to_string()).collect::<Vec<_>>().join(">")),
            Animated::Expr(e) => s += &format!(" vol=\"{}\"", e.src),
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
    /// −1 (left) .. 1 (right): the clip's pan plus its track's.
    pub pan: f32,
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
        // Clips inside components (compound clips) are decoded too.
        for c in self.library.components.values() {
            v.extend(c.layers.iter().filter(|l| l.get("type").and_then(serde_json::Value::as_str) == Some("video")).filter_map(|l| l.get("src")?.as_str().map(str::to_owned)));
        }
        v.sort();
        v.dedup();
        v
    }

    /// Every video frame a render at `t` draws (repeater copies, motion-blur samples, mattes and
    /// transitions included), once each.
    pub fn video_frames(&self, t: f32) -> Vec<FrameNeed> {
        let in_components = || self.library.components.values().any(|c| c.layers.iter().any(|l| l.get("type").and_then(serde_json::Value::as_str) == Some("video")));
        if !self.layers.iter().any(|l| l.content.media_clip().is_some()) && !in_components() {
            return Vec::new();
        }
        let mut out: Vec<FrameNeed> = Vec::new();
        collect_frames(&self.frame(t), &mut out);
        out
    }

    /// Each active video layer's clip state at `t` (repeater copies ignored), clips inside active
    /// component instances (compound clips) included as `instance/layer`.
    pub fn video_clips(&self, t: f32) -> Vec<ClipState> {
        let mut out = Vec::new();
        for l in self.layers.iter().filter(|l| self.active(l, t)) {
            let gain = self.track_gain(l);
            let pan = self.track_pan(l);
            self.clip_states(l, l.local_time(t), l.local_time(t + RATE_PROBE), t, "", gain, pan, 0, &mut out);
        }
        out
    }

    /// The sound state of `l` at its local time `lt` (`ahead` = its local time `RATE_PROBE` later), or of
    /// the clips inside it when it is an instance; `gain` and `pan` come from the top-level track.
    #[allow(clippy::too_many_arguments)]
    fn clip_states(&self, l: &crate::Layer, lt: f32, ahead: f32, t: f32, prefix: &str, gain: f32, pan: f32, depth: u8, out: &mut Vec<ClipState>) {
        if let crate::LayerContent::Use { .. } = &l.content {
            if depth >= crate::component::MAX_COMPONENT_DEPTH {
                return;
            }
            let Some(bound) = l.bound(&self.library) else { return };
            for child in &bound.layers {
                // Component clock: a child without `end` lasts as long as the instance.
                if lt < child.start || child.end.is_some_and(|e| lt >= e) {
                    continue;
                }
                let path = format!("{prefix}{}/", l.id);
                self.clip_states(child, child.local_time(lt), child.local_time(ahead), t, &path, gain, pan, depth + 1, out);
            }
            return;
        }
        let Some(clip) = l.content.media_clip() else { return };
        let duration = media_duration(&clip.src);
        let (volume, clip_pan) = crate::expr::with_vars(t, 0.0, 1.0, || (clip.volume_at(lt) * gain, (clip.pan.sample(lt) + pan).clamp(-1.0, 1.0)));
        let time = clip.media_time(lt, duration);
        let next = clip.media_time(ahead, duration);
        // A wrap (loop) or a jump is not a rate: measure the clock itself then.
        let rate = if next >= time { (next - time) / RATE_PROBE } else { clip.speed * (ahead - lt) / RATE_PROBE };
        out.push(ClipState { id: format!("{prefix}{}", l.id), src: clip.src.clone(), time, rate: rate.max(0.0), volume, pan: clip_pan });
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
    fn volume_takes_keyframes() {
        let c = clip(r#"{"src":"/media/a.mp4","volume":[{"t":0,"v":0,"ease":"linear"},{"t":1,"v":0.8}]}"#);
        assert!(c.check().is_ok());
        assert_eq!(c.volume_at(-1.0), 0.0);
        assert!((c.volume_at(0.5) - 0.4).abs() < 1e-4);
        assert_eq!(c.volume_at(3.0), 0.8);
        assert!(c.describe().contains("vol=0>0.8"), "{}", c.describe());
        assert!(clip(r#"{"src":"/media/a.mp4","volume":[{"t":0,"v":1.5}]}"#).check().is_err());
        assert!(clip(r#"{"src":"/media/a.mp4","volume":[{"t":1,"v":1},{"t":0,"v":0}]}"#).check().is_err());
        // Each instant's level reaches the clip state the host mixes.
        let mut scene = Scene::default();
        scene
            .apply(&[Op::AddLayer {
                layer: serde_json::from_str(r#"{"id":"c","type":"video","src":"/media/k.mp4","start":2,"w":10,"h":10,"volume":[{"t":0,"v":1,"ease":"linear"},{"t":2,"v":0}]}"#).unwrap(),
            }])
            .unwrap();
        let v = scene.video_clips(3.0)[0].volume;
        assert!((v - 0.5).abs() < 1e-3, "{v}");
    }

    #[test]
    fn audio_clips_play_and_cut_like_video_but_draw_nothing() {
        let mut scene = Scene { duration: 10.0, ..Scene::default() };
        scene
            .apply(&[Op::AddLayer {
                layer: serde_json::from_str(r#"{"id":"song","type":"audio","src":"/media/s.mp3","in":4,"start":1,"end":9,"volume":0.8}"#).unwrap(),
            }])
            .unwrap();
        assert!(scene.layers[0].content.media_clip().is_some());
        assert!(scene.video_sources().is_empty(), "sound files are not opened as video");
        assert!(scene.video_frames(2.0).is_empty());
        let c = &scene.video_clips(2.0)[0];
        assert_eq!((c.id.as_str(), c.time, c.volume), ("song", 5.0, 0.8));
        // A ripple cut through it is a jump cut, like on a video clip.
        scene.apply(&[Op::RippleDelete { from: 3.0, to: 5.0 }]).unwrap();
        let ids: Vec<&str> = scene.layers.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, ["song", "song_2"]);
        let after = scene.video_clips(3.5);
        assert_eq!(after.len(), 1);
        assert!((after[0].time - 8.5).abs() < 1e-3, "{}", after[0].time);
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
