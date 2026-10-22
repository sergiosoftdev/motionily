//! Custom GPU shaders the agent writes ("no ceiling"): a `shader` layer fills its box with the
//! agent's WGSL, and the `shader` effect rewrites a layer's (or, on an adjustment layer, the whole
//! frame's) pixels. The agent writes only `fn shade(uv: vec2f, px: vec2f) -> vec4f`; a fixed
//! prelude (`shader/*.wgsl`) gives it time, params, the palette and helpers, and the entry points.
//!
//! Code is validated here (naga: WGSL → module → validator → GLSL ES 3.0 for the WebGL2 fallback)
//! when an op adds it, so a broken shader is an op error with its line, never a GPU crash. The
//! engine compiles one pipeline per (stage, code hash).

use crate::{Animated, Layer, LayerContent};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

/// Longest shader code accepted (bytes of the agent's part, prelude excluded).
pub const MAX_CODE_BYTES: usize = 8192;
/// Animatable params `p0..p7`.
pub const MAX_PARAMS: usize = 8;
/// Most iterations one `for` loop may run (bounds must be literals or `const`s).
pub const MAX_LOOP_ITERATIONS: u32 = 64;
/// Most iterations of nested loops together (product along a nesting chain).
pub const MAX_NESTED_ITERATIONS: u32 = 256;

const COMMON: &str = include_str!("shader/common.wgsl");
const LAYER: &str = include_str!("shader/layer.wgsl");
const EFFECT: &str = include_str!("shader/effect.wgsl");
/// Where the agent's code goes inside a stage file.
const MARKER: &str = "//@shade\n";
/// Tint (WebGPU) rejects derivatives (`fwidth`, `fill`) in non-uniform control flow; naga does
/// not check it. Turning the diagnostic off keeps both compilers agreeing.
const DIRECTIVE: &str = "diagnostic(off, derivative_uniformity);\n";

/// Which prelude the code is compiled with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShaderStage {
    /// `shader` layer content: fills the layer box.
    Layer,
    /// `{"fx":"shader"}`: rewrites the layer's own pixels, read with `src(uv)`.
    Effect,
}

/// The agent's WGSL, hashed once (pipelines are cached by this hash).
#[derive(Clone)]
pub struct ShaderCode {
    src: Arc<str>,
    hash: u64,
}

impl ShaderCode {
    pub fn new(src: impl Into<Arc<str>>) -> Self {
        let src = src.into();
        let hash = fnv1a(src.as_bytes());
        ShaderCode { src, hash }
    }

    pub fn as_str(&self) -> &str {
        &self.src
    }

    /// Stable FNV-1a hash of the code.
    pub fn hash(&self) -> u64 {
        self.hash
    }
}

impl std::fmt::Debug for ShaderCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ShaderCode({:016x}, {} bytes)", self.hash, self.src.len())
    }
}

impl PartialEq for ShaderCode {
    fn eq(&self, o: &Self) -> bool {
        self.hash == o.hash && self.src == o.src
    }
}

impl Serialize for ShaderCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.src)
    }
}

/// Loading never validates (a saved scene always opens); ops do (see `check_layer`).
impl<'de> Deserialize<'de> for ShaderCode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(ShaderCode::new(String::deserialize(d)?))
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x0000_0100_0000_01b3))
}

/// Params sampled at layer time `lt` (missing ones are 0).
pub fn sample_params(params: &[Animated], lt: f32) -> [f32; MAX_PARAMS] {
    let mut out = [0.0; MAX_PARAMS];
    for (slot, p) in out.iter_mut().zip(params) {
        *slot = p.sample(lt);
    }
    out
}

/// A shader layer for one frame (the engine draws its box with the compiled pipeline).
#[derive(Debug, Clone, PartialEq)]
pub struct DrawShader {
    pub code: ShaderCode,
    /// On-screen box (scene px), rotation (rad), corner radius (drawn px), opacity 0..1.
    pub center: [f32; 2],
    pub size: [f32; 2],
    pub rotation: f32,
    pub radius: f32,
    pub opacity: f32,
    /// The layer's own `w`×`h` (what `px` spans), unchanged by scale, parents and the camera.
    pub box_size: [f32; 2],
    /// Layer time (after time remap) and scene time.
    pub time: f32,
    pub scene_time: f32,
    pub params: [f32; MAX_PARAMS],
    /// The layer's fill color (straight alpha, without opacity).
    pub fill: crate::Rgba,
}

/// Why a shader was rejected; `line`/`column` are in the agent's code (1-based).
#[derive(Debug, Clone, PartialEq)]
pub struct ShaderError {
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
}

impl ShaderError {
    fn at(line: u32, message: impl Into<String>) -> Self {
        ShaderError { line: Some(line), column: None, message: message.into() }
    }

