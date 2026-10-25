//! Precompose (After Effects): some layers move into a new component and one instance of it
//! takes their place, drawing exactly what they drew.
//!
//! The component's clock starts at the earliest of their starts, so their times are re-based to
//! it; formulas that read scene time are rewritten for that clock (`Expr::shifted`). Whatever a
//! component can't hold the same way (depth and tilt, the camera, links across the selection)
//! is refused with the reason, never drawn differently.

use crate::component::{Component, USE_TYPE};
use crate::ops::OpError;
use crate::{expr, Animated, Layer, LayerContent, Scene};
use serde_json::{Map, Value};

/// Keys whose strings are names, words or data, never formulas.
const NOT_FORMULAS: [&str; 15] = ["id", "type", "text", "parent", "group", "comp", "src", "d", "layer", "of", "use", "icon", "anchor", "code", "family"];
/// The text field, where component params are written `$name` (a literal `$` is `$$`).
const TEXT_FIELD: &str = "text";

fn fail(why: String) -> OpError {
    OpError::Component(format!("precompose: {why}"))
}

/// Every formula in a layer's JSON, with a way to replace it.
fn formulas(v: &mut Value, f: &mut dyn FnMut(&mut String)) {
    match v {
        Value::String(s) => f(s),
        Value::Array(a) => a.iter_mut().for_each(|x| formulas(x, f)),
        Value::Object(o) => o.iter_mut().filter(|(k, _)| !NOT_FORMULAS.contains(&k.as_str())).for_each(|(_, x)| formulas(x, f)),
        _ => {}
    }
}

/// Layer ids a layer's formulas read.
fn reads(l: &Layer) -> Vec<String> {
    let mut v = serde_json::to_value(l).unwrap_or(Value::Null);
    let mut out = Vec::new();
    formulas(&mut v, &mut |s| {
        let e = expr::Expr::new(s.clone());
        if e.check().is_ok() {
            out.extend(e.refs());
        }
    });
    out
}

/// `a + d` for a position that may be a number, keys or a formula.
fn offset(a: &Animated, d: f32) -> Result<Animated, OpError> {
    Ok(match a {
        Animated::Static(v) => Animated::Static(v + d),
        Animated::Keys(keys) => Animated::Keys(keys.iter().map(|k| crate::Keyframe { v: k.v + d, ..k.clone() }).collect()),
        Animated::Expr(e) => {
            let shifted = expr::Expr::new(format!("({}) + {d}", e.src));
            shifted.check().map_err(fail)?;
            Animated::Expr(shifted)
        }
    })
}

