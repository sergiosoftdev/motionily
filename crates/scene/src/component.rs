//! Reusable components (precomps with parameters): a motif defined once, placed many times.
//!
//! A component is a list of layers (the same JSON as scene layers) whose fields read the
//! component's typed params as `$name`. An instance is a layer `{"type":"use","comp":"stat",
//! "params":{…}}`: its transform (x y s r o z parent rx ry, repeater) places all the component's
//! layers like a parent null and its clock (start, `time` remap) runs them. Instances are
//! expanded when drawn and measured, never copied into the scene, so redefining a component
//! updates every instance. Inside a component `T` is the component clock, `id.x` reads a layer
//! of the same component, and measured ids are `instance/layer`.

use crate::layer::Xform;
use crate::ops::OpError;
use crate::{enum_name, expr, paint, Animated, Bounds, ColorRef, DrawItem, EvalCtx, Layer, LayerContent, LayoutRow, Library, PathData, Scene, ScreenMap};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

/// Components nest at most this deep (a top-level instance is level 1).
pub const MAX_COMPONENT_DEPTH: u8 = 4;
/// Separates an instance id from its layers' ids in measured ids: `card1/title`.
pub const PATH_SEP: char = '/';
/// Marks a param reference: `$title`, `${title}`; in text `$$` is a literal `$`.
const SIGIL: char = '$';
/// The one field where params are substituted inside a longer string.
const TEXT_FIELD: &str = "text";
const NAME_MAX: usize = 40;

/// Type of a component param: what an instance may pass and where `$name` can go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamKind {
    /// A number, keys or an expression (animated on the instance clock).
    Number,
    /// A palette slot or `#rrggbb[aa]`.
    Color,
    /// A string shown in text.
    Text,
    /// An image source (`/media/…`).
    Src,
    /// true / false (`vis`, `caret`, `fixed`, `filled`…).
    Bool,
    /// SVG path data (path layer `d`); `{"ic":"bell:48","d":"M…"}` keeps the icon name.
    Path,
}

impl ParamKind {
    /// Value used when neither the definition nor the instance gives one.
    fn fallback(self) -> Value {
        match self {
            ParamKind::Number => Value::from(0),
            ParamKind::Color => Value::from("primary"),
            ParamKind::Text | ParamKind::Src | ParamKind::Path => Value::from(""),
            ParamKind::Bool => Value::from(false),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParamDef {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ParamKind,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub default: Value,
}

/// `{"params":[…],"duration":4,"layers":[…]}`: layers keep their raw JSON (with `$name`
/// references) and are bound to an instance's params when it is drawn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Component {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<ParamDef>,
    /// Seconds: an instance added without `end` lasts this long. None: until the video ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f32>,
    pub layers: Vec<Value>,
}

/// A component's layers with one instance's params filled in.
#[derive(Debug, Clone, PartialEq)]
pub struct Bound {
    pub layers: Vec<Layer>,
    /// Number params, sampled on the instance clock and read by `$name` in expressions.
    numbers: Vec<(String, Animated)>,
}

/// An instance's bound layers, computed on first use. Every scene clone (every applied op)
/// starts empty, so a redefined component is never drawn from a stale binding.
#[derive(Default)]
pub struct BoundCache(OnceLock<Result<Bound, String>>);

impl Clone for BoundCache {
    fn clone(&self) -> Self {
        BoundCache::default()
    }
}

impl PartialEq for BoundCache {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl std::fmt::Debug for BoundCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BoundCache")
    }
}

/// One param resolved for one instance.
struct Resolved {
    /// JSON replacing a field written exactly `"$name"` (None: an animated number stays an
    /// expression and is read from the param scope).
    whole: Option<Value>,
    /// What `$name` turns into inside text (Err: why it can't be shown there).
    inline: Result<String, String>,
    number: Option<Animated>,
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    let s = format!("{n:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// Integral numbers as JSON integers, so they also fill integer fields (`dec`, `rep` count).
fn number_json(n: f32) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e9 {
        Value::from(n as i64)
    } else {
        Value::from(n as f64)
    }
}

fn resolve(def: &ParamDef, given: Option<&Value>) -> Result<Resolved, String> {
    let fallback = def.kind.fallback();
    let v = given.filter(|v| !v.is_null()).unwrap_or(if def.default.is_null() { &fallback } else { &def.default });
    let bad = |what: &str| format!("param '${}' ({}) {what}, got {v}", def.name, enum_name(&def.kind));
    let text = |s: String| Resolved { whole: Some(Value::String(s.clone())), inline: Ok(s), number: None };
    Ok(match def.kind {
        ParamKind::Number => {
            let a = match v {
                Value::String(s) => s.trim().parse::<f32>().map(Animated::Static).or_else(|_| serde_json::from_value(v.clone())),
                _ => serde_json::from_value(v.clone()),
            }
            .map_err(|e| bad(&format!("needs a number, keyframes or an expression ({e})")))?;
            match a {
                Animated::Static(n) => Resolved { whole: Some(number_json(n)), inline: Ok(format_number(n as f64)), number: Some(a) },
                _ => Resolved {
                    whole: None,
                    inline: Err(format!("param '${0}' moves on this instance, so text can't print it: show it with count=(${0}) and {{n}} in the text", def.name)),
                    number: Some(a),
                },
            }
        }
        ParamKind::Color => {
            serde_json::from_value::<ColorRef>(v.clone()).map_err(|_| bad("needs a palette slot (background surface primary accent text) or #rrggbb[aa]"))?;
            Resolved { whole: Some(v.clone()), inline: Ok(v.as_str().map_or_else(|| v.to_string(), str::to_owned)), number: None }
        }
        ParamKind::Text | ParamKind::Src => match v {
            Value::String(s) => text(s.clone()),
            Value::Number(n) => text(format_number(n.as_f64().unwrap_or_default())),
            Value::Bool(b) => text(b.to_string()),
            _ => return Err(bad("needs a string")),
        },
        ParamKind::Bool => {
            let b = match v {
                Value::Bool(b) => *b,
                Value::Number(n) => n.as_f64() != Some(0.0),
                Value::String(s) if matches!(s.as_str(), "true" | "1") => true,
                Value::String(s) if matches!(s.as_str(), "false" | "0") => false,
                _ => return Err(bad("needs true/false (or 1/0)")),
            };
            Resolved { whole: Some(Value::Bool(b)), inline: Ok(b.to_string()), number: None }
        }
        ParamKind::Path => {
            let d = match v {
                Value::String(s) => s.clone(),
                Value::Object(o) => o.get("d").and_then(Value::as_str).ok_or_else(|| bad("needs path data or {\"ic\":…,\"d\":\"M…\"}"))?.to_owned(),
                _ => return Err(bad("needs SVG path data")),
            };
            if let Err(e) = PathData::new(d.clone()).lines() {
                return Err(bad(&format!("is not valid path data ({e})")));
            }
            text(d)
        }
    })
}

/// A piece of a string with `$` references.
enum Seg<'a> {
    Lit(&'a str),
    /// `$$`.
    Dollar,
    Param(&'a str),
}

/// Split `s` at its `$name` / `${name}` references. A `$` not followed by a name stays literal.
fn segments(s: &str) -> Vec<Seg<'_>> {
    let mut out = Vec::new();
    let (b, mut lit, mut i) = (s.as_bytes(), 0, 0);
    while i < b.len() {
        if b[i] != SIGIL as u8 {
            i += 1;
            continue;
        }
        let (name, next) = if b.get(i + 1) == Some(&(SIGIL as u8)) {
            (None, i + 2)
        } else if b.get(i + 1) == Some(&b'{') {
            match s[i + 2..].find('}') {
                Some(close) => (Some(&s[i + 2..i + 2 + close]), i + 3 + close),
                None => {
                    i += 1;
                    continue;
                }
            }
        } else {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            (Some(&s[i + 1..j]), j)
        };
        if name.is_some_and(|n| n.is_empty() || n.as_bytes()[0].is_ascii_digit()) {
            i += 1;
            continue;
        }
        out.push(Seg::Lit(&s[lit..i]));
        out.push(name.map_or(Seg::Dollar, Seg::Param));
        i = next;
        lit = next;
    }
    out.push(Seg::Lit(&s[lit..]));
    out
}

/// The param a whole string is (`"$accent"`, `"${accent}"`), if it is exactly one reference.
fn whole_ref(s: &str) -> Option<&str> {
    match segments(s).as_slice() {
        [Seg::Lit(""), Seg::Param(p), Seg::Lit("")] => Some(p),
        _ => None,
    }
}

fn interpolate(s: &str, params: &BTreeMap<&str, Resolved>) -> Result<String, String> {
    let mut out = String::with_capacity(s.len());
    for seg in segments(s) {
        match seg {
            Seg::Lit(l) => out.push_str(l),
            Seg::Dollar => out.push(SIGIL),
            Seg::Param(p) => out.push_str(params.get(p).ok_or_else(|| format!("unknown param '${p}'"))?.inline.as_ref().map_err(Clone::clone)?),
        }
    }
    Ok(out)
}

fn substitute(v: &mut Value, params: &BTreeMap<&str, Resolved>, in_text: bool) -> Result<(), String> {
    match v {
        Value::String(s) if in_text => *s = interpolate(s, params)?,
        Value::String(s) => {
            if let Some(p) = whole_ref(s) {
                let r = params.get(p).ok_or_else(|| format!("unknown param '${p}'"))?;
                if let Some(w) = &r.whole {
                    *v = w.clone();
                }
            }
        }
        Value::Array(a) => a.iter_mut().try_for_each(|x| substitute(x, params, false))?,
        Value::Object(o) => o.iter_mut().try_for_each(|(_, x)| substitute(x, params, false))?,
        _ => {}
    }
    Ok(())
}

fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= NAME_MAX && !s.as_bytes()[0].is_ascii_digit() && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Component ids a raw layer list places directly (`"type":"use"` layers).
fn uses_of(layers: &[Value]) -> BTreeSet<&str> {
    layers.iter().filter(|l| l.get("type").and_then(Value::as_str) == Some(USE_TYPE)).filter_map(|l| l.get("comp").and_then(Value::as_str)).collect()
}

/// `type` tag of instance layers.
pub const USE_TYPE: &str = "use";

impl Component {
    fn param_list(&self) -> String {
        if self.params.is_empty() {
            return "none".into();
        }
        self.params.iter().map(|p| format!("${}", p.name)).collect::<Vec<_>>().join(" ")
    }

