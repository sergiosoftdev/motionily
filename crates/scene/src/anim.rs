use serde::{Deserialize, Serialize};

/// Easing curves an agent can pick by name. Kept small on purpose: fewer
/// choices means fewer tokens and more consistent output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Easing {
    Linear,
    #[default]
    EaseInOut,
    EaseOut,
    EaseIn,
    /// Overshoots then settles. Good for pop-in titles and captions.
    Back,
    Hold,
}

impl Easing {
    pub fn apply(self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Easing::Linear => t,
            Easing::EaseIn => t * t * t,
            Easing::EaseOut => 1.0 - (1.0 - t).powi(3),
            Easing::EaseInOut => {
                if t < 0.5 {
                    4.0 * t * t * t
                } else {
                    1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
                }
            }
            Easing::Back => {
                const C1: f32 = 1.70158;
                const C3: f32 = C1 + 1.0;
                1.0 + C3 * (t - 1.0).powi(3) + C1 * (t - 1.0).powi(2)
            }
            Easing::Hold => 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Keyframe {
    /// Seconds, relative to the layer start.
    pub t: f32,
    pub v: f32,
    /// Easing used from this keyframe to the next one.
    #[serde(default)]
    pub ease: Easing,
}

/// A scalar property: either a plain number or a list of keyframes.
/// `"opacity": 1` and `"opacity": [{"t":0,"v":0},{"t":0.4,"v":1}]` both parse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Animated {
    Static(f32),
    Keys(Vec<Keyframe>),
}

impl Default for Animated {
    fn default() -> Self {
        Animated::Static(0.0)
    }
}

impl From<f32> for Animated {
    fn from(v: f32) -> Self {
        Animated::Static(v)
    }
}

impl Animated {
    pub fn sample(&self, t: f32) -> f32 {
        match self {
            Animated::Static(v) => *v,
            Animated::Keys(keys) => sample_keys(keys, t),
        }
    }
}

fn sample_keys(keys: &[Keyframe], t: f32) -> f32 {
    let (Some(first), Some(last)) = (keys.first(), keys.last()) else {
        return 0.0;
    };
    if t <= first.t {
        return first.v;
    }
    if t >= last.t {
        return last.v;
    }
    let i = keys.partition_point(|k| k.t <= t);
    let (a, b) = (&keys[i - 1], &keys[i]);
    let span = (b.t - a.t).max(f32::EPSILON);
    let p = a.ease.apply((t - a.t) / span);
    a.v + (b.v - a.v) * p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_between_keys() {
        let a = Animated::Keys(vec![
            Keyframe { t: 0.0, v: 0.0, ease: Easing::Linear },
            Keyframe { t: 1.0, v: 10.0, ease: Easing::Linear },
        ]);
        assert_eq!(a.sample(-1.0), 0.0);
        assert_eq!(a.sample(0.5), 5.0);
        assert_eq!(a.sample(2.0), 10.0);
    }

    #[test]
    fn parses_number_or_keys() {
        let s: Animated = serde_json::from_str("1.5").unwrap();
        assert_eq!(s, Animated::Static(1.5));
        let k: Animated = serde_json::from_str(r#"[{"t":0,"v":1,"ease":"back"}]"#).unwrap();
        assert!(matches!(k, Animated::Keys(ref v) if v[0].ease == Easing::Back));
    }
}