    fn plain(message: impl Into<String>) -> Self {
        ShaderError { line: None, column: None, message: message.into() }
    }
}

impl std::fmt::Display for ShaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (self.line, self.column) {
            (Some(l), Some(c)) => write!(f, "WGSL line {l}:{c}: {}", self.message),
            (Some(l), None) => write!(f, "WGSL line {l}: {}", self.message),
            _ => f.write_str(&self.message),
        }
    }
}

fn stage_file(stage: ShaderStage) -> (&'static str, &'static str) {
    let file = match stage {
        ShaderStage::Layer => LAYER,
        ShaderStage::Effect => EFFECT,
    };
    file.split_once(MARKER).expect("stage files carry the //@shade marker")
}

fn prefix(stage: ShaderStage) -> String {
    let (head, _) = stage_file(stage);
    format!("{DIRECTIVE}{head}{COMMON}\n// ---- agent code ----\n")
}

/// The full WGSL module the GPU compiles: directive, stage bindings, prelude, the agent's code,
/// entry points (`mly_vs` / `mly_fs`).
pub fn module_source(stage: ShaderStage, code: &str) -> String {
    let (_, entry) = stage_file(stage);
    format!("{}{code}\n{entry}", prefix(stage))
}

thread_local! {
    /// Verdicts by (stage, code hash): re-adding a layer does not re-run naga.
    static VERDICTS: RefCell<HashMap<(ShaderStage, u64), Result<(), ShaderError>>> = RefCell::new(HashMap::new());
}
const MAX_VERDICTS: usize = 256;

/// Validate the agent's code for `stage` exactly as the GPU will see it (cached by hash).
pub fn check(stage: ShaderStage, code: &ShaderCode) -> Result<(), ShaderError> {
    let key = (stage, code.hash());
    if let Some(v) = VERDICTS.with(|c| c.borrow().get(&key).cloned()) {
        return v;
    }
    let verdict = check_source(stage, code.as_str());
    VERDICTS.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= MAX_VERDICTS {
            c.clear();
        }
        c.insert(key, verdict.clone());
    });
    verdict
}

fn check_source(stage: ShaderStage, code: &str) -> Result<(), ShaderError> {
    if code.trim().is_empty() {
        return Err(ShaderError::plain("the shader code is empty: write fn shade(uv: vec2f, px: vec2f) -> vec4f { … }"));
    }
    if code.len() > MAX_CODE_BYTES {
        return Err(ShaderError::plain(format!("shader code is {} bytes; the limit is {MAX_CODE_BYTES}", code.len())));
    }
    lint(code)?;
    compile(stage, code)
}

/// Parse, validate and translate to GLSL ES 3.0 with naga (what wgpu does on both backends).
fn compile(stage: ShaderStage, code: &str) -> Result<(), ShaderError> {
    let src = module_source(stage, code);
    let offset = prefix(stage).matches('\n').count() as u32;
    let lines = code.lines().count().max(1) as u32;
    // Errors carry several labelled spans (some undefined, some in the prelude): point at the
    // first one inside the agent's code and quote its label.
    let locate = |message: String, labels: Vec<(naga::Span, &str)>| {
        let inside = labels.iter().find_map(|(span, label)| {
            let l = span.location(&src);
            (span.is_defined() && l.line_number > offset && l.line_number <= offset + lines).then_some((l, *label))
        });
        let message = polish(&message);
        match inside {
            Some((l, label)) => {
                let label = if label.starts_with("naga::") { "" } else { label };
                let message = if label.is_empty() || message.contains(label) { message } else { format!("{message} ({label})") };
                ShaderError { line: Some(l.line_number - offset), column: Some(l.line_position), message }
            }
            // Past the agent's code (unclosed brace, missing or misshapen `shade`) or in the prelude.
            None => ShaderError::plain(format!("{message} (found outside your code: check braces, and define exactly fn shade(uv: vec2f, px: vec2f) -> vec4f)")),
        }
    };
    let module = naga::front::wgsl::parse_str(&src).map_err(|e| locate(e.message().to_owned(), e.labels().collect()))?;
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
        .validate(&module)
        .map_err(|e| {
            let mut message = e.to_string();
            let mut cause = std::error::Error::source(&e);
            while let Some(c) = cause {
                message.push_str(": ");
                message.push_str(&c.to_string());
                cause = c.source();
            }
            // Innermost context first: it names the expression that is wrong.
            let mut labels: Vec<(naga::Span, &str)> = e.spans().map(|(span, label)| (*span, label.as_str())).collect();
            labels.reverse();
            locate(message, labels)
        })?;
    check_glsl(&module, &info)
}

