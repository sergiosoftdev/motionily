//! Expressions: any animatable number can be a formula, like After Effects expressions.
//!
//! `"540 + 40*sin(t*3)"`, `"wiggle(2, 12)"`, `"200 + i*90"`, `"lerp(0, 1, ease(t/0.6))"`.
//! Variables: `t` (seconds since the layer started), `T` (scene seconds), `i` / `n` (copy index and
//! count inside a repeater), `pi`. Functions: sin cos tan asin acos atan atan2 abs sign floor ceil
//! round fract sqrt pow exp log min max clamp lerp mix smoothstep step mod noise rand wiggle ease
//! ease_in ease_out back elastic bounce spring pulse saw tri.
//! Other layers: `card.x`, `card.y(T - 0.2)` (at another scene time: delays, echoes, follow
//! through); properties x y w h scale rotation opacity (s r o for short).
//! Component params: `$value` inside a component's layers (see component.rs).
//! Parsed once and cached; a malformed expression evaluates to 0 (and `check` reports why).

use std::cell::Cell;
use std::sync::OnceLock;

thread_local! {
    /// Extra variables for the expression being sampled: (scene time, copy index, copy count).
    static VARS: Cell<(f32, f32, f32)> = const { Cell::new((0.0, 0.0, 1.0)) };
}

/// A property another layer's expression can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prop {
    X,
    Y,
    W,
    H,
    Scale,
    Rotation,
    Opacity,
}

impl Prop {
    fn parse(s: &str) -> Option<Prop> {
        Some(match s {
            "x" => Prop::X,
            "y" => Prop::Y,
            "w" => Prop::W,
            "h" => Prop::H,
            "s" | "scale" => Prop::Scale,
            "r" | "rotation" => Prop::Rotation,
            "o" | "opacity" => Prop::Opacity,
            _ => return None,
        })
    }
}

/// Reads `layer.prop` at a scene time.
pub type Resolver<'a> = dyn Fn(&str, Prop, f32) -> f32 + 'a;

/// Layer references deeper than this (a reads b reads a…) give 0.
const MAX_REF_DEPTH: u8 = 8;

thread_local! {
    static RESOLVER: Cell<Option<*const Resolver<'static>>> = const { Cell::new(None) };
    static REF_DEPTH: Cell<u8> = const { Cell::new(0) };
}

/// Run `f` with layer references resolved by `r` (outside, they read 0).
pub fn with_resolver<R>(r: &Resolver<'_>, f: impl FnOnce() -> R) -> R {
    // SAFETY: the pointer only lives in the thread-local for the duration of `f`, during which
    // `r` is borrowed; it is restored before returning (also on unwind via the guard).
    let ptr: *const Resolver<'static> = unsafe { std::mem::transmute(r as *const Resolver<'_>) };
    struct Restore(Option<*const Resolver<'static>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            RESOLVER.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(RESOLVER.with(|c| c.replace(Some(ptr))));
    f()
}

fn resolve_ref(layer: &str, prop: Prop, gt: f32) -> f32 {
    let Some(ptr) = RESOLVER.with(|c| c.get()) else { return 0.0 };
    let depth = REF_DEPTH.with(|d| d.get());
    if depth >= MAX_REF_DEPTH {
        return 0.0;
    }
    REF_DEPTH.with(|d| d.set(depth + 1));
    // SAFETY: see `with_resolver` — set only while the resolver is alive.
    let v = unsafe { (*ptr)(layer, prop, gt) };
    REF_DEPTH.with(|d| d.set(depth));
    v
}

// ── components: `$name` reads a number param of the instance being drawn ──────────────
thread_local! {
    static PARAMS: Cell<Option<*const [(String, f32)]>> = const { Cell::new(None) };
}

/// Run `f` with `$name` reading `params` (a component instance's number params, already sampled).
/// Each instance sees only its own params; outside every instance `$name` reads 0.
pub fn with_params<R>(params: &[(String, f32)], f: impl FnOnce() -> R) -> R {
    struct Restore(Option<*const [(String, f32)]>);
    impl Drop for Restore {
        fn drop(&mut self) {
            PARAMS.with(|c| c.set(self.0));
        }
    }
    // SAFETY: the pointer only lives in the thread-local while `params` is borrowed by this call;
    // the previous value is restored before returning (also on unwind via the guard).
    let _restore = Restore(PARAMS.with(|c| c.replace(Some(params as *const [(String, f32)]))));
    f()
}