impl Scene {
    pub(crate) fn precompose(&mut self, ids: &[String], name: &str, inst_id: &str) -> Result<(), OpError> {
        if ids.is_empty() {
            return Err(fail("say which layers: ids".into()));
        }
        if self.library.components.contains_key(name) {
            return Err(fail(format!("component '{name}' already exists; pick a new name")));
        }
        let mut picked = ids
            .iter()
            .map(|id| self.layers.iter().position(|l| &l.id == id).ok_or_else(|| OpError::UnknownLayer(id.clone())))
            .collect::<Result<Vec<usize>, OpError>>()?;
        picked.sort_unstable();
        picked.dedup();
        let inside = |id: &str| picked.iter().any(|&i| self.layers[i].id == id);
        let exists = |id: &str| self.layer(id).is_some();
        if self.layers.iter().any(|l| l.id == inst_id && !inside(&l.id)) {
            return Err(OpError::DuplicateLayer(inst_id.to_owned()));
        }
        let moved: Vec<&Layer> = picked.iter().map(|&i| &self.layers[i]).collect();
        for l in &moved {
            if l.camera.is_some() {
                return Err(fail(format!("'{}' is the camera; precompose the layers it films, not the camera", l.id)));
            }
            if l.is_3d() || l.z != Animated::Static(0.0) {
                return Err(fail(format!("'{}' has depth or tilt (z/rotate_x/rotate_y), which layers inside a component ignore; precompose flat layers and give the instance the depth or tilt", l.id)));
            }
            if let Some(m) = l.matte.as_ref().filter(|m| !inside(&m.layer) && exists(&m.layer)) {
                return Err(fail(format!("'{}' is matted by '{}', which stays outside: add '{}' to ids", l.id, m.layer, m.layer)));
            }
            if let Some(r) = reads(l).into_iter().find(|r| !inside(r) && exists(r)) {
                return Err(fail(format!("'{}' has a formula reading '{r}', which stays outside: add '{r}' to ids or remove the reference", l.id)));
            }
        }
        for l in self.layers.iter().filter(|l| !inside(&l.id)) {
            if let Some(p) = l.parent.as_deref().filter(|p| inside(p)) {
                return Err(fail(format!("'{}' (staying outside) is parented to '{p}': add '{}' to ids or unparent it first", l.id, l.id)));
            }
            if let Some(m) = l.matte.as_ref().filter(|m| inside(&m.layer)) {
                return Err(fail(format!("'{}' (staying outside) is matted by '{}': add '{}' to ids", l.id, m.layer, l.id)));
            }
            if let Some(r) = reads(l).into_iter().find(|r| inside(r)) {
                return Err(fail(format!("'{}' (staying outside) has a formula reading '{r}': add '{}' to ids or remove the reference", l.id, l.id)));
            }
        }
        let fixed = moved[0].fixed;
        if moved.iter().any(|l| l.fixed != fixed) {
            return Err(fail("some layers are pinned (fixed) and others are not: precompose them separately".into()));
        }
        // The parent a layer really has (a missing or self parent is none).
        let parent_of = |l: &Layer| l.parent.clone().filter(|p| p != &l.id && exists(p));
        // Layers hanging from outside the selection hang from the instance, so they must share one parent.
        let roots: Vec<&Layer> = moved.iter().copied().filter(|l| parent_of(l).is_none_or(|p| !inside(&p))).collect();
        let outer = parent_of(roots[0]);
        if let Some(l) = roots.iter().find(|l| parent_of(l) != outer) {
            let name = |p: Option<String>| p.map_or("none".to_owned(), |p| format!("'{p}'"));
            return Err(fail(format!(
                "'{}' (parent {}) and '{}' (parent {}) hang from different parents outside the selection: precompose layers that share one parent",
                roots[0].id,
                name(outer.clone()),
                l.id,
                name(parent_of(l))
            )));
        }
        // Anchors get baked into x/y below, so a formula reading those x/y would read other numbers.
        let baked = |l: &Layer| parent_of(l).is_none() && l.anchor.as_deref().is_some_and(|a| self.library.anchor(a).is_some());
        for l in &moved {
            if let Some(r) = reads(l).into_iter().find(|r| moved.iter().any(|m| &m.id == r && baked(m))) {
                return Err(fail(format!("'{}' has a formula reading '{r}', which is pinned to an anchor: give '{r}' plain x/y first (set_anchor null)", l.id)));
            }
        }
        let t0 = moved.iter().map(|l| l.start).fold(f32::INFINITY, f32::min);
        let t1 = moved.iter().map(|l| l.end).try_fold(t0, |e, x| x.map(|x| e.max(x)));
        let group = moved[0].group.clone().filter(|g| moved.iter().all(|l| l.group.as_deref() == Some(g)));

        let mut layers = Vec::with_capacity(moved.len());
        for l in &moved {
            let mut c = (*l).clone();
            c.start -= t0;
            c.end = c.end.map(|e| e - t0);
            if baked(l) {
                // Inside a component every layer is parented to the instance, which drops anchors: bake them.
                if let Some([ax, ay]) = l.anchor.as_deref().and_then(|a| self.library.anchor(a)) {
                    c.x = offset(&c.x, ax * self.width as f32)?;
                    c.y = offset(&c.y, ay * self.height as f32)?;
                }
            }
            if parent_of(l) == outer {
                c.parent = None;
            }
            // What only means something at the top level: the instance carries it.
            c.anchor = None;
            c.place = None;
            c.group = None;
            c.fixed = false;
            c.solo = false;
            // Tracks are the top level's: the instance sits on them.
            c.track = None;
            // Through text, so f32 fields stay short (`0.2`, not `0.20000000298023224`) in the component.
            let mut v: Value = serde_json::to_string(&c).and_then(|j| serde_json::from_str(&j)).map_err(|e| fail(e.to_string()))?;
            if t0 != 0.0 {
                formulas(&mut v, &mut |s| {
                    let e = expr::Expr::new(s.clone());
                    if let Some(shifted) = e.check().ok().and_then(|_| e.shifted(t0)) {
                        *s = shifted;
                    }
                });
            }
            if let Some(Value::String(text)) = v.get_mut(TEXT_FIELD) {
                *text = text.replace('$', "$$");
            }
            layers.push(v);
        }
        let component = Component { params: Vec::new(), duration: t1.map(|e| e - t0), layers };

        let mut fields = Map::new();
        fields.insert("id".into(), inst_id.into());
        fields.insert("type".into(), USE_TYPE.into());
        fields.insert("comp".into(), name.into());
        fields.insert("start".into(), t0.into());
        if let Some(e) = t1 {
            fields.insert("end".into(), e.into());
        }
        if let Some(p) = outer {
            fields.insert("parent".into(), p.into());
        }
        if let Some(g) = group {
            fields.insert("group".into(), g.into());
        }
        if fixed {
            fields.insert("fixed".into(), true.into());
        }
        if moved.iter().any(|l| l.solo) {
            fields.insert("solo".into(), true.into());
        }
        // A compound clip stays on its clips' track (the first one's when they differ).
        if let Some(track) = moved.iter().find_map(|l| l.track.clone()) {
            fields.insert("track".into(), track.into());
        }
        let instance: Layer = serde_json::from_value(Value::Object(fields)).map_err(|e| fail(e.to_string()))?;
        let gone: Vec<String> = moved.iter().map(|l| l.id.clone()).collect();
        // The topmost layer's place once the others are gone.
        let at = picked[picked.len() - 1] + 1 - picked.len();
        self.define_component(name, &component)?;
        let instance = self.checked_layer(instance)?;
        self.layers.retain(|l| !gone.contains(&l.id));
        self.layers.insert(at, instance);
        Ok(())
    }
}

