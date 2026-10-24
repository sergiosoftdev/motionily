//! An editor's trim tools on one track: ripple (an edge moves and everything after follows), roll
//! (the cut between two neighbours moves), slip (the clip shows another part of its file) and slide
//! (the clip moves between its neighbours, which give and take). Targets are absolute (a scene second,
//! a file second), so the same op can be applied again while a drag goes on.

use serde::{Deserialize, Serialize};

use crate::timeline::{from_value, shift_keys, to_value};
use crate::{Layer, OpError, Scene};

/// Clips this close in time touch (a cut between them).
const TOUCH: f32 = 0.01;
/// Shortest clip a trim leaves.
const MIN_LEN: f32 = 0.05;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    In,
    Out,
}

impl Scene {
    fn index_of(&self, id: &str) -> Result<usize, OpError> {
        self.layers.iter().position(|l| l.id == id).ok_or_else(|| OpError::Invalid("no layer with that id"))
    }

    fn end_of(&self, l: &Layer) -> f32 {
        l.end.unwrap_or(self.duration)
    }

    /// Clips that share a track: same `track` (or both none) and both media or pictures held as clips.
    fn same_track(a: &Layer, b: &Layer) -> bool {
        a.track == b.track && a.id != b.id
    }

    fn track_locked(&self, l: &Layer) -> bool {
        l.track.as_deref().is_some_and(|id| self.tracks.iter().any(|t| t.id == id && t.locked))
    }

    /// Move a layer's start by `dt` keeping its keyframes on the same moments of its content.
    fn shift_start_keep_content(l: &mut Layer, dt: f32) -> Result<(), OpError> {
        let speed = l.content.media_clip().map(|c| c.speed).unwrap_or(1.0);
        if let Some(c) = l.content.media_clip_mut() {
            c.trim_in = (c.trim_in + dt * speed).max(0.0);
        }
        l.start += dt;
        let mut v = to_value(l)?;
        shift_keys(&mut v, -dt);
        let id = l.id.clone();
        *l = from_value(v, &id)?;
        Ok(())
    }

    /// File length a clip can reach past its `in` (unknown = no limit).
    fn room_in_file(&self, l: &Layer) -> f32 {
        match l.content.media_clip() {
            Some(c) => match crate::video::media_duration(&c.src) {
                Some(d) if d > 0.0 => (d - c.trim_in) / c.speed.max(1e-3),
                _ => f32::INFINITY,
            },
            None => f32::INFINITY,
        }
    }

    /// Everything from `pivot` on moves by `dt` (other tracks' layers, sound effects, markers, captions),
    /// except locked tracks and `skip`; the video gets longer or shorter by as much.
    fn ripple_from(&mut self, pivot: f32, dt: f32, skip: &str) {
        let locked: Vec<bool> = self.layers.iter().map(|l| self.track_locked(l)).collect();
        for (i, l) in self.layers.iter_mut().enumerate() {
            if l.id == skip || locked[i] || l.start < pivot - TOUCH {
                continue;
            }
            l.start = (l.start + dt).max(0.0);
            if let Some(e) = l.end.as_mut() {
                *e = (*e + dt).max(l.start + MIN_LEN);
            }
        }
        for c in &mut self.sfx {
            if c.at >= pivot - TOUCH {
                c.at = (c.at + dt).max(0.0);
            }
        }
        for m in &mut self.markers {
            if m.t >= pivot - TOUCH {
                m.t = (m.t + dt).max(0.0);
            }
        }
        if let Some(cap) = self.captions.as_mut() {
            for w in &mut cap.words {
                if w.start >= pivot - TOUCH {
                    w.start = (w.start + dt).max(0.0);
                    w.end = (w.end + dt).max(w.start);
                }
            }
        }
        self.duration = (self.duration + dt).max(MIN_LEN);
    }