/// The WebGL2 fallback runs the same module as GLSL ES 3.0 (what wgpu's GL backend translates).
#[cfg(feature = "glsl-check")]
fn check_glsl(module: &naga::Module, info: &naga::valid::ModuleInfo) -> Result<(), ShaderError> {
    let options = naga::back::glsl::Options { version: naga::back::glsl::Version::Embedded { version: 300, is_webgl: true }, ..Default::default() };
    for (stage, entry) in [(naga::ShaderStage::Vertex, "mly_vs"), (naga::ShaderStage::Fragment, "mly_fs")] {
        let pipeline = naga::back::glsl::PipelineOptions { shader_stage: stage, entry_point: entry.into(), multiview: None };
        let mut out = String::new();
        naga::back::glsl::Writer::new(&mut out, module, info, &options, &pipeline, Default::default())
            .and_then(|mut w| w.write())
            .map_err(|e| ShaderError::plain(format!("does not translate to WebGL2 (GLSL ES 3.0): {e}")))?;
    }
    Ok(())
}

#[cfg(not(feature = "glsl-check"))]
fn check_glsl(_: &naga::Module, _: &naga::valid::ModuleInfo) -> Result<(), ShaderError> {
    Ok(())
}

/// GLSL / Shadertoy habits that are not WGSL, with what to write instead.
const HINTS: [(&str, &str); 11] = [
    ("`mod`", "WGSL has no mod(): use wrap(x, y) from the prelude (floor modulo)"),
    ("`float`", "use f32"),
    ("`int`", "use i32"),
    ("`lerp`", "use mix"),
    ("`frac`", "use fract"),
    ("`saturate`", "use clamp(x, 0.0, 1.0)"),
    ("`iTime`", "use t (layer seconds) or T (scene seconds)"),
    ("`iResolution`", "use size (px of the area uv spans)"),
    ("`fragCoord`", "use px (the second argument of shade)"),
    ("`texture`", "effects read pixels with src(uv); layers have no textures"),
    ("`atan`", "atan takes one argument; use atan2(y, x)"),
];

/// naga's messages minus IR noise (function/expression indices), plus hints for common slips.
fn polish(message: &str) -> String {
    let mut m = message.to_owned();
    for prefix in ["Function [", "Expression ["] {
        while let Some(at) = m.find(prefix) {
            let Some(end) = m[at..].find("is invalid: ").map(|e| at + e + "is invalid: ".len()) else { break };
            m.replace_range(at..end, "");
        }
    }
    if m.contains("Float") && m.contains("Sint") {
        m.push_str(" — mixing f32 and i32: convert with f32(x) or write float literals like 1.0");
    }
    if m.starts_with("redefinition of") {
        m.push_str(" — the prelude already defines it: use it, or pick another name");
    }
    for (what, hint) in HINTS {
        if m.contains(what) {
            m.push_str(" — ");
            m.push_str(hint);
            break;
        }
    }
    m
}

/// Check a layer's shader content and shader effects (what `add_layer` runs).
pub fn check_layer(layer: &Layer) -> Result<(), String> {
    if let LayerContent::Shader { code, params } = &layer.content {
        if params.len() > MAX_PARAMS {
            return Err(format!("shader layer '{}': at most {MAX_PARAMS} params (p0..p7), got {}", layer.id, params.len()));
        }
        check(ShaderStage::Layer, code).map_err(|e| format!("shader layer '{}': {e}", layer.id))?;
    }
    for e in layer.effects.iter().map(|s| &s.effect) {
        if let crate::paint::Effect::Shader { code, params } = e {
            if params.len() > MAX_PARAMS {
                return Err(format!("shader effect on '{}': at most {MAX_PARAMS} params (p0..p7), got {}", layer.id, params.len()));
            }
            check(ShaderStage::Effect, code).map_err(|e| format!("shader effect on '{}': {e}", layer.id))?;
        }
    }
    Ok(())
}

/// Every shader in a layer, with the prelude it compiles against.
pub fn layer_codes(layer: &Layer) -> impl Iterator<Item = (ShaderStage, &ShaderCode)> {
    let content = match &layer.content {
        LayerContent::Shader { code, .. } => Some((ShaderStage::Layer, code)),
        _ => None,
    };
    let effects = layer.effects.iter().map(|s| &s.effect).filter_map(|e| match e {
        crate::paint::Effect::Shader { code, .. } => Some((ShaderStage::Effect, code)),
        _ => None,
    });
    content.into_iter().chain(effects)
}

// ---- Static checks the GPU cannot make for us (hangs) or that would confuse naga's messages ----

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Num(String),
    Punct(&'static str),
    Other(char),
}

const PUNCT: [&str; 26] = [
    "<<=", ">>=", "->", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "<<", ">>", "<", ">", "=", "+", "-", "*",
    "/", "@",
];