impl Scene {
    /// Decompose in place (the inverse of precompose): instance `id`'s layers come back to the top level
    /// at its place in the stack and on its clock, and the instance goes. Its component stays in the
    /// library while other instances use it. Refused when the instance moves, scales, fades, retimes or
    /// has effects of its own (its layers would draw differently without it), or has params.
    pub(crate) fn decompose(&mut self, id: &str) -> Result<(), OpError> {
        let dfail = |why: String| OpError::Component(format!("decompose: {why}"));
        let at = self.layers.iter().position(|l| l.id == id).ok_or_else(|| OpError::UnknownLayer(id.to_owned()))?;
        let inst = self.layers[at].clone();
        let LayerContent::Use { comp, .. } = &inst.content else { return Err(dfail(format!("'{id}' is not a component instance"))) };
        let comp = comp.clone();
        if self.library.components.get(&comp).is_some_and(|c| !c.params.is_empty()) {
            return Err(dfail(format!("'{comp}' has params; edit the instance instead")));
        }
        let plain: Layer = serde_json::from_value(serde_json::json!({ "id": id, "type": crate::component::USE_TYPE, "comp": comp })).map_err(|e| dfail(e.to_string()))?;
        let same = inst.x == plain.x && inst.y == plain.y && inst.scale == plain.scale && inst.rotation == plain.rotation && inst.opacity == plain.opacity;
        if !same || inst.time.is_some() || !inst.effects.is_empty() || inst.matte.is_some() || !inst.anims.is_empty() {
            return Err(dfail(format!("'{id}' is moved, scaled, faded, retimed or has effects of its own: its layers would draw differently on their own")));
        }
        let bound = inst.bound(&self.library).ok_or_else(|| dfail(format!("'{id}' does not draw (unknown or broken component '{comp}')")))?;
        let t0 = inst.start;
        let taken: std::collections::HashSet<String> = self.layers.iter().filter(|l| l.id != id).map(|l| l.id.clone()).collect();
        let mut out = Vec::with_capacity(bound.layers.len());
        let mut names: std::collections::HashMap<String, String> = Default::default();
        for l in &bound.layers {
            let mut name = l.id.clone();
            for n in 2.. {
                if !taken.contains(&name) && !names.values().any(|v| v == &name) {
                    break;
                }
                name = format!("{}_{n}", l.id);
            }
            names.insert(l.id.clone(), name);
        }
        for l in &bound.layers {
            let mut c = l.clone();
            c.id = names[&l.id].clone();
            c.start += t0;
            // Without an end a layer lasted as long as the instance.
            c.end = c.end.map(|e| e + t0).or(inst.end);
            c.parent = c.parent.as_ref().and_then(|p| names.get(p).cloned()).or_else(|| inst.parent.clone());
            if let Some(m) = c.matte.as_mut() {
                if let Some(n) = names.get(&m.layer) {
                    m.layer = n.clone();
                }
            }
            c.group = inst.group.clone();
            c.track = inst.track.clone();
            c.fixed = inst.fixed;
            let mut v = serde_json::to_value(&c).map_err(|e| dfail(e.to_string()))?;
            if t0 != 0.0 {
                formulas(&mut v, &mut |s| {
                    let e = expr::Expr::new(s.clone());
                    if let Some(shifted) = e.check().ok().and_then(|_| e.shifted(-t0)) {
                        *s = shifted;
                    }
                });
            }
            let layer: Layer = serde_json::from_value(v).map_err(|e| dfail(e.to_string()))?;
            out.push(self.checked_layer(layer)?);
        }
        self.layers.splice(at..=at, out);
        let used = self.layers.iter().any(|l| matches!(&l.content, LayerContent::Use { comp: c, .. } if c == &comp));
        if !used {
            self.library.components.remove(&comp);
        }
        Ok(())
    }
}

