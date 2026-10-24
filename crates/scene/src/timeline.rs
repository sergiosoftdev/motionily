//! Cutting time, like an editor's razor: `ripple_delete` takes a stretch out of the whole video
//! (voice, captions, layers, clips, sound effects, markers) and closes the gap; `restore_cut` puts part of
//! a voice cut back and opens the video by as much; `split_layer` cuts one layer in two at an instant. Keyframes are layer-local seconds, so they are moved with the cut;
//! clips get a real jump cut (their file time skips what was removed).
use serde_json::Value;

use crate::{Layer, OpError, Scene};

/// Shorter than this is no cut at all.
const MIN_CUT: f32 = 1e-3;

/// Where a scene time lands once `[from, to]` is gone (times inside collapse onto `from`).
fn after_cut(t: f32, from: f32, to: f32) -> f32 {
    if t <= from {
        t
    } else if t >= to {
        t - (to - from)
    } else {
        from
    }
}

/// A voice cut seam is found within this distance of the second asked for.
const SEAM_TOLERANCE: f32 = 0.05;

/// Where a scene time lands once `d` seconds open at `at` (from `at` on, everything moves later).
fn after_open(t: f32, at: f32, d: f32) -> f32 {
    if t >= at {
        t + d
    } else {
        t
    }
}

/// Re-time one key list from the old layer start `s` to the new start `s2`, opening `d` seconds at scene
/// time `at`. The curve holds its value through the opening, so nothing moves in the restored pause.
fn open_keys(keys: &mut Vec<Value>, s: f32, s2: f32, at: f32, d: f32) {
    let hold = value_at(keys, at - s);
    let splits = keys.iter().any(|k| s + key_t(k) < at) && keys.iter().any(|k| s + key_t(k) > at);
    let mut out: Vec<Value> = Vec::with_capacity(keys.len() + 1);
    for mut k in keys.drain(..) {
        let scene_t = s + key_t(&k);
        if splits && scene_t >= at && out.last().is_some_and(|p: &Value| s2 + key_t(p) < at) {
            if let Some(v) = hold.clone() {
                let mut b = k.clone();
                if let Some(o) = b.as_object_mut() {
                    o.insert("v".into(), v);
                    o.remove("bezier");
                }
                set_t(&mut b, at - s2);
                out.push(b);
            }
        }
        set_t(&mut k, after_open(scene_t, at, d) - s2);
        out.push(k);
    }
    out.dedup_by(|b, a| (key_t(a) - key_t(b)).abs() < 1e-4);
    *keys = out;
}

/// Every keyframe list inside a layer's JSON: arrays of objects that all carry a numeric `t`.
fn for_each_keys(v: &mut Value, f: &mut dyn FnMut(&mut Vec<Value>)) {
    match v {
        Value::Array(items) => {
            let keys = !items.is_empty() && items.iter().all(|i| i.get("t").and_then(Value::as_f64).is_some());
            if keys {
                f(items);
            } else {
                items.iter_mut().for_each(|i| for_each_keys(i, f));
            }
        }
        Value::Object(map) => map.values_mut().for_each(|i| for_each_keys(i, f)),
        _ => {}
    }
}

fn key_t(k: &Value) -> f32 {
    k.get("t").and_then(Value::as_f64).unwrap_or(0.0) as f32
}

fn set_t(k: &mut Value, t: f32) {
    if let Some(o) = k.as_object_mut() {
        o.insert("t".into(), Value::from(((t * 1000.0).round() / 1000.0) as f64));
    }
}

/// Numeric value of a key list at local time `t` (linear between keys; holds at the ends).
fn value_at(keys: &[Value], t: f32) -> Option<Value> {
    let num = |k: &Value| k.get("v").and_then(Value::as_f64);
    let after = keys.iter().position(|k| key_t(k) >= t);
    match after {
        Some(0) => keys.first().and_then(|k| k.get("v").cloned()),
        None => keys.last().and_then(|k| k.get("v").cloned()),
        Some(i) => {
            let (a, b) = (&keys[i - 1], &keys[i]);
            match (num(a), num(b)) {
                (Some(va), Some(vb)) => {
                    let span = (key_t(b) - key_t(a)).max(1e-6);
                    let u = ((t - key_t(a)) / span) as f64;
                    Some(Value::from(va + (vb - va) * u))
                }
                // Colors and other values change on a key, not in between.
                _ => a.get("v").cloned(),
            }
        }
    }
}

