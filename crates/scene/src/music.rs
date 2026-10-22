//! Background music: one file under the whole video, quieter while the voice speaks.
//!
//! The scene only keeps the placement and levels; the host plays and mixes the file (preview and
//! export) and lowers it to `gain × duck` around every spoken word of the captions.

use serde::{Deserialize, Serialize};

/// Level of music under a voice-over when nobody set one (of the file's own level).
pub const DEFAULT_MUSIC_GAIN: f32 = 0.25;
/// Level multiplier while someone speaks (1 = never lowered).
pub const DEFAULT_DUCK: f32 = 0.35;
/// Loudest a track can be set (2 = twice the file's level).
pub const MAX_MUSIC_GAIN: f32 = 2.0;

fn default_gain() -> f32 {
    DEFAULT_MUSIC_GAIN
}

fn default_duck() -> f32 {
    DEFAULT_DUCK
}

/// `{"src":"/media/….mp3","start":0,"trim_in":12,"trim_out":null,"gain":0.25,"duck":0.35}`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MusicTrack {
    /// Media path of the file.
    pub src: String,
    /// Video time (s) where the music starts.
    #[serde(default)]
    pub start: f32,
    /// Seconds cut from the beginning of the file.
    #[serde(default)]
    pub trim_in: f32,
    /// File time (s) where it stops; `None` = end of file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim_out: Option<f32>,
    /// Level, 0..2 (1 = the file as it is).
    #[serde(default = "default_gain")]
    pub gain: f32,
    /// Level multiplier while the voice speaks (captions words), 0..1.
    #[serde(default = "default_duck")]
    pub duck: f32,
    /// Volume keyframes on top of `gain` (fades, dips): `v` 0..1 at `t` seconds from the music's
    /// `start`, linear between keys, the first and last level held before and after them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub envelope: Vec<LevelKey>,
}

/// One point of the music's volume envelope.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LevelKey {
    pub t: f32,
    pub v: f32,
}

impl MusicTrack {
    pub fn check(&self) -> Result<(), &'static str> {
        if self.src.trim().is_empty() {
            return Err("music needs a src");
        }
        if self.start < 0.0 || self.trim_in < 0.0 || self.trim_out.is_some_and(|o| o <= self.trim_in) {
            return Err("music needs start >= 0 and trim_in < trim_out");
        }
        if !(0.0..=MAX_MUSIC_GAIN).contains(&self.gain) {
            return Err("music gain must be in 0..2");
        }
        if !(0.0..=1.0).contains(&self.duck) {
            return Err("music duck must be in 0..1");
        }
        if self.envelope.iter().any(|k| !(0.0..=1.0).contains(&k.v) || !k.t.is_finite()) {
            return Err("music envelope levels must be in 0..1");
        }
        if self.envelope.windows(2).any(|w| w[1].t < w[0].t) {
            return Err("music envelope keys must be in time order");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_sit_under_a_voice() {
        let m: MusicTrack = serde_json::from_str(r#"{"src":"/media/a.mp3"}"#).unwrap();
        assert_eq!((m.start, m.trim_in, m.trim_out, m.gain, m.duck), (0.0, 0.0, None, DEFAULT_MUSIC_GAIN, DEFAULT_DUCK));
        assert!(m.check().is_ok());
    }

    #[test]
    fn rejects_bad_levels_and_trims() {
        let ok = MusicTrack { src: "/media/a.mp3".into(), start: 0.0, trim_in: 2.0, trim_out: Some(30.0), gain: 0.3, duck: 0.4, envelope: vec![] };
        assert!(MusicTrack { gain: 3.0, ..ok.clone() }.check().is_err());
        assert!(MusicTrack { duck: 1.5, ..ok.clone() }.check().is_err());
        assert!(MusicTrack { trim_out: Some(1.0), ..ok.clone() }.check().is_err());
        assert!(MusicTrack { envelope: vec![LevelKey { t: 0.0, v: 1.2 }], ..ok.clone() }.check().is_err());
        assert!(MusicTrack { envelope: vec![LevelKey { t: 2.0, v: 1.0 }, LevelKey { t: 1.0, v: 0.0 }], ..ok.clone() }.check().is_err());
        assert!(MusicTrack { src: " ".into(), ..ok }.check().is_err());
    }

    #[test]
    fn envelope_round_trips_and_stays_out_when_empty() {
        let m: MusicTrack = serde_json::from_str(r#"{"src":"/media/a.mp3","envelope":[{"t":0,"v":0},{"t":2,"v":1}]}"#).unwrap();
        assert!(m.check().is_ok());
        assert_eq!(m.envelope.len(), 2);
        let plain: MusicTrack = serde_json::from_str(r#"{"src":"/media/a.mp3"}"#).unwrap();
        assert!(!serde_json::to_string(&plain).unwrap().contains("envelope"));
    }
}