    /// Ripple trim: the clip's `edge` goes to scene second `to` and everything after it follows.
    pub(crate) fn ripple_trim(&mut self, id: &str, edge: Edge, to: f32) -> Result<(), OpError> {
        let i = self.index_of(id)?;
        let (start, end) = (self.layers[i].start, self.end_of(&self.layers[i]));
        match edge {
            Edge::Out => {
                let new_end = to.clamp(start + MIN_LEN, start + self.room_in_file(&self.layers[i]));
                let dt = new_end - end;
                let l = &mut self.layers[i];
                l.end = Some(new_end);
                if let Some(c) = l.content.media_clip_mut() {
                    if c.trim_out.is_some() {
                        c.trim_out = Some(c.trim_in + (new_end - start) * c.speed);
                    }
                }
                self.ripple_from(end, dt, id);
            }
            Edge::In => {
                // `to` = where the head is cut to: the clip keeps its start, loses (to - start) of its head.
                let speed = self.layers[i].content.media_clip().map(|c| c.speed).unwrap_or(1.0);
                let max_back = self.layers[i].content.media_clip().map(|c| c.trim_in / speed.max(1e-3)).unwrap_or(f32::INFINITY);
                let cut = (to - start).clamp(-max_back, end - start - MIN_LEN);
                let l = &mut self.layers[i];
                if let Some(c) = l.content.media_clip_mut() {
                    c.trim_in = (c.trim_in + cut * speed).max(0.0);
                }
                l.end = Some(end - cut);
                let mut v = to_value(l)?;
                shift_keys(&mut v, -cut);
                self.layers[i] = from_value(v, id)?;
                self.ripple_from(end, -cut, id);
            }
        }
        let l = self.layers[i].clone();
        self.layers[i] = self.checked_layer(l)?;
        Ok(())
    }

    /// The next clip on the same track, starting where `i` ends.
    fn next_on_track(&self, i: usize) -> Option<usize> {
        let end = self.end_of(&self.layers[i]);
        self.layers.iter().position(|o| Self::same_track(&self.layers[i], o) && (o.start - end).abs() < TOUCH && o.content.media_clip().is_some() == self.layers[i].content.media_clip().is_some())
    }

    fn prev_on_track(&self, i: usize) -> Option<usize> {
        let start = self.layers[i].start;
        self.layers.iter().position(|o| Self::same_track(&self.layers[i], o) && (self.end_of(o) - start).abs() < TOUCH && o.content.media_clip().is_some() == self.layers[i].content.media_clip().is_some())
    }

    /// Roll edit: the cut between this clip and the next one on its track goes to scene second `to`.
    pub(crate) fn roll_edit(&mut self, id: &str, to: f32) -> Result<(), OpError> {
        let a = self.index_of(id)?;
        let b = self.next_on_track(a).ok_or(OpError::Invalid("roll_edit needs a clip right after this one on its track"))?;
        let a_start = self.layers[a].start;
        let b_end = self.end_of(&self.layers[b]);
        let lo = (a_start + MIN_LEN).max(self.layers[b].start - self.layers[b].content.media_clip().map(|c| c.trim_in / c.speed.max(1e-3)).unwrap_or(f32::INFINITY));
        let hi = (b_end - MIN_LEN).min(a_start + self.room_in_file(&self.layers[a]));
        let cut = to.clamp(lo, hi.max(lo));
        let dt = cut - self.layers[b].start;
        self.layers[a].end = Some(cut);
        if let Some(c) = self.layers[a].content.media_clip_mut() {
            if c.trim_out.is_some() {
                c.trim_out = Some(c.trim_in + (cut - a_start) * c.speed);
            }
        }
        let mut lb = self.layers[b].clone();
        Self::shift_start_keep_content(&mut lb, dt)?;
        lb.end = Some(b_end);
        self.layers[b] = self.checked_layer(lb)?;
        let la = self.layers[a].clone();
        self.layers[a] = self.checked_layer(la)?;
        Ok(())
    }

    /// Slip: same place on the timeline, another part of the file (`in` = the file second it opens on).
    pub(crate) fn slip_clip(&mut self, id: &str, file_in: f32) -> Result<(), OpError> {
        let i = self.index_of(id)?;
        let len = self.end_of(&self.layers[i]) - self.layers[i].start;
        let l = &mut self.layers[i];
        let c = l.content.media_clip_mut().ok_or(OpError::Invalid("slip_clip works on video and audio clips"))?;
        let span = len * c.speed;
        let max_in = match crate::video::media_duration(&c.src) {
            Some(d) if d > 0.0 => (d - span).max(0.0),
            _ => f32::INFINITY,
        };
        c.trim_in = file_in.clamp(0.0, max_in);
        if c.trim_out.is_some() {
            c.trim_out = Some(c.trim_in + span);
        }
        let l = self.layers[i].clone();
        self.layers[i] = self.checked_layer(l)?;
        Ok(())
    }

