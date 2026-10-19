//! Vector paths from SVG path data (`d`), flattened to polylines, with trim (draw-on) like
//! After Effects' Trim Paths. Coordinates are relative to the layer's position.

/// A flattened subpath.
#[derive(Debug, Clone, PartialEq)]
pub struct Polyline {
    pub points: Vec<[f32; 2]>,
    pub closed: bool,
}

/// Segments per curve, scaled by its rough length.
const CURVE_STEP_PX: f32 = 6.0;
const MIN_CURVE_SEGMENTS: usize = 6;
const MAX_CURVE_SEGMENTS: usize = 96;

/// Parse and flatten SVG path data: M L H V C S Q T A Z (absolute and relative).
pub fn parse(d: &str) -> Result<Vec<Polyline>, String> {
    let toks = tokenize(d)?;
    let mut out: Vec<Polyline> = Vec::new();
    let mut cur = [0.0f32; 2];
    let mut start = [0.0f32; 2];
    let mut last_ctrl: Option<[f32; 2]> = None;
    let mut last_cmd = b'M';
    let mut i = 0;
    let mut cmd = 0u8;
    let num = |i: &mut usize| -> Result<f32, String> {
        match toks.get(*i) {
            Some(Tok::Num(n)) => {
                *i += 1;
                Ok(*n)
            }
            _ => Err("expected a number in path data".into()),
        }
    };
    let flag = |i: &mut usize| -> Result<bool, String> { num(i).map(|v| v != 0.0) };
    while i < toks.len() {
        if let Tok::Cmd(c) = toks[i] {
            cmd = c;
            i += 1;
        } else if cmd == 0 {
            return Err("path data must start with a command (M)".into());
        }
        if out.is_empty() && !matches!(cmd, b'M' | b'm') {
            return Err("path data must start with M".into());
        }
        let rel = cmd.is_ascii_lowercase();
        let base = if rel { cur } else { [0.0, 0.0] };
        let up = cmd.to_ascii_uppercase();
        let mut ctrl: Option<[f32; 2]> = None;
        match up {
            b'M' => {
                let p = [base[0] + num(&mut i)?, base[1] + num(&mut i)?];
                out.push(Polyline { points: vec![p], closed: false });
                cur = p;
                start = p;
                // Further pairs after M are implicit L.
                cmd = if rel { b'l' } else { b'L' };
            }
            b'L' => {
                let p = [base[0] + num(&mut i)?, base[1] + num(&mut i)?];
                push(&mut out, cur, p);
                cur = p;
            }
            b'H' => {
                let x = num(&mut i)? + if rel { cur[0] } else { 0.0 };
                let p = [x, cur[1]];
                push(&mut out, cur, p);
                cur = p;
            }
            b'V' => {
                let y = num(&mut i)? + if rel { cur[1] } else { 0.0 };
                let p = [cur[0], y];
                push(&mut out, cur, p);
                cur = p;
            }
            b'C' | b'S' => {
                let c1 = if up == b'C' {
                    [base[0] + num(&mut i)?, base[1] + num(&mut i)?]
                } else {
                    reflect(cur, last_ctrl.filter(|_| matches!(last_cmd, b'C' | b'S')))
                };
                let c2 = [base[0] + num(&mut i)?, base[1] + num(&mut i)?];
                let p = [base[0] + num(&mut i)?, base[1] + num(&mut i)?];
                cubic(&mut out, cur, c1, c2, p);
                ctrl = Some(c2);
                cur = p;
            }
            b'Q' | b'T' => {
                let c = if up == b'Q' {
                    [base[0] + num(&mut i)?, base[1] + num(&mut i)?]
                } else {
                    reflect(cur, last_ctrl.filter(|_| matches!(last_cmd, b'Q' | b'T')))
                };
                let p = [base[0] + num(&mut i)?, base[1] + num(&mut i)?];
                // Quadratic as cubic.
                let c1 = [cur[0] + 2.0 / 3.0 * (c[0] - cur[0]), cur[1] + 2.0 / 3.0 * (c[1] - cur[1])];
                let c2 = [p[0] + 2.0 / 3.0 * (c[0] - p[0]), p[1] + 2.0 / 3.0 * (c[1] - p[1])];
                cubic(&mut out, cur, c1, c2, p);
                ctrl = Some(c);
                cur = p;
            }
            b'A' => {
                let (rx, ry, rot) = (num(&mut i)?, num(&mut i)?, num(&mut i)?);
                let (large, sweep) = (flag(&mut i)?, flag(&mut i)?);
                let p = [base[0] + num(&mut i)?, base[1] + num(&mut i)?];
                arc(&mut out, cur, rx, ry, rot, large, sweep, p);
                cur = p;
            }
            b'Z' => {
                if let Some(pl) = out.last_mut() {
                    pl.closed = true;
                    if pl.points.last() != Some(&start) {
                        pl.points.push(start);
                    }
                }
                cur = start;
                // Z takes no numbers; a following number must be preceded by a command.
                cmd = 0;
            }
            _ => return Err(format!("unsupported path command '{}'", up as char)),
        }
        last_ctrl = ctrl;
        last_cmd = up;
    }
    Ok(out.into_iter().filter(|p| p.points.len() > 1).collect())
}