/// Re-time one key list from the old layer start `s` to the new start `s2`, removing `[from, to]`.
/// A key that falls inside the cut is replaced by the value at the cut, so the curve never jumps.
fn cut_keys(keys: &mut Vec<Value>, s: f32, s2: f32, from: f32, to: f32) {
    let at_cut = value_at(keys, to - s);
    let mut out: Vec<Value> = Vec::with_capacity(keys.len() + 1);
    let mut bridged = false;
    for mut k in keys.drain(..) {
        let scene_t = s + key_t(&k);
        if scene_t > from && scene_t < to {
            continue;
        }
        if scene_t >= to && !bridged {
            bridged = true;
            if let (Some(v), Some(prev)) = (at_cut.clone(), out.last()) {
                // Hold the curve where it was cut.
                if (s + key_t(prev)) < from {
                    let mut b = k.clone();
                    if let Some(o) = b.as_object_mut() {
                        o.insert("v".into(), v);
                        o.remove("bezier");
                    }
                    set_t(&mut b, from - s2);
                    out.push(b);
                }
            }
        }
        set_t(&mut k, after_cut(scene_t, from, to) - s2);
        out.push(k);
    }
    out.dedup_by(|b, a| (key_t(a) - key_t(b)).abs() < 1e-4);
    *keys = out;
}

/// Shift every key list of a layer JSON by `dt` seconds (layer-local), dropping keys before 0 but
/// keeping the value there.
fn shift_keys(v: &mut Value, dt: f32) {
    for_each_keys(v, &mut |keys| {
        let at0 = value_at(keys, -dt);
        let mut out: Vec<Value> = Vec::new();
        let mut dropped = false;
        for mut k in keys.drain(..) {
            let t = key_t(&k) + dt;
            if t < 0.0 {
                dropped = true;
                continue;
            }
            set_t(&mut k, t);
            out.push(k);
        }
        if dropped {
            if let (Some(v), Some(first)) = (at0, out.first().cloned().or(None)) {
                let mut k = first;
                if let Some(o) = k.as_object_mut() {
                    o.insert("v".into(), v);
                }
                set_t(&mut k, 0.0);
                out.insert(0, k);
            }
        }
        *keys = out;
    });
}

fn to_value(l: &Layer) -> Result<Value, OpError> {
    serde_json::to_value(l).map_err(|e| OpError::Field(e.to_string()))
}

fn from_value(v: Value, id: &str) -> Result<Layer, OpError> {
    serde_json::from_value(v).map_err(|e| OpError::Field(format!("layer '{id}': {e}")))
}

/// File time of a clip at layer-local time `local` (no time remap: speed only).
fn clip_file_time(l: &Layer, local: f32) -> Option<f32> {
    l.content.media_clip().map(|clip| clip.trim_in + local * clip.speed)
}