    /// This component's layers with `given` params (unset ones take their defaults).
    pub fn bind(&self, name: &str, given: &BTreeMap<String, Value>) -> Result<Bound, String> {
        if let Some(k) = given.keys().find(|k| !self.params.iter().any(|p| &p.name == *k)) {
            return Err(format!("component '{name}' has no param '{k}' (params: {})", self.param_list()));
        }
        let resolved = self
            .params
            .iter()
            .map(|p| Ok((p.name.as_str(), resolve(p, given.get(&p.name))?)))
            .collect::<Result<BTreeMap<&str, Resolved>, String>>()?;
        let mut layers = Vec::with_capacity(self.layers.len());
        for raw in &self.layers {
            let id = raw.get("id").and_then(Value::as_str).unwrap_or("?");
            let at = |e: String| format!("component '{name}' layer '{id}': {e}");
            let mut v = raw.clone();
            if let Value::Object(o) = &mut v {
                for (k, x) in o.iter_mut() {
                    substitute(x, &resolved, k == TEXT_FIELD).map_err(at)?;
                }
            }
            layers.push(serde_json::from_value::<Layer>(v).map_err(|e| {
                let e = e.to_string();
                // A moving number left as `"$name"` in a field that only takes a fixed number.
                let moving = resolved.iter().find(|(n, r)| r.whole.is_none() && e.contains(&format!("\"${n}\"")));
                at(moving.map_or(e.clone(), |(n, _)| format!("{e} — '${n}' moves on this instance, and this field takes a fixed number (animate s= or an expression field instead)")))
            })?);
        }
        let numbers = resolved.into_iter().filter_map(|(n, r)| r.number.map(|a| (n.to_owned(), a))).collect();
        Ok(Bound { layers, numbers })
    }

