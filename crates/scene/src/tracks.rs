//! Editing tracks, as in an NLE: V1, V2… (pictures) and A1, A2… (sound) with a name and switches.
//! A layer joins one with its `track` field. Hidden tracks are not drawn (nor heard); muted tracks
//! are not heard; while any track (or mix channel) is solo only solo ones are heard. `locked` is for
//! the editor. The mixer's `volume` (linear, 0..2) and `pan` (−1 left .. 1 right) scale and place the
//! sound of every clip on the track.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
}

/// `{"id":"V2","kind":"video","name":"B-roll","hidden":false,"muted":false,"solo":false,"locked":false}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub muted: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub solo: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    /// Fader: linear gain of the track's sound, 0..2 (1 = as the clips are).
    #[serde(default = "unit", skip_serializing_if = "is_unit")]
    pub volume: f32,
    /// −1 (left) .. 1 (right), added to each clip's own pan.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub pan: f32,
}

/// Highest fader gain (+6 dB) a track or a mix channel takes.
pub const MAX_FADER: f32 = 2.0;

fn unit() -> f32 {
    1.0
}
fn is_unit(v: &f32) -> bool {
    *v == 1.0
}
fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

/// The longest track list `set_tracks` takes.
pub const MAX_TRACKS: usize = 32;

pub fn check(tracks: &[Track]) -> Result<(), &'static str> {
    if tracks.len() > MAX_TRACKS {
        return Err("at most 32 tracks");
    }
    for (i, t) in tracks.iter().enumerate() {
        if t.id.is_empty() || t.id.len() > 24 {
            return Err("every track needs an id of 1-24 characters (V1, A2…)");
        }
        if tracks[..i].iter().any(|o| o.id == t.id) {
            return Err("track ids must be unique");
        }
        if !(t.volume.is_finite() && (0.0..=MAX_FADER).contains(&t.volume)) {
            return Err("a track's volume is a linear gain, 0..2");
        }
        if !(t.pan.is_finite() && (-1.0..=1.0).contains(&t.pan)) {
            return Err("a track's pan is -1 (left) .. 1 (right)");
        }
    }
    Ok(())
}

impl crate::Scene {
    fn track_of(&self, l: &crate::Layer) -> Option<&Track> {
        let id = l.track.as_deref()?;
        self.tracks.iter().find(|t| t.id == id)
    }

    /// The layer's track is hidden, or the layer belongs to a hook variant not shown: neither drawn nor heard.
    pub fn track_hidden(&self, l: &crate::Layer) -> bool {
        self.track_of(l).is_some_and(|t| t.hidden) || self.variant_off(l)
    }

    /// Every hook variant the layers name, sorted ("A", "B"…).
    pub fn variants(&self) -> Vec<String> {
        let mut v: Vec<String> = self.layers.iter().filter_map(|l| l.variant.clone()).collect();
        v.sort();
        v.dedup();
        v
    }

    /// The hook variant that plays: the scene's `variant` when a layer has it, else the first.
    pub fn active_variant(&self) -> Option<String> {
        let all = self.variants();
        self.variant.clone().filter(|v| all.contains(v)).or_else(|| all.into_iter().next())
    }

    /// The layer belongs to another hook variant than the one playing.
    pub fn variant_off(&self, l: &crate::Layer) -> bool {
        l.variant.as_ref().is_some_and(|v| self.active_variant().as_ref() != Some(v))
    }

    /// How much of the layer's own sound its track lets through: its fader, or 0 when muted, hidden
    /// or left out by a solo.
    pub fn track_gain(&self, l: &crate::Layer) -> f32 {
        let track = self.track_of(l);
        if track.is_some_and(|t| t.hidden || t.muted) || self.variant_off(l) {
            return 0.0;
        }
        if self.soloing() && !track.is_some_and(|t| t.solo) {
            return 0.0;
        }
        track.map_or(1.0, |t| t.volume)
    }

    /// The pan the layer's track adds (0 without a track).
    pub fn track_pan(&self, l: &crate::Layer) -> f32 {
        self.track_of(l).map_or(0.0, |t| t.pan)
    }

    /// Some track or mix channel is solo: everything else is silent.
    pub fn soloing(&self) -> bool {
        self.tracks.iter().any(|t| t.solo) || self.mix.as_ref().is_some_and(|m| m.channels.values().any(|c| c.solo))
    }
}

