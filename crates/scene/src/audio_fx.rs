//! Audio effects of a sound (a clip, a mix channel or the master), as an NLE's channel inserts, in this
//! order: EQ bands, then a compressor, then a limiter. The preview and both exporters run them the same
//! way (WebAudio biquads, a dynamics compressor, and a lookahead peak limiter).
//!
//! `{"eq":[{"type":"high_pass","freq":80},{"type":"peak","freq":3000,"gain_db":3,"q":1}],
//!   "compressor":{"threshold_db":-20,"ratio":3},"limiter":{"ceiling_db":-1}}`

use serde::{Deserialize, Serialize};

/// Bands an EQ takes.
pub const MAX_BANDS: usize = 5;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AudioFx {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub eq: Vec<EqBand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compressor: Option<Compressor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limiter: Option<Limiter>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BandType {
    /// Cuts below `freq` (12 dB/octave; `q` 0.707 = flat).
    HighPass,
    /// Cuts above `freq`.
    LowPass,
    /// Lifts or lowers everything below `freq` by `gain_db`.
    LowShelf,
    /// Lifts or lowers everything above `freq` by `gain_db`.
    HighShelf,
    /// A bell around `freq`, `q` wide (1 ≈ 1.4 octaves; higher = narrower).
    Peak,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EqBand {
    #[serde(rename = "type")]
    pub kind: BandType,
    /// Hz, 20..20000.
    pub freq: f32,
    /// dB, −24..24 (shelves and peaks).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub gain_db: f32,
    /// 0.1..18; absent: 0.707 for passes, 1 for peaks (shelves ignore it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q: Option<f32>,
}

/// Downward compression above `threshold_db`, `ratio`:1, with a soft `knee_db`, `attack` and `release`
/// (seconds) and `makeup_db` added after.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Compressor {
    /// dBFS, −60..0.
    pub threshold_db: f32,
    /// 1..20.
    pub ratio: f32,
    #[serde(default = "attack")]
    pub attack: f32,
    #[serde(default = "release")]
    pub release: f32,
    /// 0..40.
    #[serde(default = "knee")]
    pub knee_db: f32,
    /// 0..24.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub makeup_db: f32,
}

/// Holds the sound's sample peak under `ceiling_db` (5 ms lookahead, 80 ms release).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Limiter {
    /// dBFS, −12..0.
    #[serde(default = "ceiling")]
    pub ceiling_db: f32,
}

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}
fn attack() -> f32 {
    0.01
}
fn release() -> f32 {
    0.25
}
fn knee() -> f32 {
    6.0
}
fn ceiling() -> f32 {
    -1.0
}

impl AudioFx {
    pub fn check(&self) -> Result<(), &'static str> {
        let within = |v: f32, lo: f32, hi: f32| v.is_finite() && (lo..=hi).contains(&v);
        if self.eq.len() > MAX_BANDS {
            return Err("audio_fx.eq takes at most 5 bands");
        }
        for b in &self.eq {
            if !within(b.freq, 20.0, 20000.0) {
                return Err("an EQ band's freq is 20..20000 Hz");
            }
            if !within(b.gain_db, -24.0, 24.0) {
                return Err("an EQ band's gain_db is -24..24");
            }
            if b.q.is_some_and(|q| !within(q, 0.1, 18.0)) {
                return Err("an EQ band's q is 0.1..18");
            }
        }
        if let Some(c) = &self.compressor {
            if !within(c.threshold_db, -60.0, 0.0) || !within(c.ratio, 1.0, 20.0) {
                return Err("compressor: threshold_db -60..0, ratio 1..20");
            }
            if !within(c.attack, 0.0, 1.0) || !within(c.release, 0.0, 1.0) || !within(c.knee_db, 0.0, 40.0) || !within(c.makeup_db, 0.0, 24.0) {
                return Err("compressor: attack and release 0..1 s, knee_db 0..40, makeup_db 0..24");
            }
        }
        if self.limiter.as_ref().is_some_and(|l| !within(l.ceiling_db, -12.0, 0.0)) {
            return Err("limiter: ceiling_db -12..0");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_fx_reads_and_checks() {
        let fx: AudioFx = serde_json::from_str(r#"{"eq":[{"type":"high_pass","freq":80},{"type":"peak","freq":3000,"gain_db":3,"q":1}],"compressor":{"threshold_db":-20,"ratio":3},"limiter":{}}"#).unwrap();
        assert!(fx.check().is_ok());
        assert_eq!(fx.limiter.unwrap().ceiling_db, -1.0);
        assert_eq!(fx.compressor.unwrap().attack, 0.01);
        let bad: AudioFx = serde_json::from_str(r#"{"eq":[{"type":"peak","freq":5,"gain_db":3}]}"#).unwrap();
        assert!(bad.check().is_err());
    }
}