fn param(name: &str) -> f32 {
    let Some(ptr) = PARAMS.with(|c| c.get()) else { return 0.0 };
    // SAFETY: see `with_params` — set only while the slice is alive.
    unsafe { &*ptr }.iter().find(|(n, _)| n == name).map_or(0.0, |(_, v)| *v)
}
// ── end components ──────────────────────────────────────────────────────────────────────

/// Run `f` with scene time `gt` and repeater copy `i` of `n` visible to expressions.
pub fn with_vars<R>(gt: f32, i: f32, n: f32, f: impl FnOnce() -> R) -> R {
    let prev = VARS.with(|v| v.replace((gt, i, n)));
    let r = f();
    VARS.with(|v| v.set(prev));
    r
}

/// Set the scene time for everything sampled from here on (the frame loop calls it once).
pub fn set_scene_time(gt: f32) {
    VARS.with(|v| {
        let (_, i, n) = v.get();
        v.set((gt, i, n));
    });
}

/// The scene time expressions currently see (`T`; custom shaders receive it too).
pub fn scene_time() -> f32 {
    VARS.with(|v| v.get().0)
}

/// Run `f` with expressions seeing scene time `gt` (copy index and count kept), then restore it.
pub fn with_scene_time<R>(gt: f32, f: impl FnOnce() -> R) -> R {
    let prev = VARS.with(|v| v.get());
    VARS.with(|v| v.set((gt, prev.1, prev.2)));
    let r = f();
    VARS.with(|v| v.set(prev));
    r
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Num(f32),
    Var(Var),
    Neg(Box<Node>),
    Bin(Op, Box<Node>, Box<Node>),
    Call(Func, Vec<Node>),
    /// Another layer's property, at the current scene time or at the given one.
    Ref(String, Prop, Option<Box<Node>>),
    /// `$name`: a number param of the component instance being drawn.
    Param(String),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Var {
    T,
    SceneT,
    I,
    N,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Pow,
    Lt,
    Gt,
}

macro_rules! funcs {
    ($($name:ident => $text:literal / $arity:expr),* $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq)]
        #[allow(non_camel_case_types)]
        enum Func { $($name),* }
        impl Func {
            fn parse(s: &str) -> Option<(Func, std::ops::RangeInclusive<usize>)> {
                match s { $($text => Some((Func::$name, $arity)),)* _ => None }
            }
        }
    };
}

funcs! {
    sin => "sin" / 1..=1, cos => "cos" / 1..=1, tan => "tan" / 1..=1, asin => "asin" / 1..=1,
    acos => "acos" / 1..=1, atan => "atan" / 1..=1, atan2 => "atan2" / 2..=2, abs => "abs" / 1..=1,
    sign => "sign" / 1..=1, floor => "floor" / 1..=1, ceil => "ceil" / 1..=1, round => "round" / 1..=1,
    fract => "fract" / 1..=1, sqrt => "sqrt" / 1..=1, pow => "pow" / 2..=2, exp => "exp" / 1..=1,
    log => "log" / 1..=1, min => "min" / 2..=8, max => "max" / 2..=8, clamp => "clamp" / 3..=3,
    lerp => "lerp" / 3..=3, mix => "mix" / 3..=3, smoothstep => "smoothstep" / 3..=3, step => "step" / 2..=2,
    modulo => "mod" / 2..=2, noise => "noise" / 1..=2, rand => "rand" / 1..=1, wiggle => "wiggle" / 2..=3,
    ease => "ease" / 1..=1, ease_in => "ease_in" / 1..=1, ease_out => "ease_out" / 1..=1, back => "back" / 1..=1,
    elastic => "elastic" / 1..=1, bounce => "bounce" / 1..=1, spring => "spring" / 1..=3, pulse => "pulse" / 2..=2,
    saw => "saw" / 1..=1, tri => "tri" / 1..=1,
}

/// A parsed formula. Serialized as its source text.
#[derive(Debug, Default)]
pub struct Expr {
    pub src: String,
    compiled: OnceLock<Result<Node, String>>,
}

impl Clone for Expr {
    fn clone(&self) -> Self {
        Expr::new(self.src.clone())
    }
}

impl PartialEq for Expr {
    fn eq(&self, other: &Self) -> bool {
        self.src == other.src
    }
}

impl Expr {
    pub fn new(src: String) -> Self {
        Expr { src, compiled: OnceLock::new() }
    }

    fn compiled(&self) -> &Result<Node, String> {
        self.compiled.get_or_init(|| Parser::new(&self.src).parse())
    }

