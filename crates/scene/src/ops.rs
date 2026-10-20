use crate::{Camera3D, StageProp, Stage, Action, Hair, Outfit, Scenario, RenderStyle, AudioTrack, Captions, LayerContent, Typography, AnimRef, AnimTemplate, Animated, CaptionStyle, ColorRef, CustomPalette, Layer, Library, Scene, StylePreset, TransitionRef};
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
    /// Put layers in a group (or take them out with `null`): `{"op":"set_group","ids":["panel","chart"],"group":"dashboard"}`.
    SetGroup { ids: Vec<String>, group: Option<String> },
    /// Remove every layer of a group (to rebuild it).
    RemoveGroup { group: String },
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
    /// Change the words of a text layer.
    SetText { id: String, text: String },
    /// Font from the typography brick (the editor sends it).
    SetTypography { typography: Option<Typography> },
    /// Replace the whole captions track (`null` removes captions).
    SetCaptions { captions: Option<Captions> },
    /// Replace the 3D stage (`null` = none).
    SetStage { stage: Option<Stage> },
    /// Add a 3D prop, or replace the one with the same id.
    PutProp { prop: StageProp },
    RemoveProp { id: String },
    SetCamera { camera: Camera3D },
    /// Light the 3D stage: key/ambient/point lights and floor shadows (`null` = the default soft
    /// camera light, no shadows). Object layers take `lights` in the layer instead.
    SetLights { lights: Option<crate::Lights> },
    /// Direct the camera with a shot list (replaces previous shots).
    SetShots { shots: Vec<crate::Shot> },
    /// Add or replace one prefab in the scene library (a prefab the agent just made).
    DefinePrefab { name: String, node: crate::Node3D },
    /// Build a 3D set from a scenario brick (clinic_room, office, empty_studio, iso_city),
    /// keeping any characters already on stage.
    SetStagePreset { kind: crate::ScenarioKind },
    /// Backdrop from the scenario brick (`null` = none).
    SetScenario { scenario: Option<Scenario> },
    /// Change a character's look or what it is doing; omitted fields stay.
    SetCharacter {
        id: String,
        #[serde(default)]
        outfit: Option<Outfit>,
        #[serde(default)]
        action: Option<Action>,
        #[serde(default)]
        hair: Option<Hair>,
        #[serde(default)]
        hair_color: Option<ColorRef>,
        #[serde(default)]
        facing: Option<f32>,
    },
    /// Finish of the whole frame from the render style brick (`null` = flat).
    SetRenderStyle { render_style: Option<RenderStyle> },
    /// Place/trim the project's audio on the timeline (`null` = not used).
    SetAudio { audio: Option<AudioTrack> },
    /// Place (or move, same id) a sound effect: `{"op":"put_sfx","cue":{"id":"sfx1","sound":"pop","src":"/media/…","at":1.2,"gain":0.7}}`.
    PutSfx { cue: crate::SfxCue },
    RemoveSfx { id: String },
    ClearSfx,
    /// Start a video from scratch: every layer, sound cue and transition goes (palette, font,
    /// voice and captions stay).
    ClearLayers,
    /// Mark caption words (by index) as key words, or unmark them.
    SetEmphasis { words: Vec<usize>, emphasis: bool },
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
    /// Depth in the camera world.
    Z,
    RotateX,
    RotateY,
    Soft,
    Backdrop,
    /// Layer clock (time remap).
    Time,
    /// Lens (px) of a tilted plane without a camera layer.
    Perspective,
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
            Op::SetGroup { ids, group } => {
                for id in ids {
                    self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?.group = group.clone();
                }
            }
            Op::RemoveGroup { group } => self.layers.retain(|l| l.group.as_deref() != Some(group.as_str())),
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
                    Prop::Z => &mut l.z,
                    Prop::RotateX => &mut l.rotate_x,
                    Prop::RotateY => &mut l.rotate_y,
                    Prop::Soft => &mut l.soft,
                    Prop::Backdrop => &mut l.backdrop,
                    Prop::Time => l.time.get_or_insert_with(Default::default),
                    Prop::Perspective => l.perspective.get_or_insert_with(Default::default),
                };
                if let Animated::Keys(keys) = value {
                    if keys.windows(2).any(|w| w[1].t < w[0].t) {
                        return Err(OpError::Invalid("keyframes must be sorted by t"));
                    }
                }
                *slot = value.clone();
            }
            Op::SetFill { id, fill } => {
                self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?.fill = (*fill).into();
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
            Op::SetLibrary { library } => {
                // Prefabs defined live (define_prefab: the agent just saved them) are newer than
                // the editor's copy, so they win; the editor only adds the ones we don't have.
                // Same for animations the agent defined itself: the editor only adds what is missing.
                for (name, node) in &library.prefabs {
                    self.library.prefabs.entry(name.clone()).or_insert_with(|| node.clone());
                }
                for (k, v) in &library.animations {
                    self.library.animations.entry(k.clone()).or_insert_with(|| v.clone());
                }
                for (k, v) in &library.transitions {
                    self.library.transitions.entry(k.clone()).or_insert_with(|| v.clone());
                }
                for (k, v) in &library.anchors {
                    self.library.anchors.entry(k.clone()).or_insert(*v);
                }
            }
            Op::SetText { id, text } => {
                let l = self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?;
                match &mut l.content {
                    LayerContent::Text { text: t, .. } => *t = text.clone(),
                    _ => return Err(OpError::Invalid("set_text needs a text layer")),
                }
            }
            Op::SetTypography { typography } => self.typography = typography.clone(),
            Op::SetScenario { scenario } => self.scenario = *scenario,
            Op::SetStage { stage } => self.stage = stage.clone(),
            Op::PutProp { prop } => {
                let stage = self.stage.get_or_insert_with(Stage::default);
                match stage.props.iter_mut().find(|p| p.id == prop.id) {
                    Some(existing) => *existing = prop.clone(),
                    None => stage.props.push(prop.clone()),
                }
            }
            Op::RemoveProp { id } => {
                let stage = self.stage.as_mut().ok_or(OpError::Invalid("there is no 3D stage"))?;
                let before = stage.props.len();
                stage.props.retain(|p| &p.id != id);
                if stage.props.len() == before {
                    return Err(OpError::UnknownLayer(id.clone()));
                }
            }
            Op::DefinePrefab { name, node } => {
                self.library.prefabs.insert(name.clone(), node.clone());
            }
            Op::SetStagePreset { kind } => self.stage = Some(crate::merge_preset(*kind, self.stage.as_ref())),
            Op::SetShots { shots } => {
                if shots.iter().any(|s| s.end <= s.start) {
                    return Err(OpError::Invalid("every shot needs end > start"));
                }
                let mut shots = shots.clone();
                shots.sort_by(|a, b| a.start.total_cmp(&b.start));
                self.stage.get_or_insert_with(Stage::default).shots = shots;
            }
            Op::SetCamera { camera } => self.stage.get_or_insert_with(Stage::default).camera = camera.clone(),
            Op::SetLights { lights } => {
                self.stage.as_mut().ok_or(OpError::Invalid("set_lights lights the 3D stage and there is none (object layers take \"lights\" in the layer)"))?.lights = lights.clone();
            }
            Op::SetCharacter { id, outfit, action, hair, hair_color, facing } => {
                let l = self.layer_mut(id).ok_or_else(|| OpError::UnknownLayer(id.clone()))?;
                let LayerContent::Character { spec } = &mut l.content else {
                    return Err(OpError::Invalid("set_character needs a character layer"));
                };
                if let Some(v) = outfit {
                    spec.outfit = *v;
                }
                if let Some(v) = action {
                    spec.action = *v;
                }
                if let Some(v) = hair {
                    spec.hair = *v;
                }
                if let Some(v) = hair_color {
                    spec.hair_color = *v;
                }
                if let Some(v) = facing {
                    spec.facing = *v;
                }
            }
            Op::SetRenderStyle { render_style } => {
                if render_style.is_some_and(|r| !(0.0..=3.0).contains(&r.amount)) {
                    return Err(OpError::Invalid("render style amount must be between 0 and 3"));
                }
                self.render_style = *render_style;
            }
            Op::PutSfx { cue } => {
                if !(0.0..=4.0).contains(&cue.gain) || cue.at < 0.0 {
                    return Err(OpError::Invalid("sfx needs at >= 0 and gain in 0..4"));
                }
                self.sfx.retain(|c| c.id != cue.id);
                self.sfx.push(cue.clone());
                self.sfx.sort_by(|a, b| a.at.total_cmp(&b.at));
            }
            Op::RemoveSfx { id } => self.sfx.retain(|c| &c.id != id),
            Op::ClearSfx => self.sfx.clear(),
            Op::ClearLayers => {
                self.layers.clear();
                self.sfx.clear();
                self.transitions.clear();
            }
            Op::SetAudio { audio } => {
                if let Some(a) = audio {
                    if a.start < 0.0 || a.trim_in < 0.0 || a.trim_out.is_some_and(|o| o <= a.trim_in) {
                        return Err(OpError::Invalid("audio needs start >= 0 and trim_in < trim_out"));
                    }
                }
                self.audio = *audio;
            }
            Op::SetCaptions { captions } => {
                if let Some(c) = captions {
                    if c.words.windows(2).any(|w| w[1].start < w[0].start) || c.words.iter().any(|w| w.end < w.start) {
                        return Err(OpError::Invalid("caption words must be in time order with end >= start"));
                    }
                }
                self.captions = captions.clone();
            }
            Op::SetEmphasis { words, emphasis } => {
                let c = self.captions.as_mut().ok_or(OpError::Invalid("there are no captions yet"))?;
                if words.iter().any(|&i| i >= c.words.len()) {
                    return Err(OpError::Invalid("caption word index out of range"));
                }
                for &i in words {
                    c.words[i].emphasis = *emphasis;
                }
            }
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
        if self.library.anchor(anchor).is_some() {
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
        s.frame(t).into_iter().find_map(|i| match i {
            DrawItem::Shape(d) => Some(d),
            _ => None,
        })
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
    fn pick_finds_the_top_layer_under_the_pointer() {
        let s = scene();
        assert_eq!(s.pick(2.0, 550.0, 480.0).as_deref(), Some("t"));
        assert_eq!(s.pick(2.0, 10.0, 10.0), None);
        assert_eq!(s.pick(0.1, 550.0, 480.0).as_deref(), Some("t"), "selectable even before its entrance animation");
    }

    #[test]
    fn characters_change_hair_without_touching_the_rest() {
        let mut s = scene();
        let layer: Layer = serde_json::from_str(
            r#"{"id":"doc","type":"character","character":"stickman_outfit","outfit":"doctor","action":"wave","x":540,"y":1200,"w":300,"h":600}"#,
        )
        .unwrap();
        s.apply(&[Op::AddLayer { layer }]).unwrap();
        let op: Op = serde_json::from_str(r#"{"op":"set_character","id":"doc","hair":"short","hair_color":[1,1,1,1]}"#).unwrap();
        s.apply(&[op]).unwrap();
        let json = s.layer_json("doc").unwrap();
        assert!(json.contains(r#""hair":"short""#) && json.contains(r#""action":"wave""#), "{json}");
        assert!(matches!(&s.frame(1.0).last(), Some(DrawItem::Group(g)) if g.len() > 10));
        assert_eq!(s.pick(1.0, 540.0, 1100.0).as_deref(), Some("doc"));
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