    /// Slide: the clip moves to `start` between its neighbours on the track; the one before ends where
    /// it now starts, the one after starts where it now ends (both keep their content in place).
    pub(crate) fn slide_clip(&mut self, id: &str, start: f32) -> Result<(), OpError> {
        let i = self.index_of(id)?;
        let prev = self.prev_on_track(i);
        let next = self.next_on_track(i);
        let len = self.end_of(&self.layers[i]) - self.layers[i].start;
        let mut lo = 0.0_f32;
        let mut hi = f32::INFINITY;
        if let Some(p) = prev {
            lo = self.layers[p].start + MIN_LEN;
            hi = hi.min(self.layers[p].start + self.room_in_file(&self.layers[p]) - len);
        }
        if let Some(n) = next {
            hi = hi.min(self.end_of(&self.layers[n]) - MIN_LEN - len);
            let back = self.layers[n].content.media_clip().map(|c| c.trim_in / c.speed.max(1e-3)).unwrap_or(f32::INFINITY);
            lo = lo.max(self.layers[n].start - back - len);
        }
        let s = start.clamp(lo, hi.max(lo));
        let dt = s - self.layers[i].start;
        {
            let l = &mut self.layers[i];
            l.start = s;
            l.end = Some(s + len);
        }
        if let Some(p) = prev {
            let p_start = self.layers[p].start;
            let lp = &mut self.layers[p];
            lp.end = Some(s);
            if let Some(c) = lp.content.media_clip_mut() {
                if c.trim_out.is_some() {
                    c.trim_out = Some(c.trim_in + (s - p_start) * c.speed);
                }
            }
            let lp = self.layers[p].clone();
            self.layers[p] = self.checked_layer(lp)?;
        }
        if let Some(n) = next {
            let n_end = self.end_of(&self.layers[n]);
            let mut ln = self.layers[n].clone();
            Self::shift_start_keep_content(&mut ln, dt)?;
            ln.end = Some(n_end);
            self.layers[n] = self.checked_layer(ln)?;
        }
        let l = self.layers[i].clone();
        self.layers[i] = self.checked_layer(l)?;
        Ok(())
    }
}

/// How `place_clip` lays a new clip on its track: over what is there, or pushing everything later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceMode {
    /// Covers its time on the track: what was there is trimmed, split or removed.
    Overwrite,
    /// Opens room at its start: everything from there on (all unlocked tracks) moves later by its length.
    Insert,
}

impl Scene {
    /// Clips of a track a new clip can cut into: media clips and pictures held on the video track.
    fn is_track_clip(l: &Layer) -> bool {
        l.content.media_clip().is_some() || (matches!(l.content, crate::LayerContent::Image { .. }) && l.group.as_deref() == Some("footage"))
    }