    /// Shape checks that need no other component: names, defaults, ids and `$` references.
    fn check(&self, name: &str) -> Result<(), String> {
        if self.duration.is_some_and(|d| !(d > 0.0)) {
            return Err(format!("component '{name}': duration must be > 0 seconds (or left out)"));
        }
        let mut seen = BTreeSet::new();
        for p in &self.params {
            if !valid_name(&p.name) {
                return Err(format!("component '{name}': param name '{}' must be letters, digits and _ (not starting with a digit)", p.name));
            }
            if !seen.insert(p.name.as_str()) {
                return Err(format!("component '{name}': param '{}' is declared twice", p.name));
            }
            resolve(p, None).map_err(|e| format!("component '{name}' default: {e}"))?;
        }
        if self.layers.is_empty() {
            return Err(format!("component '{name}' has no layers"));
        }
        let mut ids = BTreeSet::new();
        for raw in &self.layers {
            let Some(id) = raw.get("id").and_then(Value::as_str) else {
                return Err(format!("component '{name}': every layer needs an id"));
            };
            if id.is_empty() || id.contains(PATH_SEP) {
                return Err(format!("component '{name}': layer id '{id}' must be non-empty and without '/'"));
            }
            if !ids.insert(id) {
                return Err(format!("component '{name}': layer id '{id}' is used twice"));
            }
            self.check_refs(name, id, raw, false, true)?;
        }
        Ok(())
    }

    /// Every `$name` in a layer must be a declared param, used where its type can go.
    fn check_refs(&self, name: &str, id: &str, v: &Value, in_text: bool, top: bool) -> Result<(), String> {
        match v {
            Value::String(s) => {
                let whole = whole_ref(s).is_some();
                for seg in segments(s) {
                    let Seg::Param(p) = seg else { continue };
                    let Some(def) = self.params.iter().find(|d| d.name == p) else {
                        return Err(format!("component '{name}' layer '{id}' uses '${p}', but the params are: {}", self.param_list()));
                    };
                    if !in_text && !whole && def.kind != ParamKind::Number {
                        return Err(format!(
                            "component '{name}' layer '{id}': '${p}' ({}) sits inside a longer value; only text substitutes params inline, other fields take the whole value \"${p}\" and expressions read number params",
                            enum_name(&def.kind)
                        ));
                    }
                }
                Ok(())
            }
            Value::Array(a) => a.iter().try_for_each(|x| self.check_refs(name, id, x, false, false)),
            Value::Object(o) => o.iter().try_for_each(|(k, x)| self.check_refs(name, id, x, top && k == TEXT_FIELD, false)),
            _ => Ok(()),
        }
    }
}

/// Bind every instance inside `bound` (recursively), so a definition is checked all the way down.
fn deep_check(bound: &Bound, library: &Library, level: u8) -> Result<(), String> {
    for l in &bound.layers {
        let LayerContent::Use { comp, params, .. } = &l.content else { continue };
        if level >= MAX_COMPONENT_DEPTH {
            return Err(format!("components nest deeper than {MAX_COMPONENT_DEPTH} levels (at '{}' using '{comp}')", l.id));
        }
        let c = library.components.get(comp).ok_or_else(|| unknown_component(comp, library))?;
        let inner = c.bind(comp, params).map_err(|e| format!("layer '{}': {e}", l.id))?;
        deep_check(&inner, library, level + 1)?;
    }
    Ok(())
}

fn unknown_component(comp: &str, library: &Library) -> String {
    let defined: Vec<&str> = library.components.keys().map(String::as_str).collect();
    format!("unknown component '{comp}' (defined: {}); define it with define_component first", if defined.is_empty() { "none".to_owned() } else { defined.join(", ") })
}

/// Does component `c` place `target`, directly or through other components?
fn depends_on(library: &Library, c: &Component, target: &str, seen: &mut BTreeSet<String>) -> bool {
    uses_of(&c.layers).into_iter().any(|u| {
        u == target || (seen.insert(u.to_owned()) && library.components.get(u).is_some_and(|inner| depends_on(library, inner, target, seen)))
    })
}

/// Checks an added layer: no `/` in its id; an instance must bind. A new instance without
/// `end` gets `start + duration` of its component.
pub(crate) fn check_instance(layer: &mut Layer, library: &Library) -> Result<(), OpError> {
    if layer.id.contains(PATH_SEP) {
        return Err(OpError::Component(format!("layer id '{}' can't contain '/' (it separates an instance from its layers)", layer.id)));
    }
    let LayerContent::Use { comp, params, .. } = &layer.content else { return Ok(()) };
    let c = library.components.get(comp).ok_or_else(|| OpError::Component(unknown_component(comp, library)))?;
    c.bind(comp, params).and_then(|b| deep_check(&b, library, 1)).map_err(|e| OpError::Component(format!("instance '{}': {e}", layer.id)))?;
    if layer.end.is_none() {
        layer.end = c.duration.map(|d| layer.start + d);
    }
    Ok(())
}

/// `use stat $title="Revenue" $value=12480` for the scene summary.
pub(crate) fn instance_name(comp: &str, params: &BTreeMap<String, Value>) -> String {
    let mut s = format!("{USE_TYPE} {comp}");
    for (k, v) in params {
        let shown = match v {
            Value::Object(o) => o.get("ic").and_then(Value::as_str).map_or("…".to_owned(), |ic| format!("ic:{ic}")),
            Value::String(t) if t.chars().count() > 32 => "…".to_owned(),
            _ => v.to_string(),
        };
        s.push_str(&format!(" ${k}={shown}"));
    }
    s
}

/// Summary lines for the defined components.
pub(crate) fn summary_lines(library: &Library) -> String {
    library
        .components
        .iter()
        .map(|(name, c)| {
            let params: Vec<String> = c.params.iter().map(|p| format!("{}:{}", p.name, enum_name(&p.kind))).collect();
            let len = c.duration.map(|d| format!(" {d}s")).unwrap_or_default();
            format!("component {name}{len}: params [{}] layers [{}]\n", params.join(" "), c.layers.iter().filter_map(|l| l.get("id").and_then(Value::as_str)).collect::<Vec<_>>().join(","))
        })
        .collect()
}

/// Top-level layer id of a measured id (`card1/title` -> `card1`).
pub(crate) fn top_id(id: &str) -> &str {
    id.split(PATH_SEP).next().unwrap_or(id)
}

impl Layer {
    /// The component layers of an instance, bound with its params (None: not an instance, or broken).
    pub(crate) fn bound<'a>(&'a self, library: &Library) -> Option<&'a Bound> {
        let LayerContent::Use { comp, params, bound } = &self.content else { return None };
        bound
            .0
            .get_or_init(|| library.components.get(comp).ok_or_else(|| unknown_component(comp, library)).and_then(|c| c.bind(comp, params)))
            .as_ref()
            .ok()
    }

