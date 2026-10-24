//! How the video is delivered: the export's resolution and codec, saved with the scene so the user's
//! Project settings, the Export dialog and agents all read and write the same thing (`set_output`).

use serde::{Deserialize, Serialize};

/// Short sides (px) the exporters render at: the height of a vertical or square video, the width of a wide one.
pub const SHORT_SIDES: [u32; 5] = [720, 1080, 1440, 2160, 4320];
/// Frame rates offered by the editor (`set_fps` takes any rate in 1..=120).
pub const FRAME_RATES: [f32; 7] = [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 60.0];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputCodec {
    /// MP4, plays everywhere.
    #[default]
    H264,
    /// MP4, 10-bit, smaller files.
    Hevc,
    /// MOV, ProRes 422 HQ, for further editing.
    Prores,
    /// MOV, ProRes 4444 with alpha: what is not drawn stays transparent.
    Prores4444,
    /// WebM, VP9 with alpha.
    Vp9Alpha,
}

impl OutputCodec {
    /// Codecs that keep the frame's transparency.
    pub fn has_alpha(self) -> bool {
        matches!(self, OutputCodec::Prores4444 | OutputCodec::Vp9Alpha)
    }
}

/// `{"short_side":1080,"codec":"h264"}` (the defaults); `range` exports only `[in, out]` seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Output {
    #[serde(default = "default_short_side")]
    pub short_side: u32,
    #[serde(default)]
    pub codec: OutputCodec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<[f32; 2]>,
}

fn default_short_side() -> u32 {
    1080
}

impl Default for Output {
    fn default() -> Self {
        Self { short_side: default_short_side(), codec: OutputCodec::default(), range: None }
    }
}

impl Output {
    pub fn check(&self, duration: f32) -> Result<(), &'static str> {
        if !SHORT_SIDES.contains(&self.short_side) {
            return Err("short_side must be 720, 1080, 1440, 2160 or 4320");
        }
        if let Some([a, b]) = self.range {
            if !(a.is_finite() && b.is_finite() && a >= 0.0 && b > a && a < duration) {
                return Err("range is [in, out] seconds with 0 <= in < out, inside the video");
            }
        }
        Ok(())
    }

    /// Output frame size for a scene `w`×`h` (even numbers: encoders need them).
    pub fn size(&self, w: u32, h: u32) -> (u32, u32) {
        let k = self.short_side as f32 / w.min(h).max(1) as f32;
        let even = |v: u32| ((v as f32 * k / 2.0).round() as u32 * 2).max(2);
        (even(w), even(h))
    }
}

#[cfg(test)]
mod tests {
    use crate::{Op, Scene};

    #[test]
    fn output_and_fps_are_scene_settings_with_checks() {
        let mut scene = Scene { duration: 10.0, ..Scene::default() };
        let op = |json: &str| Op::parse_list(json).unwrap();
        scene.apply(&op(r#"[{"op":"set_output","output":{"short_side":2160,"codec":"prores4444","range":[2,8]}}]"#)).unwrap();
        let o = scene.output.clone().unwrap();
        assert!(o.codec.has_alpha());
        assert_eq!(o.size(1080, 1920), (2160, 3840));
        assert!(scene.apply(&op(r#"[{"op":"set_output","output":{"short_side":999}}]"#)).is_err());
        assert!(scene.apply(&op(r#"[{"op":"set_output","output":{"range":[9,20]}}]"#)).is_ok(), "out past the end is clamped by the exporter, in must be inside");
        assert!(scene.apply(&op(r#"[{"op":"set_output","output":{"range":[12,20]}}]"#)).is_err());
        scene.apply(&op(r#"[{"op":"set_fps","fps":23.976}]"#)).unwrap();
        assert_eq!(scene.fps, 23.976);
        assert!(scene.apply(&op(r#"[{"op":"set_fps","fps":0}]"#)).is_err());
        // Round trip keeps them; defaults stay out of the JSON.
        let back = Scene::from_json(&scene.to_json()).unwrap();
        assert_eq!(back.output, scene.output);
        scene.apply(&op(r#"[{"op":"set_output","output":null}]"#)).unwrap();
        assert!(!scene.to_json().contains("\"output\""));
    }
}