impl Scene {
    /// Take `[from, to]` out of the whole video and close the gap.
    pub(crate) fn ripple_delete(&mut self, from: f32, to: f32) -> Result<(), OpError> {
        if !(from.is_finite() && to.is_finite() && from >= 0.0 && to > from) {
            return Err(OpError::Invalid("ripple_delete needs 0 <= from < to (seconds)"));
        }
        let to = to.min(self.duration.max(from));
        let d = to - from;
        if d < MIN_CUT {
            return Ok(());
        }
        // Layers: shift, trim, cut clips in two, drop what lived only inside the cut.
        let parents: std::collections::HashSet<String> = self.layers.iter().filter_map(|l| l.parent.clone()).collect();
        let mut next: Vec<Layer> = Vec::with_capacity(self.layers.len() + 4);
        for l in &self.layers {
            let s = l.start;
            let e = l.end;
            let inside = s >= from && e.is_some_and(|e| e <= to);
            if inside && !parents.contains(&l.id) {
                continue;
            }
            let s2 = after_cut(s, from, to);
            let e2 = e.map(|e| after_cut(e, from, to));
            let spans = s < from && e.is_none_or(|e| e > to);
            if spans && l.content.media_clip().is_some() && l.time.is_none() {
                // A jump cut: the clip stops at `from` and goes on from what played at `to`.
                let mut a = l.clone();
                a.end = Some(from);
                if let Some(clip) = a.content.media_clip_mut() {
                    clip.trim_out = Some(clip.trim_in + (from - s) * clip.speed);
                }
                let mut bv = to_value(l)?;
                shift_keys(&mut bv, -(to - s));
                let mut b = from_value(bv, &l.id)?;
                b.id = self.free_id(&format!("{}_2", l.id), &next);
                b.start = from;
                b.end = e.map(|e| e - d);
                if let Some(clip) = b.content.media_clip_mut() {
                    clip.trim_in = clip_file_time(l, to - s).unwrap_or(clip.trim_in);
                }
                next.push(self.checked_layer(a)?);
                next.push(self.checked_layer(b)?);
                continue;
            }
            let mut v = to_value(l)?;
            for_each_keys(&mut v, &mut |keys| cut_keys(keys, s, s2, from, to));
            let mut l2 = from_value(v, &l.id)?;
            l2.start = s2;
            l2.end = e2.map(|e| if e <= s2 { s2 + MIN_CUT } else { e });
            if s > from && s < to {
                // Started inside the cut: a clip skips what it would have played there.
                if let Some(clip) = l2.content.media_clip_mut() {
                    clip.trim_in += (to - s) * clip.speed;
                }
            }
            next.push(self.checked_layer(l2)?);
        }
        self.layers = next;

        // Voice: cut the file where it played inside the range, then move it like a layer. A scene without
        // an explicit track still plays its voice from 0 (the default placement): give it one, or the
        // voice would keep its full length while everything else moved up.
        {
            let audio = self.audio.get_or_insert_with(crate::AudioTrack::default);
            let mut track = audio.clone();
            for (at, a, b) in audio.pieces(f32::INFINITY) {
                let lo = from.max(at);
                let hi = to.min(at + (b - a));
                if hi > lo {
                    track.cut(a + lo - at, a + hi - at);
                }
            }
            track.start = after_cut(audio.start, from, to);
            *audio = track;
        }
        if let Some(c) = &mut self.captions {
            c.words.retain(|w| !(w.start >= from && w.start < to));
            for w in &mut c.words {
                w.start = after_cut(w.start, from, to);
                w.end = after_cut(w.end, from, to);
            }
        }
        // Music keeps playing across the cut (no jump in the song); it only moves if it began after.
        if let Some(m) = &mut self.music {
            if m.start >= to {
                m.start -= d;
            }
        }
        self.sfx.retain(|c| !(c.at >= from && c.at < to));
        self.sfx.iter_mut().for_each(|c| c.at = after_cut(c.at, from, to));
        self.transitions.retain(|t| !(t.at > from && t.at < to));
        self.transitions.iter_mut().for_each(|t| t.at = after_cut(t.at, from, to));
        self.markers.retain(|m| !(m.t > from && m.t < to));
        self.markers.iter_mut().for_each(|m| m.t = after_cut(m.t, from, to));
        if let Some([a, b]) = self.work_area {
            let (a2, b2) = (after_cut(a, from, to), after_cut(b, from, to));
            self.work_area = (b2 > a2).then_some([a2, b2]);
        }
        self.duration = (self.duration - d).max(MIN_CUT);
        Ok(())
    }