    /// Why this expression does not parse, if it doesn't.
    pub fn check(&self) -> Result<(), String> {
        self.compiled().as_ref().map(|_| ()).map_err(|e| format!("expression '{}': {e}", self.src))
    }

    pub fn eval(&self, t: f32) -> f32 {
        match self.compiled() {
            Ok(node) => {
                let v = VARS.with(|v| v.get());
                let r = eval(node, t, v);
                if r.is_finite() { r } else { 0.0 }
            }
            Err(_) => 0.0,
        }
    }
}

fn eval(n: &Node, t: f32, vars @ (gt, i, cnt): (f32, f32, f32)) -> f32 {
    let e = |n: &Node| eval(n, t, vars);
    match n {
        Node::Num(v) => *v,
        Node::Var(Var::T) => t,
        Node::Var(Var::SceneT) => gt,
        Node::Var(Var::I) => i,
        Node::Var(Var::N) => cnt,
        Node::Neg(a) => -e(a),
        Node::Ref(layer, prop, at) => {
            let when = at.as_ref().map_or(gt, |a| e(a));
            resolve_ref(layer, *prop, when)
        }
        Node::Param(name) => param(name),
        Node::Bin(op, a, b) => {
            let (a, b) = (e(a), e(b));
            match op {
                Op::Add => a + b,
                Op::Sub => a - b,
                Op::Mul => a * b,
                Op::Div => a / b,
                Op::Rem => a.rem_euclid(b),
                Op::Pow => a.powf(b),
                Op::Lt => (a < b) as u8 as f32,
                Op::Gt => (a > b) as u8 as f32,
            }
        }
        Node::Call(f, args) => {
            let a: Vec<f32> = args.iter().map(e).collect();
            let x = a[0];
            let arg = |k: usize, d: f32| a.get(k).copied().unwrap_or(d);
            match f {
                Func::sin => x.sin(),
                Func::cos => x.cos(),
                Func::tan => x.tan(),
                Func::asin => x.clamp(-1.0, 1.0).asin(),
                Func::acos => x.clamp(-1.0, 1.0).acos(),
                Func::atan => x.atan(),
                Func::atan2 => x.atan2(a[1]),
                Func::abs => x.abs(),
                Func::sign => x.signum(),
                Func::floor => x.floor(),
                Func::ceil => x.ceil(),
                Func::round => x.round(),
                Func::fract => x.fract(),
                Func::sqrt => x.max(0.0).sqrt(),
                Func::pow => x.powf(a[1]),
                Func::exp => x.exp(),
                Func::log => x.max(1e-9).ln(),
                Func::min => a.iter().copied().fold(f32::INFINITY, f32::min),
                Func::max => a.iter().copied().fold(f32::NEG_INFINITY, f32::max),
                Func::clamp => x.clamp(a[1].min(a[2]), a[2].max(a[1])),
                Func::lerp | Func::mix => x + (a[1] - x) * a[2],
                Func::smoothstep => {
                    let u = ((a[2] - x) / (a[1] - x)).clamp(0.0, 1.0);
                    u * u * (3.0 - 2.0 * u)
                }
                Func::step => (a[1] >= x) as u8 as f32,
                Func::modulo => x.rem_euclid(a[1]),
                Func::noise => noise(x + arg(1, 0.0) * 31.7),
                Func::rand => hash(x),
                // wiggle(freq, amp[, seed]): smooth random drift around 0, different per repeater copy.
                Func::wiggle => noise(t * x + 17.0 * (i + arg(2, 0.0)) + 3.1) * a[1],
                Func::ease => {
                    let u = x.clamp(0.0, 1.0);
                    if u < 0.5 { 4.0 * u * u * u } else { 1.0 - (-2.0 * u + 2.0).powi(3) / 2.0 }
                }
                Func::ease_in => x.clamp(0.0, 1.0).powi(3),
                Func::ease_out => 1.0 - (1.0 - x.clamp(0.0, 1.0)).powi(3),
                Func::back => crate::Easing::Back.apply(x),
                Func::elastic => crate::Easing::Elastic.apply(x),
                Func::bounce => crate::Easing::Bounce.apply(x),
                // spring(t, freq = 4, damping = 6): settles from 0 to 1 with overshoot.
                Func::spring => {
                    let (f, d) = (arg(1, 4.0), arg(2, 6.0));
                    if x <= 0.0 { 0.0 } else { 1.0 - (-d * x).exp() * (std::f32::consts::TAU * f * x).cos() }
                }
                Func::pulse => (x.rem_euclid(a[1].max(1e-3)) < a[1] * 0.5) as u8 as f32,
                Func::saw => x.fract(),
                Func::tri => 1.0 - (x.fract() * 2.0 - 1.0).abs(),
            }
        }
    }
}