    /// Lay `layer` (with its start and end) on its track, overwriting or inserting (NLE 3-point edits).
    pub(crate) fn place_clip(&mut self, layer: Layer, mode: PlaceMode) -> Result<(), OpError> {
        let s = layer.start;
        let e = layer.end.ok_or(OpError::Invalid("place_clip needs the clip's end"))?;
        if !(e > s + MIN_LEN) {
            return Err(OpError::Invalid("place_clip: the clip must last longer than 0.05 s"));
        }
        if self.layers.iter().any(|l| l.id == layer.id) {
            return Err(OpError::DuplicateLayer(layer.id.clone()));
        }
        let on_track = |sc: &Scene| -> Vec<String> { sc.layers.iter().filter(|l| l.track == layer.track && Self::is_track_clip(l)).map(|l| l.id.clone()).collect() };
        match mode {
            PlaceMode::Insert => {
                // A clip that spans the insert point is cut there, then everything after moves later.
                for id in on_track(self) {
                    let l = &self.layers[self.index_of(&id)?];
                    if l.start < s - TOUCH && self.end_of(l) > s + TOUCH {
                        self.split_layer(&id, s, None)?;
                    }
                }
                self.ripple_from(s, e - s, &layer.id);
            }
            PlaceMode::Overwrite => {
                for id in on_track(self) {
                    let i = self.index_of(&id)?;
                    let (ls, le) = (self.layers[i].start, self.end_of(&self.layers[i]));
                    if le <= s + TOUCH || ls >= e - TOUCH {
                        continue;
                    }
                    if ls >= s - TOUCH && le <= e + TOUCH {
                        self.layers.remove(i);
                        continue;
                    }
                    if ls < s && le > e {
                        // Spans the whole new clip: keep both ends.
                        let tail = self.split_layer(&id, e, None)?;
                        let _ = tail;
                        self.trim_end_to(&id, s)?;
                        continue;
                    }
                    if ls < s {
                        self.trim_end_to(&id, s)?;
                    } else {
                        let mut l = self.layers[i].clone();
                        Self::shift_start_keep_content(&mut l, e - ls)?;
                        l.end = Some(le);
                        self.layers[i] = self.checked_layer(l)?;
                    }
                }
            }
        }
        let layer = self.checked_layer(layer)?;
        self.layers.push(layer);
        if e > self.duration {
            self.duration = e;
        }
        Ok(())
    }

