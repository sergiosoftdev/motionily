//! Bulk and partial edits: change any fields of existing layers (`patch`) and swap a color
//! everywhere (`replace_color`). They exist so an agent never rewrites a whole layer, sends one op
//! per layer, or guesses an op that does not exist to change a gradient or a background.

use crate::ops::OpError;
use crate::{Layer, Scene};
use serde_json::{Map, Value};

/// Palette slots: colors written by name instead of hex.
const SLOTS: [&str; 5] = ["background", "surface", "primary", "accent", "text"];
/// Colors listed when `replace_color` finds nothing to replace.
const MAX_COLORS_SHOWN: usize = 12;

/// Which layers an op touches.
pub struct Targets<'a> {
    pub id: Option<&'a str>,
    pub ids: &'a [String],
    pub group: Option<&'a str>,
    pub all: bool,
}

impl Scene {
    fn targets(&self, t: &Targets) -> Result<Vec<usize>, OpError> {
        let mut out = Vec::new();
        for id in t.id.into_iter().chain(t.ids.iter().map(String::as_str)) {
            out.push(self.layers.iter().position(|l| l.id == id).ok_or_else(|| OpError::UnknownLayer(id.to_owned()))?);
        }
        if let Some(g) = t.group {
            let before = out.len();
            out.extend(self.layers.iter().enumerate().filter(|(_, l)| l.group.as_deref() == Some(g)).map(|(i, _)| i));
            if out.len() == before {
                return Err(OpError::Field(format!("no layer is in group '{g}'")));
            }
        }
        if t.all {
            out.extend(0..self.layers.len());
        }
        if out.is_empty() {
            return Err(OpError::Field("say which layers: id, ids, group or all".into()));
        }
        out.sort_unstable();
        out.dedup();
        Ok(out)
    }

    /// Set `fields` (JSON as in add_layer; `"stroke.width"` reaches inside an object; `null` resets a
    /// field to its default) on every target layer. Atomic: a field that does not fit any layer
    /// rejects the whole op, naming the layer and why.
    pub(crate) fn patch_layers(&mut self, t: &Targets, fields: &Map<String, Value>) -> Result<(), OpError> {
        if fields.contains_key("id") {
            return Err(OpError::Field("a patch cannot change a layer's id (add_layer a new one)".into()));
        }
        let mut changed = Vec::new();
        for idx in self.targets(t)? {
            let old = &self.layers[idx];
            let mut v = serde_json::to_value(old).map_err(|e| OpError::Field(e.to_string()))?;
            for (key, value) in fields {
                set_path(&mut v, key, value.clone());
            }
            let layer: Layer = serde_json::from_value(v).map_err(|e| OpError::Field(format!("layer '{}': {e}", old.id)))?;
            let back = serde_json::to_value(&layer).map_err(|e| OpError::Field(e.to_string()))?;
            for (key, value) in fields {
                let top = key.split('.').next().unwrap_or(key);
                if back.get(top).is_none() && !looks_default(value) {
                    return Err(OpError::Field(format!(
                        "layer '{}' has no field '{top}' (fields here: {})",
                        old.id,
                        back.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(" ")).unwrap_or_default()
                    )));
                }
            }
            changed.push((idx, self.checked_layer(layer)?));
        }
        for (idx, layer) in changed {
            self.layers[idx] = layer;
        }
        Ok(())
    }

    /// Swap color `from` for `to` in the target layers (all by default): fills, strokes, gradient
    /// stops, effects, accents, color keys. Case-insensitive; `#rrggbb` also matches `#rrggbbaa`
    /// and keeps its alpha. Finding nothing is an error that lists the colors in use.
    pub(crate) fn replace_color(&mut self, from: &str, to: &str, group: Option<&str>) -> Result<(), OpError> {
        let from = from.trim().to_ascii_lowercase();
        let to = to.trim();
        if !is_color(&from) || !is_color(&to.to_ascii_lowercase()) {
            return Err(OpError::Field(format!("replace_color takes #rrggbb[aa] colors or palette slots ({}): got '{from}' -> '{to}'", SLOTS.join(", "))));
        }
        let targets = self.targets(&Targets { id: None, ids: &[], group, all: group.is_none() })?;
        let mut count = 0;
        let mut changed = Vec::new();
        for idx in targets {
            let mut v = serde_json::to_value(&self.layers[idx]).map_err(|e| OpError::Field(e.to_string()))?;
            let n = swap_colors(&mut v, &from, to);
            if n > 0 {
                count += n;
                let layer: Layer = serde_json::from_value(v).map_err(|e| OpError::Field(format!("layer '{}': {e}", self.layers[idx].id)))?;
                changed.push((idx, layer));
            }
        }
        if count == 0 {
            let mut used: Vec<String> = Vec::new();
            for l in &self.layers {
                collect_colors(&serde_json::to_value(l).unwrap_or(Value::Null), &mut used);
            }
            used.sort();
            used.dedup();
            used.truncate(MAX_COLORS_SHOWN);
            return Err(OpError::Field(format!("no layer uses {from}; colors in use: {}", used.join(" "))));
        }
        for (idx, layer) in changed {
            self.layers[idx] = layer;
        }
        Ok(())
    }
}

