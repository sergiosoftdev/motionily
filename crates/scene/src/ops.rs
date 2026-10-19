use crate::{AnimRef, AnimTemplate, Animated, CaptionStyle, ColorRef, CustomPalette, Layer, Library, Scene, StylePreset, TransitionRef};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Every change to a scene, from the agent or from the user, is one of these.
/// Ops are small JSON objects, so an agent edits a video by sending a few
/// hundred bytes instead of rewriting the whole scene.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    SetStyle { style: StylePreset },
    /// Colors from a palette brick; `null` goes back to the style preset colors.
    SetPalette { palette: Option<CustomPalette> },
    SetCaptionStyle { caption_style: CaptionStyle },
    SetDuration { duration: f32 },
    SetSize { width: u32, height: u32 },
    AddLayer { layer: Layer },
    RemoveLayer { id: String },
    /// Replace one animatable property (a number or a keyframe list).
    SetProp { id: String, prop: Prop, value: Animated },
    SetFill { id: String, fill: ColorRef },
    SetTiming { id: String, start: f32, end: Option<f32> },
    /// Move a layer in the stack. 0 is the back.
    Reorder { id: String, index: usize },
    /// Play an animation brick on a layer: `{"op":"add_anim","id":"title","anim":{"use":"animation/pop_in","at":0.2}}`.
    AddAnim { id: String, anim: AnimRef },
    ClearAnims { id: String },
    /// Pin a layer to a composition anchor (`null` to go back to absolute x/y).
    SetAnchor { id: String, anchor: Option<String> },
    /// Cut to the next scene at `at` with a transition brick.
    AddTransition { transition: TransitionRef },
    ClearTransitions,
    /// Replace the brick library (the editor sends this from the project's bricks).
    SetLibrary { library: Library },
    /// Add or replace one animation template (e.g. a brick the agent just created).
    DefineAnim { key: String, template: AnimTemplate },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Prop {
    X,
    Y,
    W,
    H,
    Scale,
    Rotation,
    Opacity,
    Radius,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OpError {
    UnknownLayer(String),
    DuplicateLayer(String),
    Invalid(&'static str),
    /// A brick key the scene library doesn't have; carries what is available.
    UnknownBrick { key: String, available: Vec<String> },
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpError::UnknownLayer(id) => write!(f, "unknown layer id '{id}'"),
            OpError::DuplicateLayer(id) => write!(f, "layer id '{id}' already exists"),
            OpError::Invalid(why) => f.write_str(why),
            OpError::UnknownBrick { key, available } => {
                write!(f, "unknown brick '{key}'; available: {}", available.join(", "))
            }
        }
    }
}

impl std::error::Error for OpError {}

impl Scene {
    /// Apply ops atomically: either all succeed or the scene is left untouched.
    pub fn apply(&mut self, ops: &[Op]) -> Result<(), (usize, OpError)> {
        let mut next = self.clone();
        for (i, op) in ops.iter().enumerate() {
            next.apply_one(op).map_err(|e| (i, e))?;
        }
        *self = next;
        Ok(())
    }

    fn apply_one(&mut self, op: &Op) -> Result<(), OpError> {
        match op {
            Op::SetStyle { style } => self.style = *style,
            Op::SetPalette { palette } => self.palette = *palette,
            Op::SetCaptionStyle { caption_style } => self.caption_style = *caption_style,
            Op::SetDuration { duration } => {
                if *duration <= 0.0 {
                    return Err(OpError::Invalid("duration must be > 0"));
                }
                self.duration = *duration;
            }
            Op::SetSize { width, height } => {
                if *width == 0 || *height == 0 {
                    return Err(OpError::Invalid("size must be > 0"));
                }
                self.width = *width;
                self.height = *height;
            }
            Op::AddLayer { layer } => {
                if self.layer(&layer.id).is_some() {
                    return Err(OpError::DuplicateLayer(layer.id.clone()));
                }
                for a in &layer.anims {
                    self.check_anim(&a.key)?;
                }
                if let Some(anchor) = &layer.anchor {
                    self.check_anchor(anchor)?;
                }
                self.layers.push(layer.clone());
            }
            Op::RemoveLayer { id } => {
                let before = self.layers.len();
                self.layers.retain(|l| &l.id != id);
                if self.layers.len() == before {
                    return Err(OpError::UnknownLayer(id.clone()));
                }
            }
            Op::SetProp { id, prop, value } => {
                let l = self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?;
                let slot = match prop {
                    Prop::X => &mut l.x,
                    Prop::Y => &mut l.y,
                    Prop::W => &mut l.w,
                    Prop::H => &mut l.h,
                    Prop::Scale => &mut l.scale,
                    Prop::Rotation => &mut l.rotation,
                    Prop::Opacity => &mut l.opacity,
                    Prop::Radius => &mut l.radius,
                };
                if let Animated::Keys(keys) = value {
                    if keys.windows(2).any(|w| w[1].t < w[0].t) {
                        return Err(OpError::Invalid("keyframes must be sorted by t"));
                    }
                }
                *slot = value.clone();
            }
            Op::SetFill { id, fill } => {
                self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?.fill = *fill;
            }
            Op::SetTiming { id, start, end } => {
                if end.is_some_and(|e| e <= *start) {
                    return Err(OpError::Invalid("end must be after start"));
                }
                let l = self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?;
                l.start = *start;
                l.end = *end;
            }
            Op::Reorder { id, index } => {
                let from = self
                    .layers
                    .iter()
                    .position(|l| &l.id == id)
                    .ok_or_else(|| OpError::UnknownLayer(id.clone()))?;
                let layer = self.layers.remove(from);
                let to = (*index).min(self.layers.len());
                self.layers.insert(to, layer);
            }
            Op::AddAnim { id, anim } => {
                self.check_anim(&anim.key)?;
                self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?.anims.push(anim.clone());
            }
            Op::ClearAnims { id } => {
                self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?.anims.clear();
            }
            Op::SetAnchor { id, anchor } => {
                if let Some(a) = anchor {
                    self.check_anchor(a)?;
                }
                self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?.anchor = anchor.clone();
            }
            Op::AddTransition { transition } => {
                if !self.library.transitions.contains_key(&transition.key) {
                    return Err(OpError::UnknownBrick {
                        key: transition.key.clone(),
                        available: self.library.transitions.keys().cloned().collect(),
                    });
                }
                if transition.at <= 0.0 || transition.at >= self.duration {
                    return Err(OpError::Invalid("transition must happen inside the video"));
                }
                self.transitions.push(transition.clone());
                self.transitions.sort_by(|a, b| a.at.total_cmp(&b.at));
            }
            Op::ClearTransitions => self.transitions.clear(),
            Op::SetLibrary { library } => self.library = library.clone(),
            Op::DefineAnim { key, template } => {
                self.library.animations.insert(key.clone(), template.clone());
            }
        }
        Ok(())
    }

