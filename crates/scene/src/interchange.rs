//! The Edit timeline for other editors: FCPXML 1.9 (Final Cut Pro, DaVinci Resolve, Premiere), OpenTimelineIO
//! and a CMX3600 EDL. Clips keep their track, timeline position and file in/out; graphics are not exported
//! (they only exist in Motionily), nor are speed changes (each clip is cut at its file in/out at 1×).

use serde_json::{json, Value};

use crate::layer::LayerContent;
use crate::video::media_duration;
use crate::Scene;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineFormat {
    Fcpxml,
    Otio,
    Edl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Video,
    Audio,
}

#[derive(Debug, Clone)]
struct Item {
    name: String,
    src: String,
    kind: Kind,
    /// Timeline seconds.
    at: f32,
    end: f32,
    /// File second it starts at.
    from: f32,
}

#[derive(Debug, Clone)]
struct Lane {
    id: String,
    kind: Kind,
    items: Vec<Item>,
}

/// Where the voice-over comes from (it lives outside the scene): its file, read with `scene.audio`'s trim and cuts.
pub struct Voice<'a> {
    pub src: &'a str,
}

fn file_name(src: &str) -> String {
    src.rsplit('/').next().unwrap_or(src).to_string()
}

impl Scene {
    /// Clips by track, like the Edit timeline: explicit `track`s, the rest on the first free V/A track.
    fn interchange_lanes(&self, voice: Option<&Voice>) -> Vec<Lane> {
        let mut items: Vec<(Option<String>, Item)> = Vec::new();
        for l in &self.layers {
            let (kind, src, from) = match &l.content {
                LayerContent::Video { clip } => (Kind::Video, clip.src.clone(), clip.trim_in),
                LayerContent::Audio { clip } => (Kind::Audio, clip.src.clone(), clip.trim_in),
                LayerContent::Image { src, .. } if l.group.as_deref() == Some("footage") => (Kind::Video, src.clone(), 0.0),
                _ => continue,
            };
            let end = l.end.unwrap_or(self.duration).min(self.duration);
            if end <= l.start {
                continue;
            }
            items.push((l.track.clone(), Item { name: l.id.clone(), src, kind, at: l.start, end, from }));
        }
        if let Some(m) = &self.music {
            let len = media_duration(&m.src).unwrap_or(f32::INFINITY);
            let end = (m.start + m.trim_out.unwrap_or(len).min(len) - m.trim_in).min(self.duration);
            if end > m.start {
                items.push((None, Item { name: "music".into(), src: m.src.clone(), kind: Kind::Audio, at: m.start, end, from: m.trim_in }));
            }
        }
        if let (Some(v), Some(track)) = (voice, self.audio.as_ref().cloned().or(Some(Default::default()))) {
            let len = media_duration(v.src).unwrap_or(self.duration);
            for (i, (at, from, to)) in track.pieces(len).into_iter().enumerate() {
                let end = (at + to - from).min(self.duration);
                if end > at {
                    items.push((None, Item { name: format!("voice {}", i + 1), src: v.src.to_string(), kind: Kind::Audio, at, end, from }));
                }
            }
        }
        items.sort_by(|a, b| a.1.at.total_cmp(&b.1.at));
        let mut lanes: Vec<Lane> = Vec::new();
        for (track, item) in items {
            let free = |lane: &Lane| lane.items.iter().all(|o| o.end <= item.at + 1e-3 || o.at >= item.end - 1e-3);
            let idx = match track {
                Some(id) => lanes.iter().position(|l| l.id == id).unwrap_or_else(|| {
                    lanes.push(Lane { id, kind: item.kind, items: Vec::new() });
                    lanes.len() - 1
                }),
                None => {
                    let prefix = if item.kind == Kind::Video { "V" } else { "A" };
                    let mut n = 1;
                    loop {
                        let id = format!("{prefix}{n}");
                        match lanes.iter().position(|l| l.id == id) {
                            Some(i) if free(&lanes[i]) => break i,
                            Some(_) => n += 1,
                            None => {
                                lanes.push(Lane { id, kind: item.kind, items: Vec::new() });
                                break lanes.len() - 1;
                            }
                        }
                    }
                }
            };
            lanes[idx].items.push(item);
        }
        let order = |l: &Lane| (l.kind == Kind::Audio, l.id[1..].parse::<u32>().unwrap_or(99), l.id.clone());
        lanes.sort_by_key(order);
        for l in &mut lanes {
            l.items.sort_by(|a, b| a.at.total_cmp(&b.at));
        }
        lanes
    }

