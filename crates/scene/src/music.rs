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
        let ok = MusicTrack { src: "/media/a.mp3".into(), start: 0.0, trim_in: 2.0, trim_out: Some(30.0), gain: 0.3, duck: 0.4 };
        assert!(MusicTrack { gain: 3.0, ..ok.clone() }.check().is_err());
        assert!(MusicTrack { duck: 1.5, ..ok.clone() }.check().is_err());
        assert!(MusicTrack { trim_out: Some(1.0), ..ok.clone() }.check().is_err());
        assert!(MusicTrack { src: " ".into(), ..ok }.check().is_err());
    }
}