/// `"a.b.c"` = value, creating objects on the way; `null` removes the field.
fn set_path(v: &mut Value, path: &str, value: Value) {
    let mut cur = v;
    let parts: Vec<&str> = path.split('.').collect();
    for part in &parts[..parts.len() - 1] {
        let obj = match cur {
            Value::Object(o) => o,
            _ => return,
        };
        cur = obj.entry(part.to_string()).or_insert_with(|| Value::Object(Map::new()));
        if !cur.is_object() {
            *cur = Value::Object(Map::new());
        }
    }
    if let Value::Object(o) = cur {
        let last = parts[parts.len() - 1].to_owned();
        if value.is_null() {
            o.remove(&last);
        } else {
            o.insert(last, value);
        }
    }
}

/// Values a layer leaves out when serialized because they are its defaults.
fn looks_default(v: &Value) -> bool {
    match v {
        Value::Null => true,
        // Both kinds of flag leave out their default (`visible` is true by default, `fixed` false).
        Value::Bool(_) => true,
        Value::Number(n) => n.as_f64().is_some_and(|x| x == 0.0 || x == 1.0),
        Value::String(s) => s.is_empty() || s == "normal",
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

fn is_color(s: &str) -> bool {
    SLOTS.contains(&s) || (s.starts_with('#') && matches!(s.len(), 7 | 9) && s[1..].chars().all(|c| c.is_ascii_hexdigit()))
}

/// Replace every string equal to `from` (or `from` + alpha) inside `v`; returns how many.
fn swap_colors(v: &mut Value, from: &str, to: &str) -> usize {
    match v {
        Value::String(s) => {
            let lower = s.to_ascii_lowercase();
            if lower == from {
                *s = to.to_owned();
                1
            } else if from.len() == 7 && lower.len() == 9 && lower.starts_with(from) && to.starts_with('#') && to.len() == 7 {
                *s = format!("{to}{}", &s[7..]);
                1
            } else {
                0
            }
        }
        Value::Array(a) => a.iter_mut().map(|x| swap_colors(x, from, to)).sum(),
        Value::Object(o) => o.iter_mut().filter(|(k, _)| k.as_str() != "id" && k.as_str() != "group").map(|(_, x)| swap_colors(x, from, to)).sum(),
        _ => 0,
    }
}

fn collect_colors(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) if is_color(&s.to_ascii_lowercase()) && s.starts_with('#') => out.push(s.to_ascii_lowercase()),
        Value::Array(a) => a.iter().for_each(|x| collect_colors(x, out)),
        Value::Object(o) => o.values().for_each(|x| collect_colors(x, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use crate::{Op, Scene};

    fn scene() -> Scene {
        let mut s = Scene::default();
        let ops = Op::parse_list(
            r##"[{"op":"add_layer","layer":{"id":"bg","type":"shape","shape":"rect","w":100,"h":100,"fill":"#E87C3D","group":"world"}},
                {"op":"add_layer","layer":{"id":"card","type":"shape","shape":"rect","w":10,"h":10,"fill":"#e87c3d80","group":"cards",
                  "effects":[{"fx":"glow","radius":8,"color":"#e87c3d"}]}},
                {"op":"add_layer","layer":{"id":"card2","type":"shape","shape":"rect","w":10,"h":10,"fill":"surface","group":"cards"}}]"##,
        )
        .unwrap();
        s.apply(&ops).unwrap();
        s
    }

    #[test]
    fn set_prop_on_any_field_patches_it() {
        let mut s = scene();
        let ops = Op::parse_list(r##"[{"op":"set_prop","id":"bg","prop":"gradient","value":{"kind":"linear","angle":90,"stops":[[0,"#000000"],[1,"#ffffff"]]}}]"##).unwrap();
        s.apply(&ops).unwrap();
        assert!(s.layer("bg").unwrap().gradient.is_some());
    }

    #[test]
    fn patches_a_whole_group_and_names_unknown_fields() {
        let mut s = scene();
        s.apply(&Op::parse_list(r#"[{"op":"patch","group":"cards","fields":{"radius":24,"stroke.width":3}}]"#).unwrap()).unwrap();
        assert!(["card", "card2"].iter().all(|id| s.layer(id).unwrap().stroke.is_some()));
        s.apply(&Op::parse_list(r#"[{"op":"patch","id":"card","fields":{"visible":false}},{"op":"patch","id":"card","fields":{"visible":true}}]"#).unwrap()).unwrap();
        assert!(s.layer("card").unwrap().visible);
        let err = s.apply(&Op::parse_list(r#"[{"op":"patch","id":"card","fields":{"gradiant":{"kind":"linear"}}}]"#).unwrap()).unwrap_err();
        assert!(err.1.to_string().contains("no field 'gradiant'"), "{}", err.1);
        let err = s.apply(&Op::parse_list(r#"[{"op":"patch","group":"nope","fields":{"radius":1}}]"#).unwrap()).unwrap_err();
        assert!(err.1.to_string().contains("no layer is in group 'nope'"));
    }

    #[test]
    fn replaces_a_color_everywhere_keeping_alpha() {
        let mut s = scene();
        s.apply(&Op::parse_list(r##"[{"op":"replace_color","from":"#e87c3d","to":"#57a0db"}]"##).unwrap()).unwrap();
        let json = serde_json::to_string(&s.layers).unwrap().to_ascii_lowercase();
        assert!(!json.contains("e87c3d"), "{json}");
        assert!(json.contains("#57a0db80"), "alpha kept: {json}");
        let err = s.apply(&Op::parse_list(r##"[{"op":"replace_color","from":"#123456","to":"accent"}]"##).unwrap()).unwrap_err();
        assert!(err.1.to_string().contains("colors in use: #57a0db"), "{}", err.1);
    }
}