#[cfg(test)]
mod compound_tests {
    use crate::{Op, Scene};

    fn ops(j: &str) -> Vec<Op> {
        Op::parse_list(j).unwrap()
    }

    /// Clips precomposed into a compound clip draw the same frames and play the same sound; decomposing
    /// puts them back as they were.
    #[test]
    fn compound_clips_play_and_decompose() {
        let mut scene = Scene { duration: 10.0, ..Scene::default() };
        scene
            .apply(&ops(r##"[
                {"op":"set_tracks","tracks":[{"id":"V1","kind":"video","volume":0.5},{"id":"A1","kind":"audio"}]},
                {"op":"add_layer","layer":{"id":"a","type":"video","src":"/media/a.mp4","start":2,"end":5,"in":1,"x":540,"y":960,"w":1080,"h":1920,"volume":1,"track":"V1"}},
                {"op":"add_layer","layer":{"id":"b","type":"video","src":"/media/b.mp4","start":5,"end":8,"x":540,"y":960,"w":1080,"h":1920,"volume":0.8,"track":"V1"}}
            ]"##))
            .unwrap();
        let before_frames = |s: &Scene, t: f32| s.video_frames(t).into_iter().map(|n| (n.src, (n.time * 100.0).round())).collect::<Vec<_>>();
        let sound = |s: &Scene, t: f32| s.video_clips(t).into_iter().map(|c| (c.src, (c.time * 100.0).round(), (c.volume * 100.0).round())).collect::<Vec<_>>();
        let (f3, f6, s3, s6) = (before_frames(&scene, 3.0), before_frames(&scene, 6.0), sound(&scene, 3.0), sound(&scene, 6.0));
        assert_eq!(f3, vec![("/media/a.mp4".to_owned(), 200.0)]);
        scene.apply(&ops(r#"[{"op":"precompose","ids":["a","b"],"component":"compound_1","id":"cmp1"}]"#)).unwrap();
        let inst = scene.layers.iter().find(|l| l.id == "cmp1").unwrap();
        assert_eq!((inst.start, inst.end, inst.track.as_deref()), (2.0, Some(8.0), Some("V1")));
        assert_eq!(before_frames(&scene, 3.0), f3, "same frame inside the compound clip");
        assert_eq!(before_frames(&scene, 6.0), f6);
        assert_eq!(sound(&scene, 3.0), s3, "same sound, through the instance's track");
        assert_eq!(sound(&scene, 6.0), s6);
        assert_eq!(scene.video_clips(6.0)[0].id, "cmp1/b");
        assert_eq!(scene.video_sources(), vec!["/media/a.mp4".to_owned(), "/media/b.mp4".to_owned()]);
        scene.apply(&ops(r#"[{"op":"decompose","id":"cmp1"}]"#)).unwrap();
        let a = scene.layers.iter().find(|l| l.id == "a").unwrap();
        assert_eq!((a.start, a.end, a.track.as_deref()), (2.0, Some(5.0), Some("V1")));
        assert!(scene.layers.iter().all(|l| l.id != "cmp1"));
        assert!(!scene.library.components.contains_key("compound_1"), "an unused component goes");
        assert_eq!(sound(&scene, 6.0), s6);
        // A moved instance would draw differently without it.
        scene.apply(&ops(r#"[{"op":"precompose","ids":["a","b"],"component":"c2","id":"cmp2"},{"op":"patch","id":"cmp2","fields":{"x":100}}]"#)).unwrap();
        assert!(scene.apply(&ops(r#"[{"op":"decompose","id":"cmp2"}]"#)).is_err());
    }
}