    fn is_instance(&self) -> bool {
        matches!(self.content, LayerContent::Use { .. })
    }
}

/// One instance being drawn or measured: its bound layers on the component clock.
#[derive(Clone, Copy)]
pub(crate) struct Inside<'a> {
    layers: &'a [Layer],
    /// Component clock: the instance's local time (after its `time` remap).
    ct: f32,
    /// World transform of the instance (the parent of its layers), with its opacity.
    root: Xform,
    /// How deep instances among these layers sit (1 inside a top-level instance).
    depth: u8,
}

impl<'a> Inside<'a> {
    /// A layer without `end` lasts as long as the instance.
    fn active(&self, l: &Layer) -> bool {
        self.ct >= l.start && l.end.is_none_or(|e| self.ct < e)
    }

    fn sibling(&self, id: &str) -> Option<&'a Layer> {
        self.layers.iter().find(|l| l.id == id)
    }
}

/// Transform a component layer inherits: its `parent` chain inside the component, then the instance.
fn local_parent(l: &Layer, inside: &Inside, ctx: &EvalCtx, hops: u8) -> Xform {
    let root = inside.root;
    let Some(p) = l.parent.as_deref().and_then(|pid| inside.sibling(pid)) else { return root };
    if hops > crate::MAX_PARENT_DEPTH || p.id == l.id {
        return root;
    }
    let up = local_parent(p, inside, ctx, hops + 1);
    Xform { opacity: root.opacity, ..p.world(p.local_time(inside.ct), ctx, &up) }
}

fn ref_prop(l: &Layer, prop: expr::Prop) -> &Animated {
    match prop {
        expr::Prop::X => &l.x,
        expr::Prop::Y => &l.y,
        expr::Prop::W => &l.w,
        expr::Prop::H => &l.h,
        expr::Prop::Scale => &l.scale,
        expr::Prop::Rotation => &l.rotation,
        expr::Prop::Opacity => &l.opacity,
    }
}

/// One measured layer inside an instance (flat scene px, before the camera).
pub(crate) struct Inner {
    pub path: String,
    pub bounds: Bounds,
    pub visible: bool,
    /// False for a nested instance's row (its box is the union of its layers).
    pub leaf: bool,
}

fn union(rows: &[Inner]) -> Option<Bounds> {
    let leaves = || rows.iter().filter(|r| r.leaf);
    let pick: Vec<&Inner> = if leaves().any(|r| r.visible) { leaves().filter(|r| r.visible).collect() } else { leaves().collect() };
    let corners: Vec<[f32; 2]> = pick.iter().flat_map(|r| r.bounds.corners()).collect();
    (!corners.is_empty()).then(|| Bounds::enclosing(&corners))
}

impl Scene {
    // ── components: definitions ──

    pub(crate) fn define_component(&mut self, name: &str, comp: &Component) -> Result<(), OpError> {
        let fail = OpError::Component;
        if !valid_name(name) {
            return Err(fail(format!("component name '{name}' must be letters, digits and _ (max {NAME_MAX})")));
        }
        comp.check(name).map_err(fail)?;
        let mut library = self.library.clone();
        library.components.insert(name.to_owned(), comp.clone());
        if depends_on(&library, comp, name, &mut BTreeSet::new()) {
            return Err(fail(format!("component '{name}' would contain itself (directly or through the components it uses)")));
        }
        let bound = comp.bind(name, &BTreeMap::new()).map_err(fail)?;
        deep_check(&bound, &library, 1).map_err(|e| fail(format!("component '{name}': {e}")))?;
        // Whatever uses it must still hold together with the new definition.
        for (other, c) in &library.components {
            if other != name && depends_on(&library, c, name, &mut BTreeSet::new()) {
                c.bind(other, &BTreeMap::new())
                    .and_then(|b| deep_check(&b, &library, 1))
                    .map_err(|e| fail(format!("redefining '{name}' breaks component '{other}': {e}")))?;
            }
        }
        for l in &self.layers {
            let LayerContent::Use { comp: c, params, .. } = &l.content else { continue };
            let Some(def) = library.components.get(c).filter(|d| c == name || depends_on(&library, d, name, &mut BTreeSet::new())) else { continue };
            def.bind(c, params)
                .and_then(|b| deep_check(&b, &library, 1))
                .map_err(|e| fail(format!("redefining '{name}' breaks instance '{}': {e}", l.id)))?;
        }
        self.library = library;
        Ok(())
    }

    pub(crate) fn remove_component(&mut self, name: &str) -> Result<(), OpError> {
        if !self.library.components.contains_key(name) {
            return Err(OpError::Component(unknown_component(name, &self.library)));
        }
        let mut users: Vec<String> = self.layers.iter().filter(|l| matches!(&l.content, LayerContent::Use { comp, .. } if comp == name)).map(|l| format!("layer '{}'", l.id)).collect();
        users.extend(self.library.components.iter().filter(|(_, c)| uses_of(&c.layers).contains(name)).map(|(n, _)| format!("component '{n}'")));
        if !users.is_empty() {
            return Err(OpError::Component(format!("component '{name}' is still used by {}; remove those first (same batch is fine)", users.join(", "))));
        }
        self.library.components.remove(name);
        Ok(())
    }

    // ── components: drawing ──

    /// What one layer draws at layer time `lt` inside `xf`: an instance draws its component.
    pub(crate) fn draw_one(&self, l: &Layer, lt: f32, ctx: &EvalCtx, xf: &Xform, depth: u8) -> Vec<DrawItem> {
        if l.is_instance() {
            return self.instance_items(l, lt, ctx, xf, depth);
        }
        l.draw_in(lt, ctx, xf).into_iter().collect()
    }

