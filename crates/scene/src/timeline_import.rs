//! Timelines from other editors: FCPXML (Final Cut Pro, DaVinci Resolve), Final Cut Pro 7 XML (`xmeml`: what
//! Premiere and Resolve call "XML") and OpenTimelineIO. Clips come out with their track, timeline position and
//! file in; the caller finds each file among the project's media (by name, or its path on this machine) and
//! places them. Titles, generators, nested sequences and speed changes stay behind and are listed.

use std::collections::HashMap;

use quick_xml::events::Event;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportedClip {
    pub name: String,
    /// File name (decoded), to find it among the project's media.
    pub file: String,
    /// Where the other editor had it (`file:///…`, a URL or a path).
    pub url: String,
    pub kind: ClipKind,
    /// "V1", "V2", …, "A1", …: tracks that never overlap.
    pub track: String,
    /// Timeline seconds.
    pub start: f32,
    pub end: f32,
    /// File second the clip starts at.
    pub trim_in: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportedTimeline {
    /// "fcpxml", "xmeml" or "otio".
    pub format: &'static str,
    pub name: String,
    pub fps: Option<f32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Seconds: the sequence's, or up to the last clip.
    pub duration: f32,
    pub clips: Vec<ImportedClip>,
    /// What was not brought over ("title Lower third", "speed change on interview (imported at 1×)").
    pub skipped: Vec<String>,
}

/// Read a timeline file: XML (FCPXML or Final Cut Pro 7 XML) or OpenTimelineIO JSON.
pub fn import_timeline(text: &str) -> Result<ImportedTimeline, String> {
    let text = text.trim_start_matches('\u{feff}').trim_start();
    let mut out = if text.starts_with('<') {
        let root = parse_xml(text)?;
        if let Some(f) = root.find("fcpxml") {
            fcpxml(f)?
        } else if let Some(x) = root.find("xmeml") {
            xmeml(x)?
        } else {
            return Err("this XML is neither FCPXML nor Final Cut Pro 7 XML".into());
        }
    } else if text.starts_with('{') {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("not OpenTimelineIO JSON: {e}"))?;
        otio(&v)?
    } else {
        return Err("not a timeline: expected FCPXML, Final Cut Pro 7 XML or OpenTimelineIO (.otio)".into());
    };
    tidy(&mut out);
    if out.clips.is_empty() {
        return Err(format!("no clips with media files in this timeline{}", if out.skipped.is_empty() { String::new() } else { format!(" (skipped: {})", out.skipped.join(", ")) }));
    }
    Ok(out)
}

/// Drop empty clips and the separate sound of a clip (a video layer plays its own; stereo pairs come as two),
/// move clips that overlap on a track to the next free one, and sort.
fn tidy(t: &mut ImportedTimeline) {
    t.clips.retain(|c| c.end > c.start + 1e-4 && !c.file.is_empty());
    let same = |a: &ImportedClip, b: &ImportedClip| a.file == b.file && (a.start - b.start).abs() < 2e-3 && (a.end - b.end).abs() < 2e-3 && (a.trim_in - b.trim_in).abs() < 2e-3;
    let mut kept: Vec<ImportedClip> = Vec::new();
    let mut clips = std::mem::take(&mut t.clips);
    clips.sort_by_key(|c| c.kind == ClipKind::Audio);
    for c in clips {
        if c.kind == ClipKind::Audio && kept.iter().any(|k| same(k, &c)) {
            continue;
        }
        kept.push(c);
    }
    let number = |c: &ImportedClip| c.track[1..].parse::<u32>().unwrap_or(1).max(1);
    kept.sort_by(|a, b| (a.kind == ClipKind::Audio, number(a)).cmp(&(b.kind == ClipKind::Audio, number(b))).then(a.start.total_cmp(&b.start)));
    let mut busy: HashMap<(ClipKind, u32), Vec<(f32, f32)>> = HashMap::new();
    for c in &mut kept {
        let mut n = number(c);
        while busy.get(&(c.kind, n)).is_some_and(|spans| spans.iter().any(|(a, b)| c.start < b - 1e-3 && c.end > a + 1e-3)) {
            n += 1;
        }
        busy.entry((c.kind, n)).or_default().push((c.start, c.end));
        c.track = format!("{}{n}", if c.kind == ClipKind::Video { "V" } else { "A" });
    }
    kept.sort_by(|a, b| (a.kind == ClipKind::Audio, number(a)).cmp(&(b.kind == ClipKind::Audio, number(b))).then(a.start.total_cmp(&b.start)));
    t.duration = kept.iter().map(|c| c.end).fold(t.duration, f32::max);
    t.clips = kept;
}

