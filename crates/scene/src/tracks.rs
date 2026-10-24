//! Editing tracks, as in an NLE: V1, V2… (pictures) and A1, A2… (sound) with a name and switches.
//! A layer joins one with its `track` field. Hidden tracks are not drawn (nor heard); muted tracks
//! are not heard; while any track is solo only solo tracks are heard. `locked` is for the editor.

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
    }
    Ok(())
}

impl crate::Scene {
    fn track_of(&self, l: &crate::Layer) -> Option<&Track> {
        let id = l.track.as_deref()?;
        self.tracks.iter().find(|t| t.id == id)
    }

    /// The layer's track is hidden: neither drawn nor heard.
    pub fn track_hidden(&self, l: &crate::Layer) -> bool {
        self.track_of(l).is_some_and(|t| t.hidden)
    }

    /// How much of the layer's own sound its track lets through (0 or 1): mute, solo and hide.
    pub fn track_gain(&self, l: &crate::Layer) -> f32 {
        let track = self.track_of(l);
        if track.is_some_and(|t| t.hidden || t.muted) {
            return 0.0;
        }
        let soloing = self.tracks.iter().any(|t| t.solo);
        if soloing && !track.is_some_and(|t| t.solo) {
            return 0.0;
        }
        1.0
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
}