    /// Put back `before` seconds of the voice cut whose seam plays at scene second `at` (from where the cut
    /// began) and `after` seconds (up to where it ended): all of it when both are `None`. The video opens by
    /// as much at the seam: everything from there on moves later, layers playing across it last longer and
    /// hold their animation through the opening. The inverse of `ripple_delete` at a pause.
    pub(crate) fn restore_cut(&mut self, at: f32, before: Option<f32>, after: Option<f32>) -> Result<(), OpError> {
        let audio = self.audio.clone().unwrap_or_default();
        let pieces = audio.pieces(f32::INFINITY);
        let seams: Vec<(f32, f32, f32)> = pieces.windows(2).map(|w| (w[1].0, w[0].2, w[1].1)).collect();
        let Some(&(seam, cut_from, cut_to)) = seams.iter().find(|(t, _, _)| (t - at).abs() <= SEAM_TOLERANCE) else {
            let list = seams.iter().map(|(t, _, _)| format!("{t:.2}")).collect::<Vec<_>>().join(", ");
            return Err(OpError::Field(format!(
                "restore_cut: no voice cut at {at:.2} s; the voice's cuts are at {} s",
                if list.is_empty() { "none".into() } else { list }
            )));
        };
        let len = cut_to - cut_from;
        let (b, a) = match (before, after) {
            (None, None) => (len, 0.0),
            (b, a) => (b.unwrap_or(0.0), a.unwrap_or(0.0)),
        };
        if !(b >= 0.0 && a >= 0.0 && b.is_finite() && a.is_finite()) {
            return Err(OpError::Invalid("restore_cut needs before/after >= 0 (seconds)"));
        }
        let b = b.min(len);
        let a = a.min(len - b);
        let d = b + a;
        if d < MIN_CUT {
            return Ok(());
        }
        let mut track = audio;
        track.cuts.retain(|c| !((c[0] - cut_from).abs() < 1e-4 && (c[1] - cut_to).abs() < 1e-4));
        if len - d >= MIN_CUT {
            track.cut(cut_from + b, cut_to - a);
        }
        self.audio = Some(track);

        let mut next: Vec<Layer> = Vec::with_capacity(self.layers.len());
        for l in &self.layers {
            let (s, e) = (l.start, l.end);
            if e.is_some_and(|e| e <= seam) {
                next.push(l.clone());
                continue;
            }
            let s2 = after_open(s, seam, d);
            let mut v = to_value(l)?;
            for_each_keys(&mut v, &mut |keys| open_keys(keys, s, s2, seam, d));
            let mut l2 = from_value(v, &l.id)?;
            l2.start = s2;
            l2.end = e.map(|e| e + d);
            if s < seam {
                // Plays across the opening: a clip plays on for as long (no frame is skipped).
                if let Some(clip) = l2.content.media_clip_mut() {
                    clip.trim_out = clip.trim_out.map(|o| o + d * clip.speed);
                }
            }
            next.push(self.checked_layer(l2)?);
        }
        self.layers = next;
        if let Some(c) = &mut self.captions {
            for w in &mut c.words {
                w.start = after_open(w.start, seam, d);
                w.end = after_open(w.end, seam, d);
            }
        }
        if let Some(m) = &mut self.music {
            m.start = after_open(m.start, seam, d);
        }
        self.sfx.iter_mut().for_each(|c| c.at = after_open(c.at, seam, d));
        self.transitions.iter_mut().for_each(|t| t.at = after_open(t.at, seam, d));
        self.markers.iter_mut().for_each(|m| m.t = after_open(m.t, seam, d));
        if let Some([w0, w1]) = self.work_area {
            self.work_area = Some([after_open(w0, seam, d), after_open(w1, seam, d)]);
        }
        self.duration += d;
        Ok(())
    }