/// The file name in a URL or path, percent-decoded.
fn file_of(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn track_id(kind: ClipKind, n: i64) -> String {
    format!("{}{}", if kind == ClipKind::Video { "V" } else { "A" }, n.max(1))
}

// ---------------------------------------------------------------------------------------------------------------
// A small XML tree.

#[derive(Debug, Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Node>,
    text: String,
}

impl Node {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
    fn kids<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }
    fn child<'a>(&'a self, name: &'a str) -> Option<&'a Node> {
        self.kids(name).next()
    }
    /// Text of a child element, trimmed.
    fn text_of<'a>(&'a self, name: &'a str) -> Option<&'a str> {
        self.child(name).map(|c| c.text.trim())
    }
    /// This node or the first descendant called `name`, depth first.
    fn find(&self, name: &str) -> Option<&Node> {
        if self.name == name {
            return Some(self);
        }
        self.children.iter().find_map(|c| c.find(name))
    }
    fn each<'a>(&'a self, f: &mut dyn FnMut(&'a Node)) {
        f(self);
        for c in &self.children {
            c.each(f);
        }
    }
}

fn parse_xml(text: &str) -> Result<Node, String> {
    let mut reader = quick_xml::Reader::from_str(text);
    let mut stack = vec![Node { name: "#document".into(), ..Default::default() }];
    let open = |e: &quick_xml::events::BytesStart| -> Result<Node, String> {
        let mut node = Node { name: e.name().as_ref().to_string(), ..Default::default() };
        for a in e.attributes() {
            let a = a.map_err(|e| format!("XML: {e}"))?;
            let value = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| format!("XML: {e}"))?;
            node.attrs.push((a.key.as_ref().to_string(), value.into_owned()));
        }
        Ok(node)
    };
    loop {
        match reader.read_event().map_err(|e| format!("XML at byte {}: {e}", reader.buffer_position()))? {
            Event::Start(e) => stack.push(open(&e)?),
            Event::Empty(e) => {
                let node = open(&e)?;
                stack.last_mut().unwrap().children.push(node);
            }
            Event::End(_) => {
                let node = stack.pop().unwrap();
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => return Err("XML: unbalanced tags".into()),
                }
            }
            Event::Text(t) => stack.last_mut().unwrap().text += &t.xml10_content(),
            Event::CData(t) => stack.last_mut().unwrap().text += &t.xml10_content(),
            Event::GeneralRef(r) => {
                let s = match r.resolve_char_ref() {
                    Ok(Some(c)) => c.to_string(),
                    _ => match r.xml10_content().as_ref() {
                        "amp" => "&".into(),
                        "lt" => "<".into(),
                        "gt" => ">".into(),
                        "quot" => "\"".into(),
                        "apos" => "'".into(),
                        _ => String::new(),
                    },
                };
                stack.last_mut().unwrap().text += &s;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err("XML: the file ends before its tags close".into());
    }
    Ok(stack.pop().unwrap())
}

// ---------------------------------------------------------------------------------------------------------------
// FCPXML.

/// FCPXML rational time: "1001/30000s", "5s", "0s".
fn rational(s: &str) -> Option<f64> {
    let s = s.trim().trim_end_matches('s');
    match s.split_once('/') {
        Some((n, d)) => {
            let (n, d) = (n.parse::<f64>().ok()?, d.parse::<f64>().ok()?);
            (d != 0.0).then(|| n / d)
        }
        None => s.parse().ok(),
    }
}

struct Asset {
    name: String,
    src: String,
    start: f64,
    video: bool,
}

struct Fcp<'a> {
    assets: HashMap<&'a str, Asset>,
    clips: Vec<ImportedClip>,
    skipped: Vec<String>,
}

impl<'a> Fcp<'a> {
    fn time(n: &Node, key: &str) -> Option<f64> {
        n.attr(key).and_then(rational)
    }

