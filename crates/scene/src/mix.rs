//! The mix bus every sound goes through (voice, music, effects, clips): its master level, which
//! loudness normalization sets (`set_mix`), and the mixer channels of the sounds that are not on a
//! track (the voice-over, the music, the effects). The preview and both exporters apply it the same way.

use serde::{Deserialize, Serialize};

/// Range of the master level, dB.
pub const MASTER_DB: (f32, f32) = (-60.0, 24.0);

/// `{"master_db":3.5,"target_lufs":-14}`: gain on the whole mix, and the loudness it was set for.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Mix {
    /// Master gain in dB (0 = as mixed).
    #[serde(default)]
    pub master_db: f32,
    /// Integrated loudness (LUFS) the master was normalized to; only shown, the gain is what plays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_lufs: Option<f32>,
    /// Mixer channels: `voice`, `music`, `effects` (clips are mixed on their tracks).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub channels: std::collections::BTreeMap<MixChannel, Channel>,
}

/// The sounds a mix channel carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MixChannel {
    Voice,
    Music,
    Effects,
}

/// A mixer strip: fader (linear 0..2), pan (−1 left .. 1 right), mute and solo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Channel {
    #[serde(default = "unit", skip_serializing_if = "is_unit")]
    pub volume: f32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub pan: f32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub muted: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub solo: bool,
}

fn unit() -> f32 {
    1.0
}
fn is_unit(v: &f32) -> bool {
    *v == 1.0
}
fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

impl Mix {
    pub fn check(&self) -> Result<(), &'static str> {
        if !(self.master_db.is_finite() && (MASTER_DB.0..=MASTER_DB.1).contains(&self.master_db)) {
            return Err("master_db is the master gain in dB, -60..24");
        }
        if self.target_lufs.is_some_and(|t| !(t.is_finite() && (-60.0..=0.0).contains(&t))) {
            return Err("target_lufs is a loudness in LUFS, -60..0");
        }
        for c in self.channels.values() {
            if !(c.volume.is_finite() && (0.0..=crate::tracks::MAX_FADER).contains(&c.volume)) {
                return Err("a mix channel's volume is a linear gain, 0..2");
            }
            if !(c.pan.is_finite() && (-1.0..=1.0).contains(&c.pan)) {
                return Err("a mix channel's pan is -1 (left) .. 1 (right)");
            }
        }
        Ok(())
    }

    /// Linear master gain.
    pub fn gain(&self) -> f32 {
        10f32.powf(self.master_db / 20.0)
    }
}

#[cfg(test)]
mod tests {
    use crate::{Op, Scene};

    fn op(json: &str) -> Vec<Op> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn set_mix_keeps_the_master_level() {
        let mut scene = Scene::default();
        scene.apply(&op(r#"[{"op":"set_mix","mix":{"master_db":4.5,"target_lufs":-14}}]"#)).unwrap();
        let mix = scene.mix.clone().unwrap();
        assert_eq!(mix.master_db, 4.5);
        assert!((mix.gain() - 1.6788).abs() < 1e-3);
        let json = serde_json::to_value(&scene).unwrap();
        assert_eq!(json["mix"]["target_lufs"], -14.0);
        assert!(scene.apply(&op(r#"[{"op":"set_mix","mix":{"master_db":40}}]"#)).is_err());
        scene.apply(&op(r#"[{"op":"set_mix","mix":null}]"#)).unwrap();
        assert!(scene.mix.is_none());
    }
}