/// Comments blanked (newlines kept, so lines still count), then split into tokens with their line.
fn lex(code: &str) -> Vec<(Tok, u32)> {
    let chars: Vec<char> = code.chars().collect();
    let mut clean = String::with_capacity(code.len());
    let (mut i, mut block) = (0, 0u32);
    while i < chars.len() {
        let (c, next) = (chars[i], chars.get(i + 1).copied());
        if block > 0 {
            if c == '*' && next == Some('/') {
                block -= 1;
                clean.push_str("  ");
                i += 2;
            } else if c == '/' && next == Some('*') {
                block += 1;
                clean.push_str("  ");
                i += 2;
            } else {
                clean.push(if c == '\n' { '\n' } else { ' ' });
                i += 1;
            }
        } else if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                clean.push(' ');
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            block += 1;
            clean.push_str("  ");
            i += 2;
        } else {
            clean.push(c);
            i += 1;
        }
    }
    let s: Vec<char> = clean.chars().collect();
    let mut out = Vec::new();
    let (mut i, mut line) = (0, 1u32);
    while i < s.len() {
        let c = s[i];
        if c == '\n' {
            line += 1;
            i += 1;
        } else if c.is_whitespace() {
            i += 1;
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < s.len() && (s[i].is_alphanumeric() || s[i] == '_') {
                i += 1;
            }
            out.push((Tok::Ident(s[start..i].iter().collect()), line));
        } else if c.is_ascii_digit() || (c == '.' && s.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let start = i;
            while i < s.len() {
                let d = s[i];
                let exp_sign = (d == '+' || d == '-') && matches!(s[i - 1], 'e' | 'E') && !s[start..i].iter().any(|x| *x == 'x' || *x == 'X');
                if d.is_ascii_alphanumeric() || d == '.' || exp_sign {
                    i += 1;
                } else {
                    break;
                }
            }
            out.push((Tok::Num(s[start..i].iter().collect()), line));
        } else if let Some(p) = PUNCT.iter().find(|p| s[i..].iter().take(p.len()).copied().eq(p.chars())) {
            out.push((Tok::Punct(*p), line));
            i += p.len();
        } else {
            out.push((Tok::Other(c), line));
            i += 1;
        }
    }
    out
}

/// A number literal or `const` value: (value, integer?).
fn literal(s: &str) -> Option<(f64, bool)> {
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return Some((i64::from_str_radix(hex.trim_end_matches(['i', 'u']), 16).ok()? as f64, true));
    }
    let float = s.contains(['.', 'e', 'E', 'f', 'h']);
    let v = s.trim_end_matches(['i', 'u', 'f', 'h']).parse::<f64>().ok()?;
    Some((v, !float))
}

fn lint(code: &str) -> Result<(), ShaderError> {
    let toks = lex(code);
    let ident = |k: usize| match toks.get(k) {
        Some((Tok::Ident(s), _)) => Some(s.as_str()),
        _ => None,
    };
    // Module-level and local `const NAME [: T] = [-]NUMBER;` values, usable as loop bounds.
    let mut consts: HashMap<&str, (f64, bool)> = HashMap::new();
    for k in 0..toks.len() {
        if ident(k) != Some("const") {
            continue;
        }
        let Some(name) = ident(k + 1) else { continue };
        let mut j = k + 2;
        if toks.get(j).is_some_and(|t| t.0 == Tok::Other(':')) {
            j += 2;
        }
        if toks.get(j).is_none_or(|t| t.0 != Tok::Punct("=")) {
            continue;
        }
        let neg = toks.get(j + 1).is_some_and(|t| t.0 == Tok::Punct("-"));
        if let Some((Tok::Num(n), _)) = toks.get(j + 1 + neg as usize) {
            if let Some((v, int)) = literal(n) {
                consts.insert(name, (if neg { -v } else { v }, int));
            }
        }
    }
    let mut has_shade = false;
    // Open loops: (brace depth of their body, iterations).
    let mut loops: Vec<(u32, u32)> = Vec::new();
    let mut depth = 0u32;
    let mut k = 0;
    while k < toks.len() {
        let (tok, line) = &toks[k];
        let line = *line;
        match tok {
            Tok::Other('{') => depth += 1,
            Tok::Other('}') => {
                loops.retain(|(d, _)| *d < depth);
                depth = depth.saturating_sub(1);
            }
            Tok::Ident(w) if w == "while" || w == "loop" => {
                return Err(ShaderError::at(line, format!("`{w}` is not allowed (it can hang the GPU): use `for (var i = 0; i < N; i++)` with N ≤ {MAX_LOOP_ITERATIONS} as a number or const")));
            }
            Tok::Ident(w) if w == "enable" || w == "requires" || w == "diagnostic" => {
                return Err(ShaderError::at(line, format!("`{w}` directives are not allowed: the prelude sets them")));
            }
            Tok::Ident(w) if w.starts_with("mly_") => {
                return Err(ShaderError::at(line, format!("`{w}`: names starting with mly_ are reserved for the prelude")));
            }
            Tok::Ident(w) if w == "fn" && ident(k + 1) == Some("shade") => has_shade = true,
            Tok::Ident(w) if w == "var" && toks.get(k + 1).is_some_and(|t| t.0 == Tok::Punct("<")) => {
                let space = ident(k + 2).unwrap_or_default();
                if space != "private" && space != "function" {
                    return Err(ShaderError::at(line, format!("`var<{space}>` is not allowed: shaders get no buffers or textures beyond the prelude's")));
                }
            }
            Tok::Punct("@") => {
                if let Some(attr) = ident(k + 1).filter(|a| matches!(*a, "group" | "binding" | "vertex" | "fragment" | "compute" | "workgroup_size")) {
                    return Err(ShaderError::at(line, format!("`@{attr}` is not allowed: the prelude declares the bindings and entry points; write only fn shade(uv: vec2f, px: vec2f) -> vec4f and helpers")));
                }
            }
            Tok::Ident(w) if w == "for" => {
                let (n, body) = for_loop(&toks, k, &consts).map_err(|why| ShaderError::at(line, why))?;
                let total = loops.iter().fold(n as u64, |acc, (_, m)| acc * *m as u64);
                if total > MAX_NESTED_ITERATIONS as u64 {
                    return Err(ShaderError::at(line, format!("nested loops run {total} iterations per pixel; the limit is {MAX_NESTED_ITERATIONS}")));
                }
                // The body's `{` is handled by the main loop: register the loop at its depth.
                loops.push((depth + 1, n));
                k = body;
                continue;
            }
            _ => {}
        }
        k += 1;
    }
    if !has_shade {
        return Err(ShaderError::plain("define fn shade(uv: vec2f, px: vec2f) -> vec4f (it returns the color for one pixel)"));
    }
    Ok(())
}