    /// Cut a layer in two at scene time `at`: the original ends there, a copy (`new_id`, or
    /// `<id>_2`) carries on from there with its keys and clip time moved along.
    pub(crate) fn split_layer(&mut self, id: &str, at: f32, new_id: Option<&str>) -> Result<String, OpError> {
        let idx = self.layers.iter().position(|l| l.id == id).ok_or_else(|| OpError::UnknownLayer(id.to_owned()))?;
        let l = self.layers[idx].clone();
        if !(at > l.start + MIN_CUT && l.end.is_none_or(|e| at < e - MIN_CUT)) {
            return Err(OpError::Invalid("split_layer: `at` must fall inside the layer's time"));
        }
        let id2 = match new_id {
            Some(n) if self.layer(n).is_some() => return Err(OpError::DuplicateLayer(n.to_owned())),
            Some(n) => n.to_owned(),
            None => self.free_id(&format!("{id}_2"), &self.layers),
        };
        let local = at - l.start;
        let mut a = l.clone();
        a.end = Some(at);
        if let Some(clip) = a.content.media_clip_mut() {
            if l.time.is_none() {
                clip.trim_out = Some(clip.trim_in + local * clip.speed);
            }
        }
        let mut bv = to_value(&l)?;
        shift_keys(&mut bv, -local);
        let mut b = from_value(bv, id)?;
        b.id = id2.clone();
        b.start = at;
        if let Some(clip) = b.content.media_clip_mut() {
            if l.time.is_none() {
                clip.trim_in += local * clip.speed;
            }
        }
        let (a, b) = (self.checked_layer(a)?, self.checked_layer(b)?);
        self.layers[idx] = a;
        self.layers.insert(idx + 1, b);
        Ok(id2)
    }

    /// `base`, or `base_2`, `base_3`… — the first id no layer uses.
    fn free_id(&self, base: &str, also: &[Layer]) -> String {
        let taken = |id: &str| self.layers.iter().chain(also.iter()).any(|l| l.id == id);
        if !taken(base) {
            return base.to_owned();
        }
        (2..).map(|n| format!("{base}_{n}")).find(|id| !taken(id)).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use crate::{Op, Scene};

    fn scene() -> Scene {
        let mut s = Scene::default();
        s.duration = 20.0;
        s.apply(
            &Op::parse_list(
                r##"[{"op":"add_layer","layer":{"id":"bg","type":"shape","shape":"rect","w":100,"h":100,"x":[{"t":0,"v":0},{"t":20,"v":200,"ease":"linear"}]}},
                {"op":"add_layer","layer":{"id":"early","type":"shape","shape":"rect","w":10,"h":10,"start":1,"end":4}},
                {"op":"add_layer","layer":{"id":"inside","type":"shape","shape":"rect","w":10,"h":10,"start":6,"end":8}},
                {"op":"add_layer","layer":{"id":"late","type":"shape","shape":"rect","w":10,"h":10,"start":12,"end":15}},
                {"op":"add_layer","layer":{"id":"clip","type":"video","src":"/media/a.mp4","w":10,"h":10,"start":2,"end":14,"in":3}},
                {"op":"set_audio","audio":{"start":0,"trim_in":0,"trim_out":null}},
                {"op":"set_captions","captions":{"words":[{"text":"keep","start":4,"end":4.5},{"text":"drop","start":6,"end":6.5},{"text":"after","start":11,"end":11.5}]}}]"##,
            )
            .unwrap(),
        )
        .unwrap();
        s
    }