    /// The children of a container whose own time τ is at timeline second `origin + τ`. Lane-less media in a
    /// `clip` are cut to `window` (the clip's visible part); `lane` is the storyline the container sits on.
    fn walk(&mut self, node: &'a Node, origin: f64, lane: i64, window: Option<(f64, f64)>) {
        for c in &node.children {
            let offset = Self::time(c, "offset").unwrap_or(0.0);
            let at = origin + offset;
            let dur = Self::time(c, "duration").unwrap_or(0.0);
            let own_lane = c.attr("lane").and_then(|l| l.parse::<i64>().ok());
            let c_lane = own_lane.unwrap_or(lane);
            let label = c.attr("name").unwrap_or(&c.name).to_string();
            let speed = c.child("timeMap").is_some();
            match c.name.as_str() {
                "asset-clip" | "video" | "audio" => {
                    let Some(asset) = c.attr("ref").and_then(|r| self.assets.get(r)) else {
                        if c.name != "audio" {
                            self.skipped.push(format!("generator {label}"));
                        }
                        continue;
                    };
                    let start = Self::time(c, "start").unwrap_or(asset.start);
                    let kind = match c.name.as_str() {
                        "video" => ClipKind::Video,
                        "audio" => ClipKind::Audio,
                        _ if c.attr("srcEnable") == Some("audio") || !asset.video => ClipKind::Audio,
                        _ => ClipKind::Video,
                    };
                    let (mut a, mut b, mut trim) = (at, at + dur, start - asset.start);
                    if let (Some((lo, hi)), None) = (window, own_lane) {
                        if a < lo {
                            trim += lo - a;
                            a = lo;
                        }
                        b = b.min(hi);
                    }
                    let track = match kind {
                        ClipKind::Video => track_id(kind, c_lane.max(0) + 1),
                        ClipKind::Audio => track_id(kind, if c_lane < 0 { -c_lane } else { 1 }),
                    };
                    if speed {
                        self.skipped.push(format!("speed change on {label} (imported at 1×)"));
                    }
                    let name = if c.name == "asset-clip" { label } else { asset.name.clone() };
                    self.clips.push(ImportedClip { name, file: file_of(&asset.src), url: asset.src.clone(), kind, track, start: a as f32, end: b as f32, trim_in: trim.max(0.0) as f32 });
                    // Connected clips of an asset-clip, in its own time.
                    self.walk(c, at - start, c_lane, None);
                }
                "clip" | "sync-clip" => {
                    let start = Self::time(c, "start").unwrap_or(0.0);
                    if speed {
                        self.skipped.push(format!("speed change on {label} (imported at 1×)"));
                    }
                    self.walk(c, at - start, c_lane, Some((at, at + dur)));
                }
                "gap" => {
                    let start = Self::time(c, "start").unwrap_or(0.0);
                    self.walk(c, at - start, c_lane, None);
                }
                // A secondary storyline: its clips follow one another in its own time.
                "spine" => self.walk(c, at, c_lane, None),
                "title" => self.skipped.push(format!("title {label}")),
                "ref-clip" => self.skipped.push(format!("compound clip {label}")),
                "mc-clip" => self.skipped.push(format!("multicam clip {label}")),
                _ => {}
            }
        }
    }
}

