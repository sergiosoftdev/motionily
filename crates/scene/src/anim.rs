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
    /// Snappy start, long soft landing (the "premium UI" curve).
    ExpoOut,
    ExpoIn,
    ExpoInOut,
    /// Springy overshoot that oscillates and settles.
    Elastic,
    /// Lands and bounces.
    Bounce,
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
            Easing::ExpoOut => if t >= 1.0 { 1.0 } else { 1.0 - 2f32.powf(-10.0 * t) },
            Easing::ExpoIn => if t <= 0.0 { 0.0 } else { 2f32.powf(10.0 * t - 10.0) },
            Easing::ExpoInOut => {
                if t <= 0.0 || t >= 1.0 {
                    t
                } else if t < 0.5 {
                    2f32.powf(20.0 * t - 10.0) / 2.0
                } else {
                    (2.0 - 2f32.powf(-20.0 * t + 10.0)) / 2.0
                }
            }
            Easing::Elastic => {
                if t <= 0.0 || t >= 1.0 {
                    t
                } else {
                    2f32.powf(-10.0 * t) * ((t * 10.0 - 0.75) * std::f32::consts::TAU / 3.0).sin() + 1.0
                }
            }
            Easing::Bounce => {
                const N: f32 = 7.5625;
                const D: f32 = 2.75;
                if t < 1.0 / D {
                    N * t * t
                } else if t < 2.0 / D {
                    let t = t - 1.5 / D;
                    N * t * t + 0.75
                } else if t < 2.5 / D {
                    let t = t - 2.25 / D;
                    N * t * t + 0.9375
                } else {
                    let t = t - 2.625 / D;
                    N * t * t + 0.984375
                }
            }
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
    /// Custom curve to the next key, CSS cubic-bezier(x1, y1, x2, y2); overrides `ease`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bezier: Option<[f32; 4]>,
}

/// CSS-style cubic-bezier: solve x(u) = t by Newton then return y(u).
pub fn cubic_bezier([x1, y1, x2, y2]: [f32; 4], t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let bez = |a: f32, b: f32, u: f32| 3.0 * a * u * (1.0 - u).powi(2) + 3.0 * b * u * u * (1.0 - u) + u * u * u;
    let dbez = |a: f32, b: f32, u: f32| 3.0 * a * (1.0 - u).powi(2) + 6.0 * (b - a) * u * (1.0 - u) + 3.0 * (1.0 - b) * u * u;
    let mut u = t;
    for _ in 0..8 {
        let d = dbez(x1, x2, u);
        if d.abs() < 1e-6 {
            break;
        }
        u = (u - (bez(x1, x2, u) - t) / d).clamp(0.0, 1.0);
    }
    bez(y1, y2, u)
}

/// A scalar property: either a plain number or a list of keyframes.
/// `"opacity": 1` and `"opacity": [{"t":0,"v":0},{"t":0.4,"v":1}]` both parse.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Animated {
    Static(f32),
    Keys(Vec<Keyframe>),
    /// A formula, e.g. `"540 + 40*sin(t*3)"` or `"wiggle(2, 12)"` (see `expr.rs`).
    Expr(crate::expr::Expr),
}

impl Serialize for crate::expr::Expr {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.src)
    }
}

impl<'de> Deserialize<'de> for crate::expr::Expr {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let src = String::deserialize(d)?;
        let e = crate::expr::Expr::new(src);
        e.check().map_err(serde::de::Error::custom)?;
        Ok(e)
    }
}

/// By hand instead of `untagged`: serde's untagged error ("did not match any variant") hides the
/// real problem, so agents could not tell which value or expression to fix.
impl<'de> Deserialize<'de> for Animated {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        use serde_json::Value;
        match Value::deserialize(d)? {
            Value::Number(n) => n.as_f64().map(|v| Animated::Static(v as f32)).ok_or_else(|| D::Error::custom(format!("number {n} is out of range"))),
            Value::String(src) => {
                let e = crate::expr::Expr::new(src.clone());
                e.check().map_err(|why| D::Error::custom(format!("expression \"{src}\": {why}")))?;
                Ok(Animated::Expr(e))
            }
            keys @ Value::Array(_) => serde_json::from_value::<Vec<Keyframe>>(keys.clone())
                .map(Animated::Keys)
                .map_err(|why| D::Error::custom(format!("keyframes {keys} must be [{{\"t\":seconds,\"v\":number,\"ease\"?:name}}, …]: {why}"))),
            other => Err(D::Error::custom(format!("expected a number, keyframes [{{\"t\":0,\"v\":1}}, …] or an expression string, got {other}"))),
        }
    }
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
            Animated::Expr(e) => e.eval(t),
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
    let u = (t - a.t) / span;
    let p = a.bezier.map_or_else(|| a.ease.apply(u), |b| cubic_bezier(b, u));
    a.v + (b.v - a.v) * p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_between_keys() {
        let a = Animated::Keys(vec![
            Keyframe { t: 0.0, v: 0.0, ease: Easing::Linear, bezier: None },
            Keyframe { t: 1.0, v: 10.0, ease: Easing::Linear, bezier: None },
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
        let e: Animated = serde_json::from_str(r#""100 + t*10""#).unwrap();
        assert_eq!(e.sample(2.0), 120.0);
        assert!(serde_json::from_str::<Animated>(r#""1 +""#).is_err(), "bad expressions are rejected on load");
    }

    #[test]
    fn bezier_and_new_eases() {
        assert!((cubic_bezier([0.0, 0.0, 1.0, 1.0], 0.3) - 0.3).abs() < 1e-3);
        assert!(cubic_bezier([0.2, 0.8, 0.2, 1.0], 0.3) > 0.6, "fast-out curve");
        for e in [Easing::ExpoOut, Easing::Elastic, Easing::Bounce, Easing::ExpoInOut] {
            assert!((e.apply(1.0) - 1.0).abs() < 1e-3 && e.apply(0.0).abs() < 1e-3);
        }
    }
}