/// Deterministic pseudo-random in [0, 1).
fn hash(x: f32) -> f32 {
    let s = (x * 127.1 + 311.7).sin() * 43758.547;
    s - s.floor()
}

/// Smooth 1D value noise in [-1, 1].
fn noise(x: f32) -> f32 {
    let i = x.floor();
    let f = x - i;
    let u = f * f * (3.0 - 2.0 * f);
    let (a, b) = (hash(i) * 2.0 - 1.0, hash(i + 1.0) * 2.0 - 1.0);
    a + (b - a) * u
}

struct Parser<'a> {
    s: &'a [u8],
    p: usize,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str) -> Self {
        Parser { s: s.as_bytes(), p: 0 }
    }

    fn parse(mut self) -> Result<Node, String> {
        let n = self.cmp()?;
        self.ws();
        if self.p < self.s.len() {
            return Err(format!("unexpected '{}' at {}", self.s[self.p] as char, self.p));
        }
        Ok(n)
    }

    fn ws(&mut self) {
        while self.p < self.s.len() && self.s[self.p].is_ascii_whitespace() {
            self.p += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        self.ws();
        if self.s.get(self.p) == Some(&c) {
            self.p += 1;
            true
        } else {
            false
        }
    }

    fn cmp(&mut self) -> Result<Node, String> {
        let mut l = self.add()?;
        loop {
            let op = if self.eat(b'<') {
                Op::Lt
            } else if self.eat(b'>') {
                Op::Gt
            } else {
                return Ok(l);
            };
            l = Node::Bin(op, Box::new(l), Box::new(self.add()?));
        }
    }

    fn add(&mut self) -> Result<Node, String> {
        let mut l = self.mul()?;
        loop {
            let op = if self.eat(b'+') {
                Op::Add
            } else if self.eat(b'-') {
                Op::Sub
            } else {
                return Ok(l);
            };
            l = Node::Bin(op, Box::new(l), Box::new(self.mul()?));
        }
    }

    fn mul(&mut self) -> Result<Node, String> {
        let mut l = self.unary()?;
        loop {
            let op = if self.eat(b'*') {
                Op::Mul
            } else if self.eat(b'/') {
                Op::Div
            } else if self.eat(b'%') {
                Op::Rem
            } else {
                return Ok(l);
            };
            l = Node::Bin(op, Box::new(l), Box::new(self.unary()?));
        }
    }

    fn unary(&mut self) -> Result<Node, String> {
        if self.eat(b'-') {
            return Ok(Node::Neg(Box::new(self.unary()?)));
        }
        if self.eat(b'+') {
            return self.unary();
        }
        let base = self.atom()?;
        if self.eat(b'^') {
            return Ok(Node::Bin(Op::Pow, Box::new(base), Box::new(self.unary()?)));
        }
        Ok(base)
    }

    fn atom(&mut self) -> Result<Node, String> {
        self.ws();
        if self.eat(b'(') {
            let n = self.cmp()?;
            if !self.eat(b')') {
                return Err("missing ')'".into());
            }
            return Ok(n);
        }
        let start = self.p;
        let c = *self.s.get(self.p).ok_or("unexpected end")?;
        if c == b'$' {
            // Component param: `$value` (letters, digits, _; not starting with a digit).
            self.p += 1;
            let from = self.p;
            while self.p < self.s.len() && (self.s[self.p].is_ascii_alphanumeric() || self.s[self.p] == b'_') {
                self.p += 1;
            }
            let name = std::str::from_utf8(&self.s[from..self.p]).unwrap();
            if name.is_empty() || name.as_bytes()[0].is_ascii_digit() {
                return Err(format!("expected a param name after '$' at {start}"));
            }
            return Ok(Node::Param(name.to_owned()));
        }
        if c.is_ascii_digit() || c == b'.' {
            while self.p < self.s.len() && (self.s[self.p].is_ascii_digit() || self.s[self.p] == b'.') {
                self.p += 1;
            }
            if self.p < self.s.len() && (self.s[self.p] == b'e' || self.s[self.p] == b'E') {
                self.p += 1;
                if self.p < self.s.len() && (self.s[self.p] == b'-' || self.s[self.p] == b'+') {
                    self.p += 1;
                }
                while self.p < self.s.len() && self.s[self.p].is_ascii_digit() {
                    self.p += 1;
                }
            }
            let text = std::str::from_utf8(&self.s[start..self.p]).unwrap();
            return text.parse().map(Node::Num).map_err(|_| format!("bad number '{text}'"));
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            while self.p < self.s.len() && (self.s[self.p].is_ascii_alphanumeric() || self.s[self.p] == b'_') {
                self.p += 1;
            }
            let name = std::str::from_utf8(&self.s[start..self.p]).unwrap();
            if self.s.get(self.p) == Some(&b'.') {
                self.p += 1;
                let pstart = self.p;
                while self.p < self.s.len() && self.s[self.p].is_ascii_alphabetic() {
                    self.p += 1;
                }
                let pname = std::str::from_utf8(&self.s[pstart..self.p]).unwrap();
                let prop = Prop::parse(pname).ok_or_else(|| format!("unknown property '{name}.{pname}' (x y w h scale rotation opacity)"))?;
                let at = if self.eat(b'(') {
                    let n = self.cmp()?;
                    if !self.eat(b')') {
                        return Err("missing ')'".into());
                    }
                    Some(Box::new(n))
                } else {
                    None
                };
                return Ok(Node::Ref(name.to_owned(), prop, at));
            }
            if self.eat(b'(') {
                let (f, arity) = Func::parse(name).ok_or_else(|| format!("unknown function '{name}'"))?;
                let mut args = Vec::new();
                if !self.eat(b')') {
                    loop {
                        args.push(self.cmp()?);
                        if self.eat(b')') {
                            break;
                        }
                        if !self.eat(b',') {
                            return Err(format!("expected ',' or ')' in {name}()"));
                        }
                    }
                }
                if !arity.contains(&args.len()) {
                    return Err(format!("{name}() takes {}..{} arguments", arity.start(), arity.end()));
                }
                return Ok(Node::Call(f, args));
            }
            return Ok(match name {
                "t" | "time" => Node::Var(Var::T),
                "T" => Node::Var(Var::SceneT),
                "i" | "index" => Node::Var(Var::I),
                "n" | "count" => Node::Var(Var::N),
                "pi" | "PI" => Node::Num(std::f32::consts::PI),
                "tau" => Node::Num(std::f32::consts::TAU),
                _ => return Err(format!("unknown variable '{name}' (use t, T, i, n, pi)")),
            });
        }
        Err(format!("unexpected '{}' at {}", c as char, self.p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str, t: f32) -> f32 {
        let e = Expr::new(s.into());
        e.check().unwrap();
        e.eval(t)
    }

    #[test]
    fn arithmetic_precedence_and_functions() {
        assert_eq!(ev("1 + 2 * 3", 0.0), 7.0);
        assert_eq!(ev("(1 + 2) * 3", 0.0), 9.0);
        assert_eq!(ev("-2^2", 0.0), -4.0);
        assert_eq!(ev("540 + 100*t", 2.0), 740.0);
        assert!((ev("sin(pi/2)", 0.0) - 1.0).abs() < 1e-6);
        assert_eq!(ev("clamp(t, 0, 1)", 3.0), 1.0);
        assert_eq!(ev("lerp(10, 20, 0.5)", 0.0), 15.0);
        assert_eq!(ev("max(1, 5, 3)", 0.0), 5.0);
    }

    #[test]
    fn repeater_vars_and_wiggle() {
        let e = Expr::new("200 + i*90".into());
        assert_eq!(with_vars(0.0, 3.0, 5.0, || e.eval(0.0)), 470.0);
        let w = Expr::new("wiggle(2, 10)".into());
        let a = with_vars(0.0, 0.0, 2.0, || w.eval(0.37));
        let b = with_vars(0.0, 1.0, 2.0, || w.eval(0.37));
        assert!(a.abs() <= 10.0 && a != b, "wiggle is bounded and differs per copy");
    }

    #[test]
    fn reports_errors() {
        assert!(Expr::new("1 +".into()).check().is_err());
        assert!(Expr::new("foo(1)".into()).check().unwrap_err().contains("unknown function"));
        assert!(Expr::new("x".into()).check().unwrap_err().contains("unknown variable"));
        assert_eq!(Expr::new("1 +".into()).eval(0.0), 0.0);
    }
}