    /// Run `f` inside instance `inst` at its local time `lt`: its params, sibling references and
    /// component clock are what expressions see. `depth` is the instance's own nesting (0 = top).
    fn enter<'s>(&'s self, inst: &'s Layer, lt: f32, ctx: &EvalCtx, xf: &Xform, depth: u8, f: &mut dyn FnMut(&Inside<'s>)) {
        if depth >= MAX_COMPONENT_DEPTH {
            return;
        }
        let Some(bound) = inst.bound(ctx.library) else { return };
        let mut root = inst.world(lt, ctx, xf);
        root.opacity = (inst.opacity.sample(lt) * inst.anim_opacity(lt, ctx.library) * xf.opacity).clamp(0.0, 1.0);
        // Sampled outside, where `t` is the instance's time and `$` the enclosing instance's params.
        let numbers: Vec<(String, f32)> = bound.numbers.iter().map(|(n, a)| (n.clone(), a.sample(lt))).collect();
        let layers = bound.layers.as_slice();
        let resolve = |id: &str, prop: expr::Prop, gt: f32| {
            let Some(l) = layers.iter().find(|l| l.id == id) else { return 0.0 };
            expr::with_vars(gt, 0.0, 1.0, || ref_prop(l, prop).sample(l.local_time(gt)))
        };
        let inside = Inside { layers, ct: lt, root, depth: depth + 1 };
        expr::with_params(&numbers, || expr::with_resolver(&resolve, || expr::with_vars(lt, 0.0, 1.0, || f(&inside))));
    }

    fn instance_items(&self, inst: &Layer, lt: f32, ctx: &EvalCtx, xf: &Xform, depth: u8) -> Vec<DrawItem> {
        let mut out = Vec::new();
        self.enter(inst, lt, ctx, xf, depth, &mut |inside| {
            if inside.root.opacity <= 0.0 {
                return;
            }
            for child in inside.layers {
                if child.visible && child.camera.is_none() && inside.active(child) {
                    out.extend(self.child_items(child, inside, ctx));
                }
            }
        });
        out
    }

    /// A component layer without its effects (matte sources, motion-blur samples).
    fn plain_child(&self, child: &Layer, inside: &Inside, ctx: &EvalCtx) -> Vec<DrawItem> {
        let base = local_parent(child, inside, ctx, 0);
        self.copies(child, inside.ct, child.local_time(inside.ct), &base, ctx, inside.depth)
    }

    /// A component layer with its effects, blend, matte (a sibling), glass and motion blur, like
    /// a top-level layer without depth (rx/ry/z/camera inside a component are ignored).
    fn child_items(&self, child: &Layer, inside: &Inside, ctx: &EvalCtx) -> Vec<DrawItem> {
        let mut drawn = self.plain_child(child, inside, ctx);
        if drawn.is_empty() {
            return drawn;
        }
        let mut out: Vec<DrawItem> = self.backdrop_pass(child, inside.ct, &drawn, None, [0.0; 2]).into_iter().collect();
        let needs_fx = child.live_effects().next().is_some() || child.blend != paint::BlendMode::Normal || child.matte.is_some() || child.adjustment;
        if !needs_fx {
            out.append(&mut drawn);
            return out;
        }
        let lt = child.local_time(inside.ct);
        let effects: Vec<paint::DrawEffect> = child.live_effects().filter_map(|e| e.resolve(lt, ctx.palette)).collect();
        let fx = if child.adjustment {
            paint::DrawFx { items: Vec::new(), effects, blend: child.blend, matte: Some((drawn, if child.invert { paint::MatteMode::AlphaInverted } else { paint::MatteMode::Alpha })), samples: Vec::new(), adjust: true, perspective: None, plane_origin: [0.0; 2] }
        } else {
            let matte = child.matte.as_ref().and_then(|m| {
                let src = inside.sibling(&m.layer)?;
                Some((if inside.active(src) { self.plain_child(src, inside, ctx) } else { Vec::new() }, m.mode))
            });
            let samples = self.child_samples(child, inside, ctx);
            paint::DrawFx { items: drawn, effects, blend: child.blend, matte, samples, adjust: false, perspective: None, plane_origin: [0.0; 2] }
        };
        out.push(DrawItem::Fx(Box::new(fx)));
        out
    }

    /// Motion blur of a component layer: it at the other instants of its shutter (component clock).
    fn child_samples(&self, child: &Layer, inside: &Inside, ctx: &EvalCtx) -> Vec<Vec<DrawItem>> {
        let Some((shutter, samples)) = child.live_effects().find_map(|e| match e {
            paint::Effect::MotionBlur { shutter, samples } => Some((*shutter, *samples)),
            _ => None,
        }) else {
            return Vec::new();
        };
        let n = samples.clamp(2, paint::MAX_BLUR_SAMPLES);
        let open = shutter.clamp(0.0, 720.0) / 360.0 / self.fps.max(1.0);
        (1..n)
            .map(|k| {
                let at = Inside { ct: inside.ct - open * k as f32 / (n - 1) as f32, ..*inside };
                self.plain_child(child, &at, ctx)
            })
            .collect()
    }

    // ── components: measuring ──

    /// Every layer inside instance `inst` at its local time `lt`, depth first; a nested instance
    /// comes as its union row followed by its own layers.
    #[allow(clippy::too_many_arguments)]
    fn inner_boxes<'s>(&'s self, inst: &'s Layer, lt: f32, ctx: &EvalCtx, xf: &Xform, depth: u8, prefix: &str, visible: bool, out: &mut Vec<Inner>) {
        self.enter(inst, lt, ctx, xf, depth, &mut |inside| {
            for child in inside.layers {
                if child.camera.is_some() || !inside.active(child) {
                    continue;
                }
                let path = format!("{prefix}{PATH_SEP}{}", child.id);
                let base = local_parent(child, inside, ctx, 0);
                let clt = child.local_time(inside.ct);
                let shown = visible && child.visible;
                if child.is_instance() {
                    let at = out.len();
                    self.inner_boxes(child, clt, ctx, &base, inside.depth, &path, shown, out);
                    if let Some(bounds) = union(&out[at..]) {
                        out.insert(at, Inner { path, bounds, visible: shown, leaf: false });
                    }
                } else if let Some(bounds) = child.bounds(clt, ctx, &base) {
                    out.push(Inner { path, bounds, visible: shown, leaf: true });
                }
            }
        });
    }

    /// The layers inside a top-level instance at scene time `t` (empty for other layers).
    pub(crate) fn inner_list(&self, l: &Layer, t: f32, ctx: &EvalCtx) -> Vec<Inner> {
        let mut out = Vec::new();
        if l.is_instance() {
            let xf = self.parent_xform(l, t, ctx, 0);
            expr::with_vars(t, 0.0, 1.0, || self.inner_boxes(l, l.local_time(t), ctx, &xf, 0, &l.id, l.visible, &mut out));
        }
        out
    }

    /// Flat box of a top-level layer at `t`; an instance is the union of its visible layers.
    pub(crate) fn flat_bounds(&self, l: &Layer, t: f32, ctx: &EvalCtx) -> Option<Bounds> {
        if l.is_instance() {
            return union(&self.inner_list(l, t, ctx));
        }
        l.bounds(l.local_time(t), ctx, &self.parent_xform(l, t, ctx, 0))
    }

    /// Does point `p` (screen) fall on one of the layers inside instance `l`?
    pub(crate) fn instance_hit(&self, l: &Layer, t: f32, ctx: &EvalCtx, map: &ScreenMap, p: [f32; 2]) -> bool {
        !l.is_instance() || self.inner_list(l, t, ctx).iter().any(|r| r.leaf && r.visible && map.bounds(&r.bounds).is_some_and(|b| b.contains(p)))
    }

    /// Layout rows (`instance/layer`) of the layers inside instance `idx`, after its screen map.
    /// Particle layers inside a component report their box, not their live counts.
    pub(crate) fn inner_rows(&self, idx: usize, t: f32, ctx: &EvalCtx, map: &ScreenMap, z: f32, plane: &Option<String>) -> Vec<LayoutRow> {
        let l = &self.layers[idx];
        self.inner_list(l, t, ctx)
            .into_iter()
            .filter_map(|r| {
                let b = map.bounds(&r.bounds)?;
                Some(LayoutRow { id: r.path, group: l.group.clone(), screen: b.rect(), k: map.scale_at(b.center), z, visible: r.visible, plane: plane.clone(), particles: None })
            })
            .collect()
    }

    /// On-screen box of `instance/layer` at `t`.
    pub(crate) fn inner_bounds(&self, path: &str, t: f32) -> Option<Bounds> {
        let idx = self.layers.iter().position(|l| l.id == top_id(path))?;
        let l = &self.layers[idx];
        self.measuring(t, |m| {
            if !self.active(l, t) {
                return None;
            }
            let map = self.screen_map(idx, t, m)?;
            let rows = self.inner_list(l, t, m.ctx);
            map.bounds(&rows.iter().find(|r| r.path == path)?.bounds)
        })
    }

    /// Draw items of one layer inside an instance (`instance/layer`), with its effects.
    pub(crate) fn inner_items_at(&self, path: &str, t: f32) -> Vec<DrawItem> {
        let mut segs = path.split(PATH_SEP);
        let Some(l) = segs.next().and_then(|id| self.layer(id)).filter(|l| self.active(l, t)) else { return Vec::new() };
        let rest: Vec<&str> = segs.collect();
        let palette = self.palette();
        let ctx = EvalCtx { palette: &palette, typography: self.typography.as_ref(), library: &self.library, scene_size: [self.width as f32, self.height as f32] };
        let mut out = Vec::new();
        self.with_refs(|| {
            expr::set_scene_time(t);
            let xf = self.parent_xform(l, t, &ctx, 0);
            expr::with_vars(t, 0.0, 1.0, || self.descend(l, l.local_time(t), &ctx, &xf, 0, &rest, &mut |child, inside| out = self.child_items(child, inside, &ctx)));
        });
        out
    }

    /// Walk down `rest` (layer ids) through nested instances and call `f` on the last one.
    #[allow(clippy::too_many_arguments)]
    fn descend<'s>(&'s self, inst: &'s Layer, lt: f32, ctx: &EvalCtx, xf: &Xform, depth: u8, rest: &[&str], f: &mut dyn FnMut(&'s Layer, &Inside<'s>)) {
        let Some((first, more)) = rest.split_first() else { return };
        self.enter(inst, lt, ctx, xf, depth, &mut |inside| {
            let Some(child) = inside.sibling(first).filter(|c| inside.active(c)) else { return };
            if more.is_empty() {
                return f(child, inside);
            }
            let base = local_parent(child, inside, ctx, 0);
            self.descend(child, child.local_time(inside.ct), ctx, &base, inside.depth, more, f);
        });
    }

    /// A layer by id, also inside instances (`card1/title`), as bound to the instance's params.
    pub fn resolve_layer(&self, id: &str) -> Option<&Layer> {
        let mut segs = id.split(PATH_SEP);
        let mut cur = self.layer(segs.next()?)?;
        for s in segs {
            cur = cur.bound(&self.library)?.layers.iter().find(|l| l.id == s)?;
        }
        Some(cur)
    }

    /// Image sources used inside instances.
    pub(crate) fn inner_images(&self, out: &mut Vec<String>) {
        fn walk(l: &Layer, library: &Library, depth: u8, out: &mut Vec<String>) {
            let Some(b) = l.bound(library).filter(|_| depth < MAX_COMPONENT_DEPTH) else { return };
            for c in &b.layers {
                if let LayerContent::Image { src, .. } = &c.content {
                    out.push(src.clone());
                }
                walk(c, library, depth + 1, out);
            }
        }
        for l in &self.layers {
            walk(l, &self.library, 0, out);
        }
    }

    /// Every layer as JSON with the layers inside instances right after them (ids `instance/layer`,
    /// start/end in scene seconds without time remap): what reviews and exports walk.
    pub fn flat_layers_json(&self) -> String {
        fn walk(l: &Layer, prefix: &str, start: f32, end: Option<f32>, library: &Library, depth: u8, rows: &mut Vec<Value>) {
            let Some(b) = l.bound(library).filter(|_| depth < MAX_COMPONENT_DEPTH) else { return };
            for c in &b.layers {
                let path = format!("{prefix}{PATH_SEP}{}", c.id);
                let (s, e) = (start + c.start, c.end.map(|e| start + e).or(end));
                if let Ok(mut v) = serde_json::to_value(c) {
                    v["id"] = Value::from(path.clone());
                    v["start"] = Value::from(s);
                    v["end"] = e.map_or(Value::Null, Value::from);
                    rows.push(v);
                }
                walk(c, &path, s, e, library, depth + 1, rows);
            }
        }
        let mut rows = Vec::new();
        for l in &self.layers {
            rows.extend(serde_json::to_value(l).ok());
            walk(l, &l.id, l.start, l.end, &self.library, 0, &mut rows);
        }
        Value::Array(rows).to_string()
    }
}