#[cfg(test)]
mod tests {
    use crate::{Op, Scene};

    #[test]
    fn tracks_hide_mute_and_solo() {
        let mut scene = Scene { duration: 4.0, ..Scene::default() };
        let ops = |j: &str| Op::parse_list(j).unwrap();
        scene
            .apply(&ops(r##"[
                {"op":"set_tracks","tracks":[{"id":"V1","kind":"video"},{"id":"V2","kind":"video","hidden":true},{"id":"A1","kind":"audio"},{"id":"A2","kind":"audio","muted":true}]},
                {"op":"add_layer","layer":{"id":"pic","type":"shape","shape":"rect","x":50,"y":50,"w":20,"h":20,"fill":"#ff0000","track":"V2"}},
                {"op":"add_layer","layer":{"id":"base","type":"shape","shape":"rect","x":50,"y":50,"w":20,"h":20,"fill":"#00ff00","track":"V1"}},
                {"op":"add_layer","layer":{"id":"vo","type":"audio","src":"/media/v.mp3","volume":1,"track":"A1"}},
                {"op":"add_layer","layer":{"id":"bed","type":"audio","src":"/media/b.mp3","volume":1,"track":"A2"}}
            ]"##))
            .unwrap();
        // Hidden V2 draws nothing; V1 does.
        assert_eq!(scene.frame(1.0).len(), 1);
        let vol = |s: &Scene, id: &str| s.video_clips(1.0).into_iter().find(|c| c.id == id).map(|c| c.volume);
        assert_eq!(vol(&scene, "vo"), Some(1.0));
        assert_eq!(vol(&scene, "bed"), Some(0.0), "muted track");
        // Solo A2 (unmuted): only it is heard.
        scene.apply(&ops(r#"[{"op":"set_tracks","tracks":[{"id":"V1","kind":"video"},{"id":"A1","kind":"audio"},{"id":"A2","kind":"audio","solo":true}]}]"#)).unwrap();
        assert_eq!((vol(&scene, "vo"), vol(&scene, "bed")), (Some(0.0), Some(1.0)));
        // V2 is gone from the list: its layer draws again (an unknown track hides nothing).
        assert_eq!(scene.frame(1.0).len(), 2);
        assert!(scene.apply(&ops(r#"[{"op":"set_tracks","tracks":[{"id":"V1","kind":"video"},{"id":"V1","kind":"audio"}]}]"#)).is_err());
    }

    #[test]
    fn faders_pans_and_channel_solo() {
        let mut scene = Scene { duration: 4.0, ..Scene::default() };
        let ops = |j: &str| Op::parse_list(j).unwrap();
        scene
            .apply(&ops(r##"[
                {"op":"set_tracks","tracks":[{"id":"A1","kind":"audio","volume":0.5,"pan":-0.5},{"id":"A2","kind":"audio"}]},
                {"op":"add_layer","layer":{"id":"vo","type":"audio","src":"/media/v.mp3","volume":0.8,"pan":-0.75,"track":"A1"}},
                {"op":"add_layer","layer":{"id":"bed","type":"audio","src":"/media/b.mp3","volume":1,"pan":0.25,"track":"A2"}}
            ]"##))
            .unwrap();
        let clip = |s: &Scene, id: &str| s.video_clips(1.0).into_iter().find(|c| c.id == id).map(|c| (c.volume, c.pan)).unwrap();
        assert_eq!(clip(&scene, "vo"), (0.4, -1.0), "fader × clip volume; pans add, clamped");
        assert_eq!(clip(&scene, "bed"), (1.0, 0.25));
        // A solo mix channel (the voice-over) silences every track that is not solo.
        scene.apply(&ops(r#"[{"op":"set_mix","mix":{"master_db":0,"channels":{"voice":{"solo":true}}}}]"#)).unwrap();
        assert_eq!((clip(&scene, "vo").0, clip(&scene, "bed").0), (0.0, 0.0));
        assert!(scene.apply(&ops(r#"[{"op":"set_tracks","tracks":[{"id":"A1","kind":"audio","volume":3}]}]"#)).is_err());
        assert!(scene.apply(&ops(r#"[{"op":"set_mix","mix":{"master_db":0,"channels":{"music":{"pan":2}}}}]"#)).is_err());
    }
}