fn reflect(cur: [f32; 2], ctrl: Option<[f32; 2]>) -> [f32; 2] {
    ctrl.map_or(cur, |c| [2.0 * cur[0] - c[0], 2.0 * cur[1] - c[1]])
}

fn push(out: &mut Vec<Polyline>, from: [f32; 2], p: [f32; 2]) {
    if out.is_empty() {
        out.push(Polyline { points: vec![from], closed: false });
    }
    out.last_mut().unwrap().points.push(p);
}

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

fn cubic(out: &mut Vec<Polyline>, p0: [f32; 2], c1: [f32; 2], c2: [f32; 2], p3: [f32; 2]) {
    let rough = dist(p0, c1) + dist(c1, c2) + dist(c2, p3);
    let n = ((rough / CURVE_STEP_PX) as usize).clamp(MIN_CURVE_SEGMENTS, MAX_CURVE_SEGMENTS);
    for k in 1..=n {
        let t = k as f32 / n as f32;
        let u = 1.0 - t;
        let p = [
            u * u * u * p0[0] + 3.0 * u * u * t * c1[0] + 3.0 * u * t * t * c2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3.0 * u * u * t * c1[1] + 3.0 * u * t * t * c2[1] + t * t * t * p3[1],
        ];
        push(out, p0, p);
    }
}