    fn check_anim(&self, key: &str) -> Result<(), OpError> {
        if self.library.animations.contains_key(key) {
            return Ok(());
        }
        Err(OpError::UnknownBrick { key: key.to_owned(), available: self.library.animations.keys().cloned().collect() })
    }

    fn check_anchor(&self, anchor: &str) -> Result<(), OpError> {
        if self.library.anchors.contains_key(anchor) {
            return Ok(());
        }
        Err(OpError::UnknownBrick { key: anchor.to_owned(), available: self.library.anchors.keys().cloned().collect() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_parse_from_compact_json() {
        let ops: Vec<Op> = serde_json::from_str(
            r#"[{"op":"set_style","style":"neon"},
                {"op":"set_prop","id":"a","prop":"opacity","value":[{"t":0,"v":0},{"t":0.3,"v":1}]}]"#,
        )
        .unwrap();
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn failed_batch_leaves_scene_untouched() {
        let mut scene = Scene::default();
        let ops = vec![
            Op::SetStyle { style: StylePreset::Neon },
            Op::RemoveLayer { id: "missing".into() },
        ];
        let err = scene.apply(&ops).unwrap_err();
        assert_eq!(err.0, 1);
        assert_eq!(scene.style, StylePreset::Clean);
    }
}

#[cfg(test)]
mod brick_tests {
    use super::*;
    use crate::DrawItem;

    fn scene() -> Scene {
        let mut s = Scene::default();
        let lib: Library = serde_json::from_str(
            r#"{"animations":{"animation/pop_in":{"keys":{"scale":[[0,0,"back"],[0.5,1]]}},
                              "animation/fade_up":{"keys":{"opacity":[[0,0],[0.4,1]],"dy":[[0,40],[0.4,0]]}}},
                "anchors":{"hero":[0.5,0.25]}}"#,
        )
        .unwrap();
        s.apply(&[Op::SetLibrary { library: lib }]).unwrap();
        let layer: Layer = serde_json::from_str(
            r#"{"id":"t","type":"shape","shape":"rect","anchor":"hero","x":10,"w":100,"h":50,
                "anims":[{"use":"animation/fade_up","at":0.5}]}"#,
        )
        .unwrap();
        s.apply(&[Op::AddLayer { layer }]).unwrap();
        s
    }

    fn shape(s: &Scene, t: f32) -> Option<crate::DrawShape> {
        s.frame(t).into_iter().next().map(|DrawItem::Shape(d)| d)
    }

    #[test]
    fn anchors_place_layers_relative_to_the_composition() {
        let d = shape(&scene(), 2.0).unwrap();
        assert_eq!(d.center, [540.0 + 10.0, 1920.0 * 0.25]);
    }

    #[test]
    fn anim_refs_hide_before_start_and_settle_after() {
        let s = scene();
        assert!(shape(&s, 0.2).is_none(), "fade_up starts at opacity 0");
        let mid = shape(&s, 0.7).unwrap();
        assert!(mid.center[1] > 480.0, "still offset downwards");
        assert_eq!(shape(&s, 2.0).unwrap().color.0[3], 1.0);
    }

    #[test]
    fn unknown_bricks_are_rejected_with_the_available_list() {
        let mut s = scene();
        let err = s
            .apply(&[Op::AddAnim { id: "t".into(), anim: serde_json::from_str(r#"{"use":"animation/nope"}"#).unwrap() }])
            .unwrap_err();
        assert!(err.1.to_string().contains("animation/pop_in"));
    }
}

#[cfg(test)]
mod palette_tests {
    use super::*;

    #[test]
    fn palette_brick_overrides_style_colors() {
        let mut scene = Scene::default();
        let ops: Vec<Op> = serde_json::from_str(
            r##"[{"op":"set_palette","palette":{"background":"#d9c3a0","surface":"#f3e9d8","primary":"#c2553a","accent":"#3f7d6e","text":"#2a211b"}}]"##,
        )
        .unwrap();
        scene.apply(&ops).unwrap();
        assert_eq!(scene.palette().background, crate::Rgba::hex(0xd9c3a0));
        scene.apply(&[Op::SetPalette { palette: None }]).unwrap();
        assert_eq!(scene.palette(), StylePreset::Clean.palette());
        let bad: Result<Vec<Op>, _> = serde_json::from_str(r#"[{"op":"set_palette","palette":{"background":"red"}}]"#);
        assert!(bad.is_err());
    }
}