fn fcpxml(root: &Node) -> Result<ImportedTimeline, String> {
    let resources = root.child("resources");
    let mut formats: HashMap<&str, &Node> = HashMap::new();
    let mut assets: HashMap<&str, Asset> = HashMap::new();
    for r in resources.iter().flat_map(|r| r.children.iter()) {
        let Some(id) = r.attr("id") else { continue };
        match r.name.as_str() {
            "format" => {
                formats.insert(id, r);
            }
            "asset" => {
                // FCPXML 1.10+: the file is a media-rep inside.
                let rep = r.kids("media-rep").find(|m| m.attr("kind") == Some("original-media")).or_else(|| r.child("media-rep"));
                let src = r.attr("src").or_else(|| rep.and_then(|m| m.attr("src"))).unwrap_or_default().to_string();
                assets.insert(id, Asset { name: r.attr("name").unwrap_or_default().to_string(), src, start: Fcp::time(r, "start").unwrap_or(0.0), video: r.attr("hasVideo") == Some("1") });
            }
            _ => {}
        }
    }
    let sequence = root.find("sequence").ok_or("no sequence in this FCPXML")?;
    let spine = sequence.child("spine").ok_or("the sequence has no spine")?;
    let format = sequence.attr("format").and_then(|f| formats.get(f));
    let fps = format.and_then(|f| f.attr("frameDuration")).and_then(rational).filter(|d| *d > 0.0).map(|d| (1.0 / d) as f32);
    let size = |k: &str| format.and_then(|f| f.attr(k)).and_then(|v| v.parse::<u32>().ok());
    let name = root.find("project").and_then(|p| p.attr("name")).or_else(|| root.find("event").and_then(|e| e.attr("name"))).unwrap_or("Timeline").to_string();
    // Sequences often start at a timecode (01:00:00:00): the spine's offsets count from it.
    let tc_start = Fcp::time(sequence, "tcStart").unwrap_or(0.0);
    let mut fcp = Fcp { assets, clips: Vec::new(), skipped: Vec::new() };
    fcp.walk(spine, -tc_start, 0, None);
    Ok(ImportedTimeline {
        format: "fcpxml",
        name,
        fps,
        width: size("width"),
        height: size("height"),
        duration: Fcp::time(sequence, "duration").unwrap_or(0.0) as f32,
        clips: fcp.clips,
        skipped: fcp.skipped,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Final Cut Pro 7 XML (xmeml): Premiere's and Resolve's "XML".

fn xmeml(root: &Node) -> Result<ImportedTimeline, String> {
    let seq = root.find("sequence").ok_or("no sequence in this XML")?;
    let rate_of = |n: &Node| -> Option<f64> {
        let r = n.child("rate")?;
        let base: f64 = r.text_of("timebase")?.parse().ok()?;
        Some(if r.text_of("ntsc").is_some_and(|v| v.eq_ignore_ascii_case("true")) { base * 1000.0 / 1001.0 } else { base })
    };
    let fps = rate_of(seq).unwrap_or(30.0);
    // A file is written out once and referred to by its id after that.
    let mut files: HashMap<&str, (&str, &str)> = HashMap::new();
    root.each(&mut |n| {
        if n.name == "file" {
            if let (Some(id), Some(url)) = (n.attr("id"), n.text_of("pathurl")) {
                files.entry(id).or_insert((url, n.text_of("name").unwrap_or_default()));
            }
        }
    });
    let media = seq.child("media").ok_or("the sequence has no media")?;
    let mut clips = Vec::new();
    let mut skipped = Vec::new();
    for (kind, part) in [(ClipKind::Video, "video"), (ClipKind::Audio, "audio")] {
        let Some(m) = media.child(part) else { continue };
        for (i, track) in m.kids("track").enumerate() {
            if track.text_of("enabled").is_some_and(|v| v.eq_ignore_ascii_case("false")) {
                continue;
            }
            let mut last_end = 0.0f64;
            for item in track.children.iter().filter(|c| c.name == "clipitem" || c.name == "transitionitem") {
                let num = |k: &str| item.text_of(k).and_then(|v| v.parse::<f64>().ok());
                let label = item.text_of("name").unwrap_or("clip").to_string();
                if item.name == "transitionitem" {
                    if let Some(e) = num("end") {
                        last_end = last_end.max(e);
                    }
                    continue;
                }
                if item.text_of("enabled").is_some_and(|v| v.eq_ignore_ascii_case("false")) {
                    continue;
                }
                let rate = rate_of(item).unwrap_or(fps);
                let (inp, out) = (num("in").unwrap_or(0.0), num("out").unwrap_or(0.0));
                // -1: the edge sits under a transition; the neighbour's edge stands in.
                let start = num("start").filter(|s| *s >= 0.0).unwrap_or(last_end);
                let end = num("end").filter(|e| *e >= 0.0).unwrap_or(start + out - inp);
                last_end = end;
                if item.child("sequence").is_some() {
                    skipped.push(format!("nested sequence {label}"));
                    continue;
                }
                let file = item.child("file").and_then(|f| f.attr("id")).and_then(|id| files.get(id));
                let Some((url, file_name)) = file else {
                    if kind == ClipKind::Video {
                        skipped.push(format!("generator {label}"));
                    }
                    continue;
                };
                let remap = item.kids("filter").any(|f| f.child("effect").and_then(|e| e.text_of("effectid")) == Some("timeremap"));
                if remap {
                    skipped.push(format!("speed change on {label} (imported at 1×)"));
                }
                let file = if file_name.is_empty() { file_of(url) } else { file_name.to_string() };
                clips.push(ImportedClip { name: label, file, url: url.to_string(), kind, track: track_id(kind, i as i64 + 1), start: (start / fps) as f32, end: (end / fps) as f32, trim_in: (inp / rate) as f32 });
            }
        }
    }
    let size = |k: &str| media.child("video").and_then(|v| v.child("format")).and_then(|f| f.child("samplecharacteristics")).and_then(|s| s.text_of(k)).and_then(|v| v.parse::<u32>().ok());
    Ok(ImportedTimeline {
        format: "xmeml",
        name: seq.text_of("name").unwrap_or("Timeline").to_string(),
        fps: Some(fps as f32),
        width: size("width"),
        height: size("height"),
        duration: seq.text_of("duration").and_then(|d| d.parse::<f64>().ok()).map_or(0.0, |d| (d / fps) as f32),
        clips,
        skipped,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// OpenTimelineIO.

fn schema(v: &Value) -> &str {
    v["OTIO_SCHEMA"].as_str().unwrap_or("").split('.').next().unwrap_or("")
}

/// RationalTime → seconds.
fn seconds(t: &Value) -> Option<f64> {
    let (value, rate) = (t["value"].as_f64()?, t["rate"].as_f64()?);
    (rate > 0.0).then(|| value / rate)
}

/// A composition's length: its source range, else the sum of what it holds.
fn otio_duration(v: &Value) -> f64 {
    if let Some(d) = seconds(&v["source_range"]["duration"]) {
        return d;
    }
    match schema(v) {
        "Track" => v["children"].as_array().into_iter().flatten().filter(|c| schema(c) != "Transition").map(otio_duration).sum(),
        "Stack" => v["children"].as_array().into_iter().flatten().map(otio_duration).fold(0.0, f64::max),
        _ => seconds(&v["media_reference"]["available_range"]["duration"]).unwrap_or(0.0),
    }
}

fn otio(root: &Value) -> Result<ImportedTimeline, String> {
    // A collection of timelines: the first one.
    let timeline = match schema(root) {
        "Timeline" | "Stack" | "Track" => root,
        "SerializableCollection" => root["children"].as_array().and_then(|c| c.iter().find(|t| schema(t) == "Timeline")).ok_or("no timeline in this collection")?,
        other => return Err(format!("not an OpenTimelineIO timeline ({other})")),
    };
    let tracks: Vec<&Value> = match schema(timeline) {
        "Timeline" => timeline["tracks"]["children"].as_array().map(|a| a.iter().collect()).unwrap_or_default(),
        "Stack" => timeline["children"].as_array().map(|a| a.iter().collect()).unwrap_or_default(),
        _ => vec![timeline],
    };
    let mut fps = timeline["global_start_time"]["rate"].as_f64();
    let (mut clips, mut skipped) = (Vec::new(), Vec::new());
    let (mut videos, mut audios) = (0, 0);
    for track in tracks.into_iter().filter(|t| schema(t) == "Track") {
        let kind = if track["kind"].as_str() == Some("Audio") { ClipKind::Audio } else { ClipKind::Video };
        let n = if kind == ClipKind::Video {
            videos += 1;
            videos
        } else {
            audios += 1;
            audios
        };
        if track["enabled"].as_bool() == Some(false) {
            continue;
        }
        let mut t = 0.0;
        for item in track["children"].as_array().into_iter().flatten() {
            let label = item["name"].as_str().filter(|s| !s.is_empty()).unwrap_or("clip").to_string();
            match schema(item) {
                "Clip" => {
                    let reference = match item["active_media_reference_key"].as_str() {
                        Some(key) => &item["media_references"][key],
                        None => &item["media_reference"],
                    };
                    let range = if item["source_range"].is_object() { &item["source_range"] } else { &reference["available_range"] };
                    let dur = seconds(&range["duration"]).unwrap_or(0.0);
                    let from = seconds(&range["start_time"]).unwrap_or(0.0);
                    fps = fps.or(range["duration"]["rate"].as_f64());
                    let url = reference["target_url"].as_str().unwrap_or("");
                    if schema(reference) != "ExternalReference" || url.is_empty() {
                        skipped.push(if schema(reference) == "GeneratorReference" { format!("generator {label}") } else { format!("{label} (no media file)") });
                    } else {
                        // Media that starts at a timecode: the in is counted from the file's first frame.
                        let first = seconds(&reference["available_range"]["start_time"]).unwrap_or(0.0);
                        if item["effects"].as_array().into_iter().flatten().any(|e| schema(e).contains("TimeWarp") || schema(e) == "FreezeFrame") {
                            skipped.push(format!("speed change on {label} (imported at 1×)"));
                        }
                        clips.push(ImportedClip { name: label, file: file_of(url), url: url.to_string(), kind, track: track_id(kind, n), start: t as f32, end: (t + dur) as f32, trim_in: (from - first).max(0.0) as f32 });
                    }
                    t += dur;
                }
                "Gap" => t += otio_duration(item),
                "Transition" => {}
                "Stack" | "Track" => {
                    skipped.push(format!("nested sequence {label}"));
                    t += otio_duration(item);
                }
                _ => t += otio_duration(item),
            }
        }
    }
    let duration = seconds(&timeline["source_range"]["duration"]).unwrap_or(0.0);
    Ok(ImportedTimeline { format: "otio", name: timeline["name"].as_str().unwrap_or("Timeline").to_string(), fps: fps.map(|f| f as f32), width: None, height: None, duration: duration as f32, clips, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interchange::TimelineFormat;
    use crate::Scene;

    fn scene() -> Scene {
        let json = r#"{"width":1080,"height":1920,"fps":30,"duration":10,"layers":[
            {"id":"a","type":"video","src":"/media/a.mp4","in":2,"start":0,"end":4},
            {"id":"b","type":"video","src":"/media/b.mp4","start":4,"end":10},
            {"id":"broll","type":"video","src":"/media/c.mp4","in":1,"start":5,"end":7},
            {"id":"sound","type":"audio","src":"/media/s.mp3","start":1,"end":3}
        ],"music":{"src":"/media/m.mp3","start":0,"trim_in":5}}"#;
        serde_json::from_str(json).unwrap()
    }

    fn summary(t: &ImportedTimeline) -> Vec<(String, String, f32, f32, f32)> {
        let r = |x: f32| (x * 100.0).round() / 100.0;
        t.clips.iter().map(|c| (c.track.clone(), c.file.clone(), r(c.start), r(c.end), r(c.trim_in))).collect()
    }

    fn expected() -> Vec<(String, String, f32, f32, f32)> {
        [("V1", "a.mp4", 0.0, 4.0, 2.0), ("V1", "b.mp4", 4.0, 10.0, 0.0), ("V2", "c.mp4", 5.0, 7.0, 1.0), ("A1", "m.mp3", 0.0, 10.0, 5.0), ("A2", "s.mp3", 1.0, 3.0, 0.0)]
            .into_iter()
            .map(|(a, b, c, d, e)| (a.to_string(), b.to_string(), c, d, e))
            .collect()
    }

    #[test]
    fn fcpxml_round_trip() {
        let x = scene().timeline_file(TimelineFormat::Fcpxml, "Demo", "file:///m/", None);
        let t = import_timeline(&x).unwrap();
        assert_eq!((t.format, t.name.as_str(), t.fps, t.width, t.height), ("fcpxml", "Demo", Some(30.0), Some(1080), Some(1920)));
        // The music (no file length known here) runs to the end.
        assert_eq!(summary(&t), expected());
        assert_eq!(t.clips[0].url, "file:///m/a.mp4");
        assert_eq!(t.clips[0].name, "a");
        assert_eq!(t.clips[0].kind, ClipKind::Video);
    }

    #[test]
    fn otio_round_trip() {
        let o = scene().timeline_file(TimelineFormat::Otio, "Demo", "file:///m/", None);
        let t = import_timeline(&o).unwrap();
        assert_eq!((t.format, t.fps), ("otio", Some(30.0)));
        assert_eq!(summary(&t), expected());
    }

    /// The way Final Cut Pro and Resolve write it: a timecode start, camera files that start at a timecode,
    /// `clip`s wrapping their video, a gap carrying a connected clip, titles, speed changes, 1.10 media-reps.
    #[test]
    fn fcpxml_from_final_cut() {
        let x = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <resources>
    <format id="r1" frameDuration="1001/24000s" width="3840" height="2160"/>
    <asset id="r2" name="A001" start="3600s" duration="20s" hasVideo="1" hasAudio="1">
      <media-rep kind="original-media" src="file:///Volumes/Card/A001%20take.mov"/>
    </asset>
    <asset id="r3" name="vo" start="0s" duration="30s" hasAudio="1" src="file:///Users/me/vo.wav"/>
    <effect id="r4" name="Basic Title" uid=".../Titles.localized/Basic Title.moti"/>
  </resources>
  <library><event name="Day 1"><project name="Cut &amp; paste">
    <sequence format="r1" duration="12s" tcStart="3600s">
      <spine>
        <clip name="Interview" offset="3600s" start="3602s" duration="4s">
          <video ref="r2" offset="3600s" start="3600s" duration="20s"/>
          <audio ref="r3" lane="-1" offset="3603s" start="1s" duration="2s"/>
          <timeMap><timept time="0s" value="0s"/></timeMap>
        </clip>
        <gap name="Gap" offset="3604s" start="0s" duration="3s">
          <title ref="r4" lane="1" offset="1s" duration="1s" name="Lower third"/>
          <asset-clip ref="r2" lane="1" offset="0s" start="3610s" duration="2s" name="Cutaway"/>
        </gap>
        <asset-clip ref="r2" offset="3607s" start="3601s" duration="5s" name="Wide"/>
      </spine>
    </sequence>
  </project></event></library>
</fcpxml>"#;
        let t = import_timeline(x).unwrap();
        assert_eq!(t.name, "Cut & paste");
        assert!((t.fps.unwrap() - 23.976).abs() < 1e-3);
        assert_eq!(summary(&t), vec![
            ("V1".into(), "A001 take.mov".into(), 0.0, 4.0, 2.0),
            ("V1".into(), "A001 take.mov".into(), 7.0, 12.0, 1.0),
            ("V2".into(), "A001 take.mov".into(), 4.0, 6.0, 10.0),
            ("A1".into(), "vo.wav".into(), 1.0, 3.0, 1.0),
        ]);
        assert_eq!(t.clips[0].name, "A001");
        assert_eq!(t.skipped, vec!["speed change on Interview (imported at 1×)".to_string(), "title Lower third".into()]);
    }

    /// Premiere's XML: files written once then referred to by id, stereo pairs on A1 and A2, a clip's own
    /// sound next to it, a color matte.
    #[test]
    fn xmeml_from_premiere() {
        let x = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>Edit 1</name>
    <duration>250</duration>
    <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <format><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></format>
        <track>
          <clipitem id="clipitem-1"><name>shot.mp4</name><start>0</start><end>50</end><in>25</in><out>75</out>
            <file id="file-1"><name>shot.mp4</name><pathurl>file://localhost/Users/me/shot.mp4</pathurl></file></clipitem>
          <clipitem id="clipitem-2"><name>shot.mp4</name><start>100</start><end>150</end><in>0</in><out>50</out><file id="file-1"/></clipitem>
          <clipitem id="clipitem-3"><name>Color Matte</name><start>150</start><end>200</end><in>0</in><out>50</out></clipitem>
        </track>
      </video>
      <audio>
        <track><clipitem id="clipitem-4"><name>shot.mp4</name><start>0</start><end>50</end><in>25</in><out>75</out><file id="file-1"/></clipitem>
               <clipitem id="clipitem-5"><name>song</name><start>0</start><end>250</end><in>0</in><out>250</out>
                 <file id="file-2"><name>song.mp3</name><pathurl>file://localhost/Users/me/song.mp3</pathurl></file></clipitem></track>
        <track><clipitem id="clipitem-6"><name>song</name><start>0</start><end>250</end><in>0</in><out>250</out><file id="file-2"/></clipitem></track>
      </audio>
    </media>
  </sequence>
</xmeml>"#;
        let t = import_timeline(x).unwrap();
        assert_eq!((t.format, t.name.as_str(), t.fps, t.width, t.height, t.duration), ("xmeml", "Edit 1", Some(25.0), Some(1920), Some(1080), 10.0));
        assert_eq!(summary(&t), vec![
            ("V1".into(), "shot.mp4".into(), 0.0, 2.0, 1.0),
            ("V1".into(), "shot.mp4".into(), 4.0, 6.0, 0.0),
            ("A1".into(), "song.mp3".into(), 0.0, 10.0, 0.0),
        ]);
        assert_eq!(t.clips[0].url, "file://localhost/Users/me/shot.mp4");
        assert_eq!(t.skipped, vec!["generator Color Matte".to_string()]);
    }

    /// Resolve's OTIO: timecode-based media (available range from 01:00:00:00), a transition, a missing file.
    #[test]
    fn otio_from_resolve() {
        let rt = |v: f64| serde_json::json!({"OTIO_SCHEMA": "RationalTime.1", "rate": 24.0, "value": v});
        let range = |s: f64, d: f64| serde_json::json!({"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(s), "duration": rt(d)});
        let doc = serde_json::json!({
            "OTIO_SCHEMA": "Timeline.1", "name": "Resolve cut", "global_start_time": rt(86400.0),
            "tracks": {"OTIO_SCHEMA": "Stack.1", "children": [
                {"OTIO_SCHEMA": "Track.1", "kind": "Video", "name": "Video 1", "children": [
                    {"OTIO_SCHEMA": "Clip.2", "name": "C0001", "source_range": range(86424.0, 48.0),
                     "active_media_reference_key": "DEFAULT_MEDIA",
                     "media_references": {"DEFAULT_MEDIA": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": "/Volumes/A/C0001.MP4", "available_range": range(86400.0, 240.0)}}},
                    {"OTIO_SCHEMA": "Transition.1", "name": "Cross Dissolve"},
                    {"OTIO_SCHEMA": "Gap.1", "source_range": range(0.0, 24.0)},
                    {"OTIO_SCHEMA": "Clip.1", "name": "Lost", "source_range": range(0.0, 24.0), "media_reference": {"OTIO_SCHEMA": "MissingReference.1"}},
                    {"OTIO_SCHEMA": "Clip.1", "name": "C0002", "source_range": range(12.0, 24.0), "media_reference": {"OTIO_SCHEMA": "ExternalReference.1", "target_url": "file:///Volumes/A/C0002.MP4"}}
                ]}
            ]}
        });
        let t = import_timeline(&doc.to_string()).unwrap();
        assert_eq!((t.name.as_str(), t.fps), ("Resolve cut", Some(24.0)));
        assert_eq!(summary(&t), vec![("V1".into(), "C0001.MP4".into(), 0.0, 2.0, 1.0), ("V1".into(), "C0002.MP4".into(), 4.0, 5.0, 0.5)]);
        assert_eq!(t.skipped, vec!["Lost (no media file)".to_string()]);
    }

    #[test]
    fn overlapping_clips_move_to_a_free_track() {
        let mut t = ImportedTimeline { format: "otio", name: String::new(), fps: None, width: None, height: None, duration: 0.0, clips: Vec::new(), skipped: Vec::new() };
        let clip = |file: &str, track: &str, start: f32, end: f32| ImportedClip { name: file.into(), file: file.into(), url: file.into(), kind: ClipKind::Video, track: track.into(), start, end, trim_in: 0.0 };
        t.clips = vec![clip("a", "V1", 0.0, 4.0), clip("b", "V1", 3.0, 5.0), clip("c", "V2", 3.5, 4.5), clip("d", "V1", 4.0, 6.0)];
        tidy(&mut t);
        let tracks: Vec<_> = t.clips.iter().map(|c| (c.file.as_str(), c.track.as_str())).collect();
        assert_eq!(tracks, vec![("a", "V1"), ("d", "V1"), ("b", "V2"), ("c", "V3")]);
        assert_eq!(t.duration, 6.0);
    }

    #[test]
    fn junk_is_refused() {
        assert!(import_timeline("TITLE: x\n001 AX V C").is_err());
        assert!(import_timeline("<html/>").is_err());
        assert_eq!(file_of("file:///a/b/My%20clip.mov"), "My clip.mov");
        assert_eq!(file_of(r"C:\clips\x.mp4"), "x.mp4");
    }
}