    /// The timeline as `format`. `media_root` replaces `/media/` in sources (a `file:///…/media/` folder
    /// in the desktop app, the API's URL in a browser) so the other editor can find the files.
    pub fn timeline_file(&self, format: TimelineFormat, name: &str, media_root: &str, voice: Option<&Voice>) -> String {
        let lanes = self.interchange_lanes(voice);
        let url = |src: &str| match src.strip_prefix("/media/") {
            Some(f) => format!("{media_root}{f}"),
            None => src.to_string(),
        };
        let rate = Rate::of(self.fps);
        match format {
            TimelineFormat::Fcpxml => fcpxml(self, &lanes, name, &url, rate),
            TimelineFormat::Otio => otio(&lanes, name, &url, rate),
            TimelineFormat::Edl => edl(&lanes, name, rate),
        }
    }
}

/// A frame rate as the frame duration `num/den` s (29.97 = 1001/30000).
#[derive(Debug, Clone, Copy)]
struct Rate {
    fps: f32,
    num: u64,
    den: u64,
}

impl Rate {
    fn of(fps: f32) -> Rate {
        let ntsc = [(23.976, 24_000), (29.97, 30_000), (59.94, 60_000)].into_iter().find(|(r, _)| (fps - r).abs() < 0.01);
        match ntsc {
            Some((_, den)) => Rate { fps, num: 1001, den },
            None => Rate { fps, num: 1, den: fps.round().max(1.0) as u64 },
        }
    }
    fn frames(self, t: f32) -> u64 {
        (t.max(0.0) as f64 * self.den as f64 / self.num as f64).round() as u64
    }
    /// FCPXML rational time.
    fn time(self, t: f32) -> String {
        let f = self.frames(t);
        if f == 0 { "0s".into() } else { format!("{}/{}s", f * self.num, self.den) }
    }
    /// Non-drop timecode at the rounded rate.
    fn timecode(self, t: f32) -> String {
        let base = self.fps.round().max(1.0) as u64;
        let f = self.frames(t);
        format!("{:02}:{:02}:{:02}:{:02}", f / base / 3600, f / base / 60 % 60, f / base % 60, f % base)
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn fcpxml(scene: &Scene, lanes: &[Lane], name: &str, url: &dyn Fn(&str) -> String, rate: Rate) -> String {
    let mut assets: Vec<(String, Kind, f32)> = Vec::new();
    for item in lanes.iter().flat_map(|l| &l.items) {
        let reach = item.from + item.end - item.at;
        match assets.iter_mut().find(|a| a.0 == item.src) {
            Some(a) => a.2 = a.2.max(reach),
            None => assets.push((item.src.clone(), item.kind, media_duration(&item.src).unwrap_or(0.0).max(reach))),
        }
    }
    let asset_id = |src: &str| format!("r{}", assets.iter().position(|a| a.0 == src).unwrap_or(0) + 2);
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE fcpxml>\n<fcpxml version=\"1.9\">\n  <resources>\n");
    x += &format!(
        "    <format id=\"r1\" name=\"Motionily {}x{}\" frameDuration=\"{}/{}s\" width=\"{}\" height=\"{}\"/>\n",
        scene.width, scene.height, rate.num, rate.den, scene.width, scene.height
    );
    for (src, kind, len) in &assets {
        let video = if *kind == Kind::Video { "1" } else { "0" };
        x += &format!(
            "    <asset id=\"{}\" name=\"{}\" src=\"{}\" start=\"0s\" duration=\"{}\" hasVideo=\"{video}\" hasAudio=\"1\" format=\"r1\" audioSources=\"1\" audioChannels=\"2\"/>\n",
            asset_id(src),
            esc(&file_name(src)),
            esc(&url(src)),
            rate.time(*len)
        );
    }
    x += "  </resources>\n  <library>\n    <event name=\"Motionily\">\n";
    x += &format!("      <project name=\"{}\">\n", esc(name));
    x += &format!("        <sequence format=\"r1\" duration=\"{}\" tcStart=\"0s\" tcFormat=\"NDF\" audioLayout=\"stereo\" audioRate=\"48k\">\n          <spine>\n", rate.time(scene.duration));
    // The primary storyline is V1 with gaps between its clips; every other track hangs off it as a lane.
    let primary: Vec<&Item> = lanes.iter().find(|l| l.id == "V1").map(|l| l.items.iter().collect()).unwrap_or_default();
    let mut spine: Vec<(Option<&Item>, f32, f32)> = Vec::new();
    let mut t = 0.0;
    for item in &primary {
        if item.at > t + 1e-3 {
            spine.push((None, t, item.at));
        }
        spine.push((Some(item), item.at, item.end));
        t = item.end;
    }
    if t < scene.duration - 1e-3 || spine.is_empty() {
        spine.push((None, t, scene.duration.max(t + 1.0 / rate.fps)));
    }
    let lane_no = |l: &Lane| -> i32 {
        let n: i32 = l.id[1..].parse().unwrap_or(1);
        if l.kind == Kind::Video { n - 1 } else { -n }
    };
    for (i, (item, a, b)) in spine.iter().enumerate() {
        let parent_start = item.map(|it| it.from).unwrap_or(0.0);
        let mut children = String::new();
        for lane in lanes.iter().filter(|l| l.id != "V1") {
            for c in &lane.items {
                let inside = c.at >= *a - 1e-3 && (c.at < *b - 1e-3 || i == spine.len() - 1);
                if !inside {
                    continue;
                }
                children += &format!(
                    "              <asset-clip ref=\"{}\" lane=\"{}\" offset=\"{}\" start=\"{}\" duration=\"{}\" name=\"{}\"/>\n",
                    asset_id(&c.src),
                    lane_no(lane),
                    rate.time(parent_start + c.at - a),
                    rate.time(c.from),
                    rate.time(c.end - c.at),
                    esc(&c.name)
                );
            }
        }
        let open = match item {
            Some(it) => format!("            <asset-clip ref=\"{}\" offset=\"{}\" start=\"{}\" duration=\"{}\" name=\"{}\"", asset_id(&it.src), rate.time(*a), rate.time(it.from), rate.time(b - a), esc(&it.name)),
            None => format!("            <gap name=\"Gap\" offset=\"{}\" start=\"0s\" duration=\"{}\"", rate.time(*a), rate.time(b - a)),
        };
        let tag = if item.is_some() { "asset-clip" } else { "gap" };
        x += &if children.is_empty() { format!("{open}/>\n") } else { format!("{open}>\n{children}            </{tag}>\n") };
    }
    x += "          </spine>\n        </sequence>\n      </project>\n    </event>\n  </library>\n</fcpxml>\n";
    x
}

fn otio(lanes: &[Lane], name: &str, url: &dyn Fn(&str) -> String, rate: Rate) -> String {
    let fps = rate.den as f64 / rate.num as f64;
    let rt = |t: f32| json!({"OTIO_SCHEMA": "RationalTime.1", "rate": fps, "value": rate.frames(t) as f64});
    let range = |from: f32, dur: f32| json!({"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(from), "duration": rt(dur)});
    let tracks: Vec<Value> = lanes
        .iter()
        .map(|lane| {
            let mut children = Vec::new();
            let mut t = 0.0;
            for c in &lane.items {
                if c.at > t + 1e-3 {
                    children.push(json!({"OTIO_SCHEMA": "Gap.1", "name": "", "source_range": range(0.0, c.at - t), "effects": [], "markers": [], "metadata": {}}));
                }
                children.push(json!({
                    "OTIO_SCHEMA": "Clip.1",
                    "name": c.name,
                    "source_range": range(c.from, c.end - c.at),
                    "media_reference": {"OTIO_SCHEMA": "ExternalReference.1", "name": file_name(&c.src), "target_url": url(&c.src), "available_range": null, "metadata": {}},
                    "effects": [], "markers": [], "metadata": {}
                }));
                t = c.end.max(t);
            }
            let kind = if lane.kind == Kind::Video { "Video" } else { "Audio" };
            json!({"OTIO_SCHEMA": "Track.1", "name": lane.id, "kind": kind, "children": children, "source_range": null, "effects": [], "markers": [], "metadata": {}})
        })
        .collect();
    let timeline = json!({
        "OTIO_SCHEMA": "Timeline.1",
        "name": name,
        "global_start_time": null,
        "tracks": {"OTIO_SCHEMA": "Stack.1", "name": "tracks", "children": tracks, "source_range": null, "effects": [], "markers": [], "metadata": {}},
        "metadata": {"motionily": {}}
    });
    serde_json::to_string_pretty(&timeline).unwrap_or_default()
}

fn edl(lanes: &[Lane], name: &str, rate: Rate) -> String {
    let mut out = format!("TITLE: {name}\nFCM: NON-DROP FRAME\n\n");
    let mut n = 0;
    // CMX3600 carries one picture track and up to two sound tracks.
    for lane in lanes.iter().filter(|l| ["V1", "A1", "A2"].contains(&l.id.as_str())) {
        let channel = match lane.id.as_str() {
            "V1" => "V",
            "A1" => "A",
            _ => "A2",
        };
        for c in &lane.items {
            n += 1;
            out += &format!(
                "{n:03}  AX       {channel:<5} C        {} {} {} {}\n* FROM CLIP NAME: {}\n\n",
                rate.timecode(c.from),
                rate.timecode(c.from + c.end - c.at),
                rate.timecode(c.at),
                rate.timecode(c.end),
                file_name(&c.src)
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene() -> Scene {
        let json = r#"{"width":1080,"height":1920,"fps":30,"duration":10,"layers":[
            {"id":"a","type":"video","src":"/media/a.mp4","in":2,"start":0,"end":4},
            {"id":"b","type":"video","src":"/media/b.mp4","start":4,"end":10},
            {"id":"broll","type":"video","src":"/media/c.mp4","in":1,"start":5,"end":7},
            {"id":"sound","type":"audio","src":"/media/s.mp3","start":1,"end":3}
        ],"music":{"src":"/media/m.mp3","start":0,"trim_in":5}}"#;
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn lanes_follow_the_edit_timeline() {
        let lanes = scene().interchange_lanes(None);
        let ids: Vec<_> = lanes.iter().map(|l| (l.id.as_str(), l.items.len())).collect();
        assert_eq!(ids, vec![("V1", 2), ("V2", 1), ("A1", 1), ("A2", 1)]);
    }

    #[test]
    fn fcpxml_hangs_tracks_off_the_primary_storyline() {
        let x = scene().timeline_file(TimelineFormat::Fcpxml, "Demo & co", "file:///m/", None);
        assert!(x.contains("<project name=\"Demo &amp; co\">"));
        assert!(x.contains("<asset-clip ref=\"r2\" offset=\"0s\" start=\"60/30s\" duration=\"120/30s\" name=\"a\""), "{x}");
        // b-roll at 5 s sits 1 s into clip b (which starts at file 0), on lane 1.
        assert!(x.contains("<asset-clip ref=\"r4\" lane=\"1\" offset=\"30/30s\" start=\"30/30s\" duration=\"60/30s\" name=\"broll\"/>"), "{x}");
        assert!(x.contains("src=\"file:///m/a.mp4\""));
    }

    #[test]
    fn otio_and_edl() {
        if let Ok(dir) = std::env::var("INTERCHANGE_OUT") {
            for (f, ext) in [(TimelineFormat::Fcpxml, "fcpxml"), (TimelineFormat::Otio, "otio"), (TimelineFormat::Edl, "edl")] {
                std::fs::write(format!("{dir}/demo.{ext}"), scene().timeline_file(f, "Demo", "file:///m/", None)).unwrap();
            }
        }
        let o: Value = serde_json::from_str(&scene().timeline_file(TimelineFormat::Otio, "Demo", "file:///m/", None)).unwrap();
        let v2 = &o["tracks"]["children"][1];
        assert_eq!(v2["name"], "V2");
        assert_eq!(v2["children"][0]["OTIO_SCHEMA"], "Gap.1");
        assert_eq!(v2["children"][0]["source_range"]["duration"]["value"], 150.0);
        assert_eq!(v2["children"][1]["media_reference"]["target_url"], "file:///m/c.mp4");
        let e = scene().timeline_file(TimelineFormat::Edl, "Demo", "", None);
        assert!(e.contains("001  AX       V     C        00:00:02:00 00:00:06:00 00:00:00:00 00:00:04:00\n* FROM CLIP NAME: a.mp4"), "{e}");
        assert!(e.contains("A     C"));
    }

    #[test]
    fn ntsc_rates_are_rational() {
        let r = Rate::of(29.97);
        assert_eq!(r.time(1.001), "30030/30000s");
        assert_eq!(Rate::of(24.0).time(0.5), "12/24s");
    }
}