#[cfg(test)]
mod tests {
    use crate::{DrawItem, DrawShape, Op, Scene};

    fn scene(ops: &str) -> Scene {
        let mut s = Scene { width: 1000, height: 1000, ..Scene::default() };
        let ops: Vec<Op> = serde_json::from_str(ops).unwrap();
        s.apply(&ops).unwrap();
        s
    }

    fn shapes(items: &[DrawItem]) -> Vec<DrawShape> {
        let mut out = Vec::new();
        for i in items {
            match i {
                DrawItem::Shape(s) => out.push(*s),
                DrawItem::Fx(fx) => out.extend(shapes(&fx.items)),
                DrawItem::Group(g) => out.extend(shapes(g)),
                _ => {}
            }
        }
        out
    }

    const CHIP: &str = r##"{"op":"define_component","name":"chip","component":{"duration":3,
        "params":[{"name":"w","type":"number","default":200},{"name":"tint","type":"color","default":"#ff0000"},
                  {"name":"label","type":"text","default":"Hi"},{"name":"show","type":"bool","default":true}],
        "layers":[{"id":"bg","type":"shape","shape":"rect","w":"$w","h":50,"fill":"$tint","visible":"$show"},
                  {"id":"dot","type":"shape","shape":"ellipse","x":"$w/2 + 10","w":10,"h":10,"start":1,"end":2},
                  {"id":"txt","type":"text","text":"${label}s cost $$5","size":20,"w":"$w","h":40}]}}"##;

    #[test]
    fn instances_draw_their_component_with_params_and_transform() {
        let s = scene(&format!(
            r##"[{CHIP},
            {{"op":"add_layer","layer":{{"id":"a","type":"use","comp":"chip","start":0.5,"x":300,"y":400,"scale":2,"params":{{"w":100,"tint":"accent"}}}}}}]"##
        ));
        // Added without end: start + the component's duration.
        assert_eq!(s.layer("a").unwrap().end, Some(3.5));
        assert!(s.frame(0.2).is_empty());
        let items = s.frame(1.0);
        let sh = shapes(&items);
        assert_eq!(sh.len(), 1, "the dot starts at component second 1: {items:?}");
        assert_eq!(sh[0].center, [300.0, 400.0]);
        assert_eq!(sh[0].size, [200.0, 100.0], "w=$w=100 at the instance's scale 2");
        assert_eq!(sh[0].color, s.palette().accent);
        let sh = shapes(&s.frame(1.6));
        assert_eq!(sh.len(), 2);
        assert_eq!(sh[1].center, [300.0 + 2.0 * 60.0, 400.0], "x=($w/2+10) inside the instance");
        let Some(DrawItem::Text(t)) = s.frame(1.0).into_iter().find(|i| matches!(i, DrawItem::Text(_))) else { panic!() };
        assert_eq!(t.spans[0].text, "His cost $5");
        assert!(s.frame(3.6).is_empty());
    }

    #[test]
    fn animated_number_params_run_on_the_instance_clock() {
        let s = scene(&format!(
            r#"[{CHIP},
            {{"op":"add_layer","layer":{{"id":"a","type":"use","comp":"chip","start":1,"end":5,"x":500,"y":500,
              "params":{{"w":[{{"t":0,"v":100,"ease":"linear"}},{{"t":2,"v":300}}],"label":"ok"}}}}}}]"#
        ));
        let bg = |t: f32| shapes(&s.frame(t))[0];
        assert_eq!(bg(1.0).size[0], 100.0);
        assert!((bg(2.0).size[0] - 200.0).abs() < 1e-3);
        // A moving number can't be printed in text: the instance is refused with the fix.
        let mut bad = s.clone();
        let ops: Vec<Op> = serde_json::from_str(
            r#"[{"op":"define_component","name":"n","component":{"params":[{"name":"v","type":"number"}],
                 "layers":[{"id":"t","type":"text","text":"$v","size":10,"w":10,"h":10}]}},
               {"op":"add_layer","layer":{"id":"b","type":"use","comp":"n","params":{"v":"t*10"}}}]"#,
        )
        .unwrap();
        let err = bad.apply(&ops).unwrap_err();
        assert!(err.1.to_string().contains("count=($v)"), "{}", err.1);
        let ops: Vec<Op> = serde_json::from_str(
            r#"[{"op":"define_component","name":"n","component":{"params":[{"name":"v","type":"number","default":20}],
                 "layers":[{"id":"t","type":"text","text":"hi","size":"$v","w":10,"h":10}]}},
               {"op":"add_layer","layer":{"id":"b","type":"use","comp":"n","params":{"v":"t*10"}}}]"#,
        )
        .unwrap();
        let err = bad.apply(&ops).unwrap_err();
        assert!(err.0 == 1 && err.1.to_string().contains("takes a fixed number"), "{}", err.1);
    }

    #[test]
    fn components_nest_and_refuse_cycles_and_bad_params() {
        let mut s = scene(&format!(
            r#"[{CHIP},
            {{"op":"define_component","name":"row","component":{{"params":[{{"name":"gap","type":"number","default":300}}],
              "layers":[{{"id":"one","type":"use","comp":"chip","params":{{"w":"$gap"}}}},
                        {{"id":"two","type":"use","comp":"chip","x":"$gap","params":{{"tint":"primary"}}}}]}}}},
            {{"op":"add_layer","layer":{{"id":"r","type":"use","comp":"row","x":100,"y":100}}}}]"#
        ));
        let sh = shapes(&s.frame(0.5));
        assert_eq!(sh.len(), 2);
        assert_eq!((sh[0].size[0], sh[1].center[0]), (300.0, 400.0));
        let layout = s.layout(0.5);
        let ids: Vec<&str> = layout.layers.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["r", "r/one", "r/one/bg", "r/one/txt", "r/two", "r/two/bg", "r/two/txt"]);
        let two_bg = s.layer_bounds("r/two/bg", 0.5).unwrap();
        assert_eq!(two_bg.center, [400.0, 100.0]);
        assert_eq!(s.pick(0.5, 400.0, 100.0).as_deref(), Some("r"), "picking selects the instance");
        assert_eq!(s.resolve_layer("r/two/bg").map(|l| l.id.as_str()), Some("bg"));

        let cyc = r#"{"op":"define_component","name":"chip","component":{"layers":[{"id":"x","type":"use","comp":"row"}]}}"#;
        let err = s.apply(&[serde_json::from_str(cyc).unwrap()]).unwrap_err();
        assert!(err.1.to_string().contains("contain itself"), "{}", err.1);
        let typo = r#"{"op":"add_layer","layer":{"id":"q","type":"use","comp":"chip","params":{"tittle":"x"}}}"#;
        assert!(s.apply(&[serde_json::from_str(typo).unwrap()]).unwrap_err().1.to_string().contains("no param 'tittle'"));
        let undeclared = r#"{"op":"define_component","name":"z","component":{"layers":[{"id":"a","type":"shape","shape":"rect","w":"$nope","h":1}]}}"#;
        assert!(s.apply(&[serde_json::from_str(undeclared).unwrap()]).unwrap_err().1.to_string().contains("'$nope'"));
        let remove = r#"{"op":"remove_component","name":"chip"}"#;
        assert!(s.apply(&[serde_json::from_str(remove).unwrap()]).unwrap_err().1.to_string().contains("component 'row'"));
    }

    #[test]
    fn inside_a_component_t_is_its_clock_and_ids_read_siblings() {
        let s = scene(
            r#"[{"op":"define_component","name":"pair","component":{"layers":[
                {"id":"lead","type":"shape","shape":"rect","w":10,"h":10,"x":"T*100"},
                {"id":"tail","type":"shape","shape":"rect","w":10,"h":10,"x":"lead.x(T - 0.5)","y":50,"effects":[{"fx":"blur","radius":4}]}]}},
              {"op":"add_layer","layer":{"id":"p","type":"use","comp":"pair","start":2,"x":0,"y":0}},
              {"op":"add_layer","layer":{"id":"lead","type":"shape","shape":"rect","w":1,"h":1,"x":999}}]"#,
        );
        let sh = shapes(&s.frame(3.0));
        // Component clock 1 s: the lead is at 100, the tail reads the sibling half a second back.
        assert_eq!(sh[0].center[0], 100.0);
        assert_eq!(sh[1].center[0], 50.0);
        assert!(s.frame(3.0).iter().any(|i| matches!(i, DrawItem::Fx(_))), "child effects are kept");
        let row = s.layout(3.0).layers.into_iter().find(|r| r.id == "p/tail").unwrap();
        assert_eq!(row.screen, [45.0, 45.0, 55.0, 55.0]);
    }

    #[test]
    fn redefining_updates_every_instance_and_round_trips() {
        let mut s = scene(&format!(
            r#"[{CHIP},{{"op":"add_layer","layer":{{"id":"a","type":"use","comp":"chip","x":100,"y":100}}}},
               {{"op":"add_layer","layer":{{"id":"b","type":"use","comp":"chip","x":500,"y":100}}}}]"#
        ));
        assert_eq!(shapes(&s.frame(0.5))[0].size[0], 200.0);
        let redefine = CHIP.replace(r#""default":200"#, r#""default":50"#);
        s.apply(&[serde_json::from_str(&redefine).unwrap()]).unwrap();
        assert!(shapes(&s.frame(0.5)).iter().all(|sh| sh.size[0] == 50.0));
        let again = Scene::from_json(&s.to_json()).unwrap();
        assert_eq!(again, s);
        assert_eq!(shapes(&again.frame(0.5)).len(), 2);
        assert!(s.summary().contains("use chip") && s.summary().contains("component chip 3s: params [w:number tint:color label:text show:bool]"), "{}", s.summary());
        // Breaking params in use is refused and names the instance.
        let broken = CHIP.replace(r##"{"name":"tint","type":"color","default":"#ff0000"},"##, "").replace(r#""fill":"$tint","#, "");
        let mut with_tint = s.clone();
        with_tint
            .apply(&[serde_json::from_str(r#"{"op":"add_layer","layer":{"id":"c","type":"use","comp":"chip","params":{"tint":"text"}}}"#).unwrap()])
            .unwrap();
        let err = with_tint.apply(&[serde_json::from_str(&broken).unwrap()]).unwrap_err();
        assert!(err.1.to_string().contains("breaks instance 'c'"), "{}", err.1);
    }

    #[test]
    fn parents_and_mattes_inside_a_component_name_its_own_layers() {
        let s = scene(
            r#"[{"op":"define_component","name":"knob","component":{"layers":[
                {"id":"arm","type":"shape","shape":"rect","w":10,"h":10,"x":100,"rotation":90},
                {"id":"tip","type":"shape","shape":"ellipse","w":10,"h":10,"x":50,"parent":"arm"},
                {"id":"hole","type":"shape","shape":"rect","w":4,"h":4,"visible":false},
                {"id":"plate","type":"shape","shape":"rect","w":40,"h":40,"y":200,"matte":{"layer":"hole"}}]}},
              {"op":"add_layer","layer":{"id":"k","type":"use","comp":"knob","x":500,"y":500}},
              {"op":"add_layer","layer":{"id":"arm","type":"shape","shape":"rect","w":1,"h":1,"x":900}}]"#,
        );
        let items = s.frame(0.5);
        let sh = shapes(&items);
        // The tip follows the component's own arm (rotated 90°), not the scene layer 'arm'.
        assert!((sh[1].center[0] - 600.0).abs() < 1e-3 && (sh[1].center[1] - 550.0).abs() < 1e-3, "{:?}", sh[1].center);
        let matte = items.iter().find_map(|i| match i {
            DrawItem::Fx(fx) => fx.matte.as_ref(),
            _ => None,
        });
        assert_eq!(matte.map(|(m, _)| shapes(m)[0].size), Some([4.0, 4.0]), "the matte is the sibling 'hole'");
    }

    #[test]
    fn instance_repeaters_and_opacity_reach_the_layers() {
        let s = scene(&format!(
            r#"[{CHIP},{{"op":"add_layer","layer":{{"id":"a","type":"use","comp":"chip","x":100,"y":100,"opacity":0.5,
               "repeat":{{"count":3,"x":300}},"params":{{"w":"100 + i*50"}}}}}}]"#
        ));
        let sh = shapes(&s.frame(0.5));
        assert_eq!(sh.iter().map(|s| (s.center[0], s.size[0])).collect::<Vec<_>>(), [(100.0, 100.0), (400.0, 150.0), (700.0, 200.0)]);
        assert!(sh.iter().all(|s| (s.color.0[3] - 0.5).abs() < 1e-3));
    }
}