/// SVG elliptical arc (endpoint parameterization → center), flattened.
#[allow(clippy::too_many_arguments)]
fn arc(out: &mut Vec<Polyline>, p0: [f32; 2], rx: f32, ry: f32, rot_deg: f32, large: bool, sweep: bool, p1: [f32; 2]) {
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx < 1e-4 || ry < 1e-4 || dist(p0, p1) < 1e-4 {
        push(out, p0, p1);
        return;
    }
    let phi = rot_deg.to_radians();
    let (s, c) = phi.sin_cos();
    let dx = (p0[0] - p1[0]) / 2.0;
    let dy = (p0[1] - p1[1]) / 2.0;
    let x1 = c * dx + s * dy;
    let y1 = -s * dx + c * dy;
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        rx *= lambda.sqrt();
        ry *= lambda.sqrt();
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut k = (num / den).max(0.0).sqrt();
    if large == sweep {
        k = -k;
    }
    let cx1 = k * rx * y1 / ry;
    let cy1 = -k * ry * x1 / rx;
    let cx = c * cx1 - s * cy1 + (p0[0] + p1[0]) / 2.0;
    let cy = s * cx1 + c * cy1 + (p0[1] + p1[1]) / 2.0;
    let ang = |ux: f32, uy: f32| uy.atan2(ux);
    let a0 = ang((x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut da = ang((-x1 - cx1) / rx, (-y1 - cy1) / ry) - a0;
    if sweep && da < 0.0 {
        da += std::f32::consts::TAU;
    } else if !sweep && da > 0.0 {
        da -= std::f32::consts::TAU;
    }
    let n = ((da.abs() * rx.max(ry) / CURVE_STEP_PX) as usize).clamp(MIN_CURVE_SEGMENTS, MAX_CURVE_SEGMENTS);
    for i in 1..=n {
        let a = a0 + da * i as f32 / n as f32;
        let (sa, ca) = a.sin_cos();
        push(out, p0, [cx + c * rx * ca - s * ry * sa, cy + s * rx * ca + c * ry * sa]);
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Tok {
    Cmd(u8),
    Num(f32),
}

fn tokenize(d: &str) -> Result<Vec<Tok>, String> {
    let b = d.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() || c == b',' {
            i += 1;
        } else if b"MmLlHhVvCcSsQqTtAaZz".contains(&c) {
            out.push(Tok::Cmd(c));
            i += 1;
        } else if c == b'-' || c == b'+' || c == b'.' || c.is_ascii_digit() {
            let start = i;
            i += 1;
            let mut dot = c == b'.';
            while i < b.len() {
                let ch = b[i];
                if ch.is_ascii_digit() {
                    i += 1;
                } else if ch == b'.' && !dot {
                    dot = true;
                    i += 1;
                } else if (ch == b'e' || ch == b'E') && i + 1 < b.len() {
                    i += 1;
                    if b[i] == b'-' || b[i] == b'+' {
                        i += 1;
                    }
                } else {
                    break;
                }
            }
            let s = std::str::from_utf8(&b[start..i]).unwrap();
            out.push(Tok::Num(s.parse().map_err(|_| format!("bad number '{s}' in path"))?));
        } else {
            return Err(format!("unexpected '{}' in path data", c as char));
        }
    }
    Ok(out)
}

/// Keep the part of the polylines between `start` and `end` (0..1 of the total length), shifted by
/// `offset` (wraps around). Trimming opens closed paths.
pub fn trim(lines: &[Polyline], start: f32, end: f32, offset: f32) -> Vec<Vec<[f32; 2]>> {
    let (mut a, mut b) = (start.clamp(0.0, 1.0), end.clamp(0.0, 1.0));
    if a > b {
        std::mem::swap(&mut a, &mut b);
    }
    if b - a >= 0.9999 && offset == 0.0 {
        return lines.iter().map(|l| l.points.clone()).collect();
    }
    if b - a <= 1e-5 {
        return Vec::new();
    }
    let total: f32 = lines.iter().map(|l| length(&l.points)).sum();
    if total <= 0.0 {
        return Vec::new();
    }
    let a = (a + offset).rem_euclid(1.0) * total;
    let span = (b - start.clamp(0.0, 1.0).min(end.clamp(0.0, 1.0))) * total;
    let b = a + span;
    // A window that wraps past the end is two windows.
    let windows: Vec<(f32, f32)> = if b > total { vec![(a, total), (0.0, b - total)] } else { vec![(a, b)] };
    let mut out = Vec::new();
    for (wa, wb) in windows {
        let mut acc = 0.0;
        for l in lines {
            let len = length(&l.points);
            let (la, lb) = (wa - acc, wb - acc);
            if lb > 0.0 && la < len {
                out.push(slice(&l.points, la.max(0.0), lb.min(len)));
            }
            acc += len;
        }
    }
    out.into_iter().filter(|p| p.len() > 1).collect()
}

fn length(p: &[[f32; 2]]) -> f32 {
    p.windows(2).map(|w| dist(w[0], w[1])).sum()
}

fn slice(p: &[[f32; 2]], from: f32, to: f32) -> Vec<[f32; 2]> {
    let mut out = Vec::new();
    let mut acc = 0.0;
    for w in p.windows(2) {
        let seg = dist(w[0], w[1]);
        let (s0, s1) = (acc, acc + seg);
        let lerp = |d: f32| {
            let u = if seg > 0.0 { ((d - s0) / seg).clamp(0.0, 1.0) } else { 0.0 };
            [w[0][0] + (w[1][0] - w[0][0]) * u, w[0][1] + (w[1][1] - w[0][1]) * u]
        };
        if s1 >= from && s0 <= to {
            if out.is_empty() {
                out.push(lerp(from.max(s0)));
            }
            out.push(lerp(to.min(s1)));
        }
        acc = s1;
        if acc > to {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lines_curves_arcs_and_closes() {
        let p = parse("M0 0 L100 0 L100 100 Z").unwrap();
        assert_eq!(p.len(), 1);
        assert!(p[0].closed);
        assert_eq!(p[0].points.first(), p[0].points.last());
        let c = parse("M0,0 C 50,-50 150,50 200,0 s 50 50 100 0").unwrap();
        assert!(c[0].points.len() > 12);
        assert_eq!(*c[0].points.last().unwrap(), [300.0, 0.0]);
        let a = parse("M 0 0 A 50 50 0 0 1 100 0").unwrap();
        let mid = a[0].points[a[0].points.len() / 2];
        assert!(mid[1] < -40.0, "semicircle bulges up: {mid:?}");
        let rel = parse("m10 10 h20 v20 h-20 z m100 0 l10 10").unwrap();
        assert_eq!(rel.len(), 2);
        assert_eq!(rel[1].points[0], [110.0, 10.0]);
        assert!(parse("L 10 10").is_err());
        assert!(parse("M0 0 X 1").is_err());
    }

    #[test]
    fn trims_by_length() {
        let p = parse("M0 0 L100 0").unwrap();
        let half = trim(&p, 0.0, 0.5, 0.0);
        assert_eq!(half, vec![vec![[0.0, 0.0], [50.0, 0.0]]]);
        assert!(trim(&p, 0.3, 0.3, 0.0).is_empty());
        let wrapped = trim(&p, 0.0, 0.4, 0.8);
        assert_eq!(wrapped.len(), 2, "window past the end wraps");
    }
}
