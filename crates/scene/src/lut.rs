//! Color lookup tables (`.cube`, the Adobe/Resolve format): the color effect's `lut` maps every pixel
//! through one, like a film emulation or a camera's Log-to-Rec.709 conversion.

/// A 3D LUT: `size`³ output colors, red changing fastest, then green, then blue (the `.cube` order,
/// and a 3D texture's x, y, z).
#[derive(Debug, Clone, PartialEq)]
pub struct Lut {
    pub size: u32,
    pub data: Vec<[f32; 3]>,
}

/// 3D size a 1D LUT is baked into.
const BAKED_SIZE: u32 = 33;
const MAX_3D: u32 = 129;

/// Key the engine stores a LUT under (the scene's color effects name it by `src`).
pub fn lut_key(src: &str) -> u64 {
    // FNV-1a: stable across the web and native engines, never 0 for a real src.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in src.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h.max(1)
}

impl Lut {
    /// Parse a `.cube` file (3D, or 1D baked into 3D). Inputs outside DOMAIN 0..1 are not supported.
    pub fn parse_cube(text: &str) -> Result<Lut, String> {
        let (mut size3, mut size1) = (None, None);
        let mut rows: Vec<[f32; 3]> = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.split_whitespace();
            let first = parts.next().unwrap_or_default();
            match first {
                "TITLE" | "LUT_3D_INPUT_RANGE" | "LUT_1D_INPUT_RANGE" => continue,
                "LUT_3D_SIZE" => size3 = parts.next().and_then(|v| v.parse::<u32>().ok()),
                "LUT_1D_SIZE" => size1 = parts.next().and_then(|v| v.parse::<u32>().ok()),
                "DOMAIN_MIN" | "DOMAIN_MAX" => {
                    let want = if first == "DOMAIN_MIN" { 0.0 } else { 1.0 };
                    let v: Vec<f32> = parts.filter_map(|p| p.parse().ok()).collect();
                    if v.len() != 3 || v.iter().any(|x| (x - want).abs() > 1e-4) {
                        return Err(format!("{first} other than {want} is not supported"));
                    }
                }
                _ => {
                    let v: Vec<f32> = std::iter::once(first).chain(parts).map(|p| p.parse::<f32>()).collect::<Result<_, _>>().map_err(|_| format!("not a .cube line: {line}"))?;
                    if v.len() != 3 {
                        return Err(format!("a .cube row has 3 numbers: {line}"));
                    }
                    rows.push([v[0], v[1], v[2]]);
                }
            }
        }
        match (size3, size1) {
            (Some(n), _) => {
                if !(2..=MAX_3D).contains(&n) {
                    return Err(format!("LUT_3D_SIZE must be 2..{MAX_3D}"));
                }
                if rows.len() != (n * n * n) as usize {
                    return Err(format!("LUT_3D_SIZE {n} needs {} rows, the file has {}", n * n * n, rows.len()));
                }
                Ok(Lut { size: n, data: rows })
            }
            (None, Some(n)) => {
                if n < 2 || rows.len() != n as usize {
                    return Err(format!("LUT_1D_SIZE {n} needs {n} rows, the file has {}", rows.len()));
                }
                let at = |c: usize, x: f32| {
                    let f = x * (n - 1) as f32;
                    let i = (f.floor() as usize).min(n as usize - 2);
                    let k = f - i as f32;
                    rows[i][c] * (1.0 - k) + rows[i + 1][c] * k
                };
                let s = BAKED_SIZE;
                let mut data = Vec::with_capacity((s * s * s) as usize);
                for b in 0..s {
                    for g in 0..s {
                        for r in 0..s {
                            let v = |i: u32| i as f32 / (s - 1) as f32;
                            data.push([at(0, v(r)), at(1, v(g)), at(2, v(b))]);
                        }
                    }
                }
                Ok(Lut { size: s, data })
            }
            _ => Err("no LUT_3D_SIZE or LUT_1D_SIZE line: not a .cube file".into()),
        }
    }

    /// RGBA half floats for a 3D texture.
    pub fn rgba_f16(&self) -> Vec<u16> {
        self.data.iter().flat_map(|c| [f16(c[0]), f16(c[1]), f16(c[2]), f16(1.0)]).collect()
    }
}

/// f32 to IEEE half (round to nearest; LUT values are small and finite).
fn f16(v: f32) -> u16 {
    let x = v.to_bits();
    let sign = ((x >> 16) & 0x8000) as u16;
    let exp = ((x >> 23) & 0xff) as i32 - 127 + 15;
    let mant = x & 0x7f_ffff;
    if exp <= 0 {
        if exp < -10 {
            return sign;
        }
        let m = (mant | 0x80_0000) >> (1 - exp);
        return sign | ((m + 0x1000) >> 13) as u16;
    }
    if exp >= 31 {
        return sign | 0x7c00;
    }
    let h = sign as u32 | ((exp as u32) << 10) | (mant >> 13);
    // Round half up on the dropped bits.
    (h + ((mant >> 12) & 1)) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_3d_and_bakes_1d() {
        let cube = "TITLE \"swap\"\n# red and blue swapped\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n";
        let lut = Lut::parse_cube(cube).unwrap();
        assert_eq!(lut.size, 2);
        assert_eq!(lut.data[1], [0.0, 0.0, 1.0]);
        let one = Lut::parse_cube("LUT_1D_SIZE 2\n0 0 0\n0.5 1 1\n").unwrap();
        assert_eq!(one.size, 33);
        assert_eq!(*one.data.last().unwrap(), [0.5, 1.0, 1.0]);
        assert!(Lut::parse_cube("LUT_3D_SIZE 2\n0 0 0\n").is_err());
        assert!(Lut::parse_cube("LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n").is_err());
        assert_eq!(f16(1.0), 0x3c00);
        assert_eq!(f16(0.5), 0x3800);
        assert_eq!(f16(0.0), 0);
        assert_ne!(lut_key("/media/a.cube"), lut_key("/media/b.cube"));
    }
}