    /// End a clip at scene second `t` (its file window follows).
    fn trim_end_to(&mut self, id: &str, t: f32) -> Result<(), OpError> {
        let i = self.index_of(id)?;
        let start = self.layers[i].start;
        let l = &mut self.layers[i];
        l.end = Some(t);
        if let Some(c) = l.content.media_clip_mut() {
            if c.trim_out.is_some() {
                c.trim_out = Some(c.trim_in + (t - start) * c.speed);
            }
        }
        let l = self.layers[i].clone();
        self.layers[i] = self.checked_layer(l)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{Op, Scene};

    fn scene() -> Scene {
        let mut s = Scene { duration: 9.0, ..Scene::default() };
        crate::video::set_media_duration("/media/a.mp4", 20.0);
        crate::video::set_media_duration("/media/b.mp4", 20.0);
        s.apply(&Op::parse_list(r#"[
            {"op":"add_layer","layer":{"id":"a","type":"video","src":"/media/a.mp4","x":0,"y":0,"w":10,"h":10,"start":0,"end":3,"in":1}},
            {"op":"add_layer","layer":{"id":"b","type":"video","src":"/media/b.mp4","x":0,"y":0,"w":10,"h":10,"start":3,"end":6,"in":2}},
            {"op":"add_layer","layer":{"id":"c","type":"video","src":"/media/a.mp4","x":0,"y":0,"w":10,"h":10,"start":6,"end":9,"in":0}},
            {"op":"set_markers","markers":[{"t":7,"label":"beat"}]}
        ]"#).unwrap()).unwrap();
        s
    }
    /// (start, end, file in) of a layer.
    fn l(s: &Scene, id: &str) -> (f32, f32, f32) {
        let x = s.layers.iter().find(|x| x.id == id).unwrap();
        let r = |v: f32| (v * 1000.0).round() / 1000.0;
        (r(x.start), r(x.end.unwrap()), r(x.content.media_clip().map(|c| c.trim_in).unwrap_or(0.0)))
    }

    #[test]
    fn ripple_trim_moves_everything_after() {
        let mut s = scene();
        s.apply(&Op::parse_list(r#"[{"op":"ripple_trim","id":"a","edge":"out","to":2}]"#).unwrap()).unwrap();
        assert_eq!((l(&s, "a").1, l(&s, "b").0, l(&s, "c").0, s.markers[0].t, s.duration), (2.0, 2.0, 5.0, 6.0, 8.0));
        // Applying the same target again changes nothing (drags re-send it).
        s.apply(&Op::parse_list(r#"[{"op":"ripple_trim","id":"a","edge":"out","to":2}]"#).unwrap()).unwrap();
        assert_eq!(l(&s, "b").0, 2.0);
        // Head trim: `a` keeps its start, loses 0.5 s of its head (in 1 → 1.5), the rest moves back.
        s.apply(&Op::parse_list(r#"[{"op":"ripple_trim","id":"a","edge":"in","to":0.5}]"#).unwrap()).unwrap();
        assert_eq!((l(&s, "a").0, l(&s, "a").1, l(&s, "a").2, l(&s, "b").0), (0.0, 1.5, 1.5, 1.5));
    }

    #[test]
    fn place_clip_overwrites_or_inserts() {
        let new = r#"{"id":"n","type":"video","src":"/media/b.mp4","x":0,"y":0,"w":10,"h":10,"start":2,"end":4}"#;
        let mut s = scene();
        s.apply(&Op::parse_list(&format!(r#"[{{"op":"place_clip","mode":"overwrite","layer":{new}}}]"#)).unwrap()).unwrap();
        // a ends at 2, b now starts at 4 showing 1 s later in its file, c untouched, length unchanged.
        assert_eq!((l(&s, "a").1, l(&s, "b").0, l(&s, "b").2, l(&s, "n").0, s.duration), (2.0, 4.0, 3.0, 2.0, 9.0));
        let mut s = scene();
        s.apply(&Op::parse_list(&format!(r#"[{{"op":"place_clip","mode":"insert","layer":{new}}}]"#)).unwrap()).unwrap();
        // a is cut at 2 (its tail moves to 4), b and c move 2 s later, the marker too, the video grows.
        let tail = s.layers.iter().find(|x| x.id.starts_with("a_")).unwrap();
        assert_eq!((l(&s, "a").1, tail.start, l(&s, "b").0, l(&s, "c").0, s.markers[0].t, s.duration), (2.0, 4.0, 5.0, 8.0, 9.0, 11.0));
    }

    #[test]
    fn roll_slip_and_slide_keep_the_timeline_length() {
        let mut s = scene();
        s.apply(&Op::parse_list(r#"[{"op":"roll_edit","id":"a","to":3.5}]"#).unwrap()).unwrap();
        assert_eq!((l(&s, "a").1, l(&s, "b").0, l(&s, "b").1, l(&s, "b").2), (3.5, 3.5, 6.0, 2.5));
        s.apply(&Op::parse_list(r#"[{"op":"slip_clip","id":"c","in":4}]"#).unwrap()).unwrap();
        assert_eq!((l(&s, "c").0, l(&s, "c").2), (6.0, 4.0));
        // Slide b 1 s later: a grows to 4.5, c starts at 7.5 showing 1 s further into its file.
        s.apply(&Op::parse_list(r#"[{"op":"slide_clip","id":"b","start":4.5}]"#).unwrap()).unwrap();
        assert_eq!((l(&s, "a").1, l(&s, "b").0, l(&s, "b").1, l(&s, "c").0, l(&s, "c").2), (4.5, 4.5, 7.0, 7.0, 5.0));
        assert_eq!(s.duration, 9.0);
    }
}

#[cfg(test)]
mod attach_tests {
    use crate::{Op, Scene};

    #[test]
    fn windows_follow_their_clip_and_go_with_it() {
        let mut s: Scene = serde_json::from_str(r#"{"width":100,"height":100,"fps":30,"duration":10,"layers":[
            {"id":"c","type":"video","src":"/media/a.mp4","start":1,"end":4},
            {"id":"w","type":"shape","shape":"ellipse","adjustment":true,"attach":"c","x":50,"y":50,"w":20,"h":20,"start":0,"end":10}]}"#).unwrap();
        let ops: Vec<Op> = serde_json::from_str(r#"[{"op":"patch","id":"c","fields":{"start":2,"end":6}}]"#).unwrap();
        s.apply(&ops).unwrap();
        let w = s.layers.iter().find(|l| l.id == "w").unwrap();
        assert_eq!((w.start, w.end), (2.0, Some(6.0)));
        let ops: Vec<Op> = serde_json::from_str(r#"[{"op":"remove_layer","id":"c"}]"#).unwrap();
        s.apply(&ops).unwrap();
        assert!(s.layers.is_empty(), "the window went with its clip");
    }
}