    #[test]
    fn ripple_delete_closes_the_gap_everywhere() {
        let mut s = scene();
        s.apply(&Op::parse_list(r#"[{"op":"ripple_delete","from":5,"to":10}]"#).unwrap()).unwrap();
        assert_eq!(s.duration, 15.0);
        assert!(s.layer("inside").is_none(), "a layer only inside the cut goes");
        assert_eq!((s.layer("early").unwrap().start, s.layer("early").unwrap().end), (1.0, Some(4.0)));
        assert_eq!((s.layer("late").unwrap().start, s.layer("late").unwrap().end), (7.0, Some(10.0)));
        // The clip is cut in two: up to 5 s, then what played at 10 s.
        let (a, b) = (s.layer("clip").unwrap(), s.layer("clip_2").unwrap());
        assert_eq!((a.end, b.start, b.end), (Some(5.0), 5.0, Some(9.0)));
        if let (Some(ca), Some(cb)) = (a.content.media_clip(), b.content.media_clip()) {
            assert_eq!((ca.trim_out, cb.trim_in), (Some(6.0), 11.0));
        }
        // The voice skips file 5-10 s and the words after it move up.
        let audio = s.audio.as_ref().unwrap();
        assert_eq!(audio.cuts, vec![[5.0, 10.0]]);
        assert_eq!(audio.to_file(6.0), Some(11.0));
        let words: Vec<_> = s.captions.as_ref().unwrap().words.iter().map(|w| (w.text.as_str(), w.start)).collect();
        assert_eq!(words, vec![("keep", 4.0), ("after", 6.0)]);
        // A spanning layer's keys move with the cut (the 20 s key lands at 15 s).
        let bg = serde_json::to_value(s.layer("bg").unwrap()).unwrap();
        let ts: Vec<f64> = bg["x"].as_array().unwrap().iter().map(|k| k["t"].as_f64().unwrap()).collect();
        assert_eq!(ts.last().copied(), Some(15.0));
    }

    #[test]
    fn ripple_delete_cuts_the_voice_even_without_an_explicit_track() {
        let mut s = scene();
        s.audio = None;
        s.apply(&Op::parse_list(r#"[{"op":"ripple_delete","from":5,"to":10}]"#).unwrap()).unwrap();
        let audio = s.audio.as_ref().expect("the default placement became a track with the cut");
        assert_eq!(audio.cuts, vec![[5.0, 10.0]]);
        assert_eq!(audio.to_file(6.0), Some(11.0), "voice and captions move up together");
    }

    #[test]
    fn restore_cut_puts_part_of_a_voice_cut_back_and_opens_the_video() {
        let mut s = scene();
        s.apply(&Op::parse_list(r#"[{"op":"ripple_delete","from":5,"to":10}]"#).unwrap()).unwrap();
        let (bg_x, late) = (s.layer("bg").unwrap().clone(), s.layer("late").unwrap().start);
        // The seam plays at 5 s: give back 0.2 s of what came before the cut and 0.3 s of what came after.
        s.apply(&Op::parse_list(r#"[{"op":"restore_cut","at":5.02,"before":0.2,"after":0.3}]"#).unwrap()).unwrap();
        let audio = s.audio.as_ref().unwrap();
        assert_eq!(audio.cuts, vec![[5.2, 9.7]]);
        assert_eq!(audio.to_file(5.5), Some(10.0), "what followed the seam is heard 0.5 s later");
        assert_eq!(audio.to_file(5.2), Some(9.7), "the restored 0.3 s plays right before it");
        assert_eq!(s.duration, 15.5);
        assert_eq!(s.layer("late").unwrap().start, late + 0.5);
        assert_eq!(s.captions.as_ref().unwrap().words.last().unwrap().start, 6.5);
        // A layer playing across the seam lasts 0.5 s longer and holds its value through the opening.
        let bg = s.layer("bg").unwrap();
        assert!(bg.end.is_none() && serde_json::to_string(bg).unwrap() != serde_json::to_string(&bg_x).unwrap());
        // All of a cut back: the voice plays its whole file again.
        s.apply(&Op::parse_list(r#"[{"op":"restore_cut","at":5.2}]"#).unwrap()).unwrap();
        assert!(s.audio.as_ref().unwrap().cuts.is_empty());
        assert_eq!(s.duration, 20.0);
        let err = s.apply(&Op::parse_list(r#"[{"op":"restore_cut","at":3}]"#).unwrap()).unwrap_err();
        assert!(err.1.to_string().contains("no voice cut at 3.00 s"), "{}", err.1);
    }

    #[test]
    fn split_layer_cuts_a_clip_in_two() {
        let mut s = scene();
        s.apply(&Op::parse_list(r#"[{"op":"split_layer","id":"clip","at":6}]"#).unwrap()).unwrap();
        let (a, b) = (s.layer("clip").unwrap(), s.layer("clip_2").unwrap());
        assert_eq!((a.end, b.start, b.end), (Some(6.0), 6.0, Some(14.0)));
        if let (Some(ca), Some(cb)) = (a.content.media_clip(), b.content.media_clip()) {
            assert_eq!((ca.trim_out, cb.trim_in), (Some(7.0), 7.0));
        }
    }
}
