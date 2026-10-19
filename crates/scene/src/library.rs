//! Brick data the engine needs at render time: animation templates, the
//! composition's anchors and transition kinds. The editor (or MCP) copies it
//! from the project's bricks into the scene, so the engine never calls the API.

use crate::Easing;
use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;

/// Properties an animation template can drive. Offsets (`dx`, `dy`, `rotation`)
/// add to the layer's own value; factors (`opacity`, `scale`) multiply it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnimProp {
    Opacity,
    Scale,
    Dx,
    Dy,
    Rotation,
}

impl AnimProp {
    pub fn is_factor(self) -> bool {
        matches!(self, AnimProp::Opacity | AnimProp::Scale)
    }
}

/// `[t, v]` or `[t, v, "ease"]`, the compact form used in brick payloads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TemplateKey {
    pub t: f32,
    pub v: f32,
    pub ease: Easing,
}

impl Serialize for TemplateKey {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        (self.t, self.v, self.ease).serialize(s)
    }
}

impl<'de> Deserialize<'de> for TemplateKey {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl<'de> Visitor<'de> for KeyVisitor {
            type Value = TemplateKey;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("[t, v] or [t, v, ease]")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<TemplateKey, A::Error> {
                let t = seq.next_element()?.ok_or_else(|| de::Error::invalid_length(0, &self))?;
                let v = seq.next_element()?.ok_or_else(|| de::Error::invalid_length(1, &self))?;
                let ease = seq.next_element()?.unwrap_or_default();
                Ok(TemplateKey { t, v, ease })
            }
        }
        d.deserialize_seq(KeyVisitor)
    }
}

/// Payload of an animation brick: `{"keys": {"scale": [[0,0,"back"],[0.5,1]]}}`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AnimTemplate {
    #[serde(default)]
    pub keys: BTreeMap<AnimProp, Vec<TemplateKey>>,
}

impl AnimTemplate {
    pub fn duration(&self) -> f32 {
        self.keys.values().filter_map(|k| k.last()).map(|k| k.t).fold(0.0, f32::max)
    }

    /// Value of `prop` at template time `t` (clamped to the first/last key).
    pub fn sample(&self, prop: AnimProp, t: f32) -> Option<f32> {
        let keys = self.keys.get(&prop)?;
        let (first, last) = (keys.first()?, keys.last()?);
        if t <= first.t {
            return Some(first.v);
        }
        if t >= last.t {
            return Some(last.v);
        }
        let i = keys.partition_point(|k| k.t <= t);
        let (a, b) = (&keys[i - 1], &keys[i]);
        let p = a.ease.apply((t - a.t) / (b.t - a.t).max(f32::EPSILON));
        Some(a.v + (b.v - a.v) * p)
    }
}

/// How a transition brick is drawn by the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionKind {
    /// A palette-colored panel sweeps across the frame.
    ShapeWipe,
    /// The frame zooms into the center and the next scene zooms out of it.
    ZoomThrough,
    /// A surface-colored sheet turns over the frame.
    PageFlip,
    /// A white flash at the cut.
    FlashCut,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TransitionTemplate {
    pub kind: TransitionKind,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Library {
    /// Animation brick key -> template.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub animations: BTreeMap<String, AnimTemplate>,
    /// Transition brick key -> template.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub transitions: BTreeMap<String, TransitionTemplate>,
    /// Named anchor -> normalized position (0..1) from the composition brick.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub anchors: BTreeMap<String, [f32; 2]>,
}

/// Anchors every scene has regardless of the composition brick (for templates).
pub const BUILTIN_ANCHORS: [(&str, [f32; 2]); 3] = [("center", [0.5, 0.5]), ("top", [0.5, 0.17]), ("bottom", [0.5, 0.84])];

impl Library {
    /// Composition anchor, falling back to the built-in ones.
    pub fn anchor(&self, name: &str) -> Option<[f32; 2]> {
        self.anchors
            .get(name)
            .copied()
            .or_else(|| BUILTIN_ANCHORS.iter().find(|(n, _)| *n == name).map(|(_, p)| *p))
    }

    pub fn is_empty(&self) -> bool {
        self.animations.is_empty() && self.transitions.is_empty() && self.anchors.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_compact_brick_payload() {
        let t: AnimTemplate =
            serde_json::from_str(r#"{"keys":{"scale":[[0,0,"back"],[0.5,1]],"dy":[[0,40],[0.45,0]]}}"#).unwrap();
        assert_eq!(t.duration(), 0.5);
        assert_eq!(t.sample(AnimProp::Scale, -1.0), Some(0.0));
        assert_eq!(t.sample(AnimProp::Dy, 1.0), Some(0.0));
        assert_eq!(t.sample(AnimProp::Opacity, 0.2), None);
    }
}