/// Iterations of the `for` at token `k` and the index of its body's `{`.
fn for_loop(toks: &[(Tok, u32)], k: usize, consts: &HashMap<&str, (f64, bool)>) -> Result<(u32, usize), String> {
    const SHAPE: &str = "write loops as for (var i = 0; i < N; i++) with N a number or const (also <=, >, >=, i--, i += K, i *= K)";
    if toks.get(k + 1).is_none_or(|t| t.0 != Tok::Other('(')) {
        return Err(SHAPE.into());
    }
    // Split the header at top-level `;`.
    let (mut parts, mut cur, mut nest, mut j) = (Vec::new(), Vec::new(), 0, k + 2);
    loop {
        let Some((tok, _)) = toks.get(j) else { return Err(SHAPE.into()) };
        match tok {
            Tok::Other('(') => nest += 1,
            Tok::Other(')') if nest == 0 => break,
            Tok::Other(')') => nest -= 1,
            Tok::Other(';') if nest == 0 => {
                parts.push(std::mem::take(&mut cur));
                j += 1;
                continue;
            }
            _ => {}
        }
        cur.push(tok.clone());
        j += 1;
    }
    parts.push(cur);
    let body = j + 1;
    if toks.get(body).is_none_or(|t| t.0 != Tok::Other('{')) || parts.len() != 3 {
        return Err(SHAPE.into());
    }
    let value = |t: &[Tok]| -> Option<(f64, bool)> {
        match t {
            [Tok::Num(n)] => literal(n),
            [Tok::Punct("-"), Tok::Num(n)] => literal(n).map(|(v, i)| (-v, i)),
            [Tok::Ident(c)] => consts.get(c.as_str()).copied(),
            _ => None,
        }
    };
    // init: [var|let] NAME [: TYPE] = VALUE
    let init = parts[0].as_slice();
    let init = match init.first() {
        Some(Tok::Ident(v)) if v == "var" || v == "let" => &init[1..],
        _ => init,
    };
    let (name, rest) = match init {
        [Tok::Ident(n), Tok::Other(':'), Tok::Ident(_), rest @ ..] | [Tok::Ident(n), rest @ ..] => (n.clone(), rest),
        _ => return Err(SHAPE.into()),
    };
    let (start, int) = match rest {
        [Tok::Punct("="), v @ ..] => value(v).ok_or(SHAPE)?,
        _ => return Err(SHAPE.into()),
    };
    let is = |t: &Tok| matches!(t, Tok::Ident(n) if *n == name);
    // cond: NAME OP VALUE or VALUE OP NAME
    let cond = parts[1].as_slice();
    let (op, bound, flipped) = match cond {
        [a, Tok::Punct(op), v @ ..] if is(a) => (*op, value(v).ok_or(SHAPE)?.0, false),
        [v @ .., Tok::Punct(op), b] if is(b) => (*op, value(v).ok_or(SHAPE)?.0, true),
        _ => return Err(SHAPE.into()),
    };
    let holds = |x: f64| {
        let (l, r) = if flipped { (bound, x) } else { (x, bound) };
        match op {
            "<" => l < r,
            "<=" => l <= r,
            ">" => l > r,
            ">=" => l >= r,
            "!=" => l != r,
            _ => false,
        }
    };
    if !matches!(op, "<" | "<=" | ">" | ">=" | "!=") {
        return Err(SHAPE.into());
    }
    // update: NAME++ | NAME-- | NAME op= VALUE | NAME = NAME op VALUE
    let upd = parts[2].as_slice();
    let (uop, step) = match upd {
        [a, Tok::Punct("++")] if is(a) => ("+", 1.0),
        [a, Tok::Punct("--")] if is(a) => ("-", 1.0),
        [a, Tok::Punct(op @ ("+=" | "-=" | "*=" | "/=")), v @ ..] if is(a) => (&op[..1], value(v).ok_or(SHAPE)?.0),
        [a, Tok::Punct("="), b, Tok::Punct(op @ ("+" | "-" | "*" | "/")), v @ ..] if is(a) && is(b) => (*op, value(v).ok_or(SHAPE)?.0),
        _ => return Err(SHAPE.into()),
    };
    let next = |x: f64| {
        let y = match uop {
            "+" => x + step,
            "-" => x - step,
            "*" => x * step,
            _ => x / step,
        };
        if int { y.trunc() } else { y }
    };
    let (mut x, mut n) = (start, 0u32);
    while holds(x) {
        n += 1;
        if n > MAX_LOOP_ITERATIONS {
            return Err(format!("this loop runs more than {MAX_LOOP_ITERATIONS} iterations (or never ends); keep loops ≤ {MAX_LOOP_ITERATIONS}"));
        }
        x = next(x);
    }
    Ok((n, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AURORA: &str = "fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let n = fbm3(vec3f(uv * 3.0, t * 0.2));\n  return vec4f(mix(background.rgb, primary.rgb, n), 1.0);\n}";

    #[test]
    fn prelude_compiles_for_both_stages() {
        check_source(ShaderStage::Layer, AURORA).unwrap();
        let fx = "fn shade(uv: vec2f, px: vec2f) -> vec4f { let c = src(uv + vec2f(sin(uv.y * 20.0 + T) * p0 / size.x, 0.0)); return c; }";
        check_source(ShaderStage::Effect, fx).unwrap();
        // `src` only exists for effects.
        assert!(check_source(ShaderStage::Layer, fx).is_err());
    }

    #[test]
    fn errors_point_at_the_agents_line() {
        let e = check_source(ShaderStage::Layer, "fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let a = 1.0;\n  return vec4f(nope, 1.0);\n}").unwrap_err();
        assert_eq!(e.line, Some(3), "{e}");
        assert!(e.message.contains("nope"), "{e}");
        let e = check_source(ShaderStage::Layer, "fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  return 1.0;\n}").unwrap_err();
        assert_eq!(e.line, Some(2), "type errors too: {e}");
        let e = check_source(ShaderStage::Layer, "fn shade(uv: vec2f) -> vec4f { return vec4f(1.0); }").unwrap_err();
        assert!(e.line.is_none() && e.message.contains("fn shade(uv: vec2f, px: vec2f)"), "{e}");
        assert!(check_source(ShaderStage::Layer, "fn paint() {}").unwrap_err().message.contains("define fn shade"));
    }

    #[test]
    fn loops_need_small_constant_bounds() {
        let ok = "const N = 16;\nfn shade(uv: vec2f, px: vec2f) -> vec4f {\n  var s = 0.0;\n  for (var i = 0; i < N; i++) {\n    for (var j: i32 = 8; j > 0; j -= 1) { s += 0.001; }\n  }\n  for (var k = 1.0; k <= 64.0; k *= 2.0) { s += k; }\n  return vec4f(s);\n}";
        check_source(ShaderStage::Layer, ok).unwrap();
        let big = ok.replace("const N = 16", "const N = 65");
        assert!(check_source(ShaderStage::Layer, &big).unwrap_err().message.contains("64"));
        let nested = ok.replace("const N = 16", "const N = 40");
        assert_eq!(check_source(ShaderStage::Layer, &nested).unwrap_err().line, Some(5), "40 × 8 > 256");
        let dynamic = "fn shade(uv: vec2f, px: vec2f) -> vec4f { var s = 0.0; for (var i = 0; i < i32(p0); i++) { s += 1.0; } return vec4f(s); }";
        assert!(check_source(ShaderStage::Layer, dynamic).is_err());
        let forever = "fn shade(uv: vec2f, px: vec2f) -> vec4f { var s = 0.0;\n while (s < 1.0) { s += 0.1; } return vec4f(s); }";
        assert_eq!(check_source(ShaderStage::Layer, forever).unwrap_err().line, Some(2));
        let backwards = "fn shade(uv: vec2f, px: vec2f) -> vec4f { var s = 0.0; for (var i = 0; i < 4; i--) { s += 1.0; } return vec4f(s); }";
        assert!(check_source(ShaderStage::Layer, backwards).is_err());
        // Comments do not count.
        let commented = "// while (true) {}\nfn shade(uv: vec2f, px: vec2f) -> vec4f { /* loop */ return vec4f(1.0); }";
        check_source(ShaderStage::Layer, commented).unwrap();
    }

    #[test]
    fn bindings_and_entry_points_are_rejected() {
        let e = check_source(ShaderStage::Layer, "@group(0) @binding(5) var<uniform> x: vec4f;\nfn shade(uv: vec2f, px: vec2f) -> vec4f { return x; }").unwrap_err();
        assert_eq!(e.line, Some(1));
        let long = format!("fn shade(uv: vec2f, px: vec2f) -> vec4f {{ return vec4f(1.0); }}\n{}", "// pad\n".repeat(MAX_CODE_BYTES / 7 + 1));
        assert!(check_source(ShaderStage::Layer, &long).unwrap_err().message.contains("limit"));
    }

    fn scene_with(layers: &[&str]) -> Result<crate::Scene, (usize, crate::OpError)> {
        let mut scene = crate::Scene { width: 1000, height: 1000, ..Default::default() };
        let ops: Vec<crate::Op> = layers.iter().map(|l| crate::Op::AddLayer { layer: serde_json::from_str(l).unwrap() }).collect();
        scene.apply(&ops)?;
        Ok(scene)
    }

    #[test]
    fn shader_layers_resolve_like_a_box() {
        let code = serde_json::to_string(AURORA).unwrap();
        let layer = format!(r#"{{"id":"sky","type":"shader","code":{code},"start":1,"x":500,"y":400,"w":200,"h":100,"scale":2,"radius":10,"params":[3,"T*2",[{{"t":0,"v":0}},{{"t":1,"v":10,"ease":"linear"}}]]}}"#);
        let scene = scene_with(&[&layer]).unwrap();
        let Some(crate::DrawItem::Shader(s)) = scene.frame(1.5).into_iter().next() else { panic!("expected a shader item") };
        assert_eq!((s.center, s.size, s.box_size, s.radius), ([500.0, 400.0], [400.0, 200.0], [200.0, 100.0], 20.0));
        assert_eq!((s.time, s.scene_time), (0.5, 1.5));
        assert_eq!(&s.params[..4], &[3.0, 3.0, 5.0, 0.0]);
        let b = scene.layer_bounds("sky", 1.5).unwrap();
        assert_eq!((b.center, b.size), ([500.0, 400.0], [400.0, 200.0]));
        // Round trip: the code is kept verbatim.
        let back: crate::Layer = serde_json::from_str(&scene.layer_json("sky").unwrap()).unwrap();
        assert_eq!(back, scene.layers[0]);
        assert!(scene.summary().contains("shader ("));
    }

    #[test]
    fn camera_depth_scales_the_box_not_the_pattern() {
        let code = serde_json::to_string(AURORA).unwrap();
        let scene = scene_with(&[
            &format!(r#"{{"id":"far","type":"shader","code":{code},"x":500,"y":500,"w":100,"h":100,"z":1800}}"#),
            r#"{"id":"cam","type":"shape","shape":"rect","x":500,"y":500,"w":1,"h":1,"visible":false,"camera":{"focal":1800}}"#,
        ])
        .unwrap();
        let Some(crate::DrawItem::Shader(s)) = scene.frame(0.0).into_iter().next() else { panic!() };
        assert_eq!((s.size, s.box_size), ([50.0, 50.0], [100.0, 100.0]));
        assert_eq!(scene.layer_bounds("far", 0.0).unwrap().size, [50.0, 50.0]);
    }

    #[test]
    fn broken_shaders_reject_the_whole_batch() {
        let bad = serde_json::to_string("fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  return vec4f(oops);\n}").unwrap();
        let ok = r#"{"id":"a","type":"shape","shape":"rect","w":10,"h":10}"#;
        let (i, e) = scene_with(&[ok, &format!(r#"{{"id":"glow","type":"shader","code":{bad},"w":10,"h":10}}"#)]).unwrap_err();
        assert_eq!(i, 1);
        assert!(matches!(e, crate::OpError::Shader(_)));
        assert!(e.to_string().starts_with("shader layer 'glow': WGSL line 2:"), "{e}");
        let fx = format!(r#"{{"id":"card","type":"shape","shape":"rect","w":10,"h":10,"effects":[{{"fx":"shader","code":{bad}}}]}}"#);
        assert!(scene_with(&[&fx]).unwrap_err().1.to_string().starts_with("shader effect on 'card': WGSL line 2:"));
        let many = format!(r#"{{"id":"p","type":"shader","code":{},"w":10,"h":10,"params":[0,0,0,0,0,0,0,0,0]}}"#, serde_json::to_string(AURORA).unwrap());
        assert!(scene_with(&[&many]).unwrap_err().1.to_string().contains("at most 8"));
    }

    #[test]
    fn shader_effects_run_offscreen_and_on_adjustment_layers() {
        let fx = serde_json::to_string("fn shade(uv: vec2f, px: vec2f) -> vec4f { return src(uv); }").unwrap();
        let scene = scene_with(&[
            &format!(r#"{{"id":"card","type":"shape","shape":"rect","x":500,"y":500,"w":100,"h":100,"effects":[{{"fx":"shader","code":{fx},"params":["t*2"]}}]}}"#),
            &format!(r#"{{"id":"grade","type":"shape","shape":"rect","x":500,"y":500,"w":1000,"h":1000,"adjustment":true,"effects":[{{"fx":"shader","code":{fx}}}]}}"#),
        ])
        .unwrap();
        let items = scene.frame(0.5);
        let hash = ShaderCode::new(serde_json::from_str::<String>(&fx).unwrap()).hash();
        let [crate::DrawItem::Fx(card), crate::DrawItem::Fx(grade)] = items.as_slice() else { panic!("{items:?}") };
        assert!(!card.adjust && grade.adjust);
        assert!(matches!(card.effects[0], crate::paint::DrawEffect::Shader { hash: h, params, time: 0.5, .. } if h == hash && params[0] == 1.0));
        let codes: Vec<_> = scene.shader_codes().map(|(stage, c)| (stage, c.hash())).collect();
        assert_eq!(codes, [(ShaderStage::Effect, hash), (ShaderStage::Effect, hash)]);
        scene.check_shaders().unwrap();
    }

    /// The quoted WGSL strings of one compact recipe line, with the stage each compiles for.
    fn recipe_codes(line: &str) -> Vec<(ShaderStage, String)> {
        let is_shader_layer = line.split_whitespace().nth(1) == Some("shader");
        let bytes = line.as_bytes();
        let (mut out, mut i) = (Vec::new(), 0);
        while i < bytes.len() {
            if bytes[i] != b'"' {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while bytes[j] != b'"' {
                j += if bytes[j] == b'\\' { 2 } else { 1 };
            }
            let text: String = serde_json::from_str(&line[i..=j]).unwrap();
            let stage = if line[..i].ends_with("fx=") {
                Some(ShaderStage::Effect)
            } else {
                (is_shader_layer && line[..i].ends_with(' ')).then_some(ShaderStage::Layer)
            };
            out.extend(stage.map(|s| (s, text)));
            i = j + 1;
        }
        out
    }

    #[test]
    fn every_documented_recipe_compiles() {
        let doc = include_str!("../../../docs/agent/syntax.md");
        let block = doc.split("<!-- custom-shaders:start -->").nth(1).and_then(|b| b.split("<!-- custom-shaders:end -->").next()).unwrap();
        let recipes = block.split("```").nth(1).unwrap();
        let mut n = 0;
        for line in recipes.lines().filter(|l| !l.trim().is_empty()) {
            for (stage, code) in recipe_codes(line) {
                check_source(stage, &code).unwrap_or_else(|e| panic!("{e}\nin: {line}"));
                n += 1;
            }
        }
        assert_eq!(n, 7, "every recipe line carries one shader");
    }

    #[test]
    fn hashes_are_stable() {
        assert_eq!(ShaderCode::new("abc").hash(), 0xe71fa2190541574b);
        assert_eq!(ShaderCode::new("x"), ShaderCode::new(String::from("x")));
    }

    #[test]
    fn messages_are_readable_and_hint_at_wgsl() {
        let msg = |code: &str| check_source(ShaderStage::Layer, code).unwrap_err().to_string();
        let m = msg("fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let m = mod(uv.x, 0.5);\n  return vec4f(m);\n}");
        assert!(m.starts_with("WGSL line 2:11:") && m.contains("wrap(x, y)"), "{m}");
        let m = msg("fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  let i = 3;\n  return vec4f(f32(i) * 0.5 + i);\n}");
        assert!(m.starts_with("WGSL line 3:") && m.contains("f32(x)") && !m.contains("Function ["), "{m}");
        let m = msg("fn hash21(q: vec2f) -> f32 { return 0.0; }\nfn shade(uv: vec2f, px: vec2f) -> vec4f { return vec4f(1.0); }");
        assert!(m.contains("prelude already defines"), "{m}");
        assert!(msg("fn shade(uv: vec2f, px: vec2f) -> vec4f {\n  return vec4f(1.0);\n").contains("check braces"));
    }
}
