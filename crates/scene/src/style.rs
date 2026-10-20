use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rgba(pub [f32; 4]);

impl Rgba {
    pub const fn hex(rgb: u32) -> Self {
        Rgba([
            ((rgb >> 16) & 0xff) as f32 / 255.0,
            ((rgb >> 8) & 0xff) as f32 / 255.0,
            (rgb & 0xff) as f32 / 255.0,
            1.0,
        ])
    }
}

/// Visual style of the whole video. The user picks it; the agent never has to
/// restate colors, because layers reference palette slots instead of values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StylePreset {
    #[default]
    Clean,
    Neon,
    Bold,
    Pastel,
}

impl StylePreset {
    pub const ALL: [StylePreset; 4] = [Self::Clean, Self::Neon, Self::Bold, Self::Pastel];

    pub fn palette(self) -> Palette {
        match self {
            StylePreset::Clean => Palette {
                background: Rgba::hex(0xf7f7f5),
                surface: Rgba::hex(0xffffff),
                primary: Rgba::hex(0x16a34a),
                accent: Rgba::hex(0x0ea5e9),
                text: Rgba::hex(0x111827),
            },
            StylePreset::Neon => Palette {
                background: Rgba::hex(0x0b0b1a),
                surface: Rgba::hex(0x1b1b3a),
                primary: Rgba::hex(0xff2bd6),
                accent: Rgba::hex(0x22f5ff),
                text: Rgba::hex(0xf5f5ff),
            },
            StylePreset::Bold => Palette {
                background: Rgba::hex(0xffd60a),
                surface: Rgba::hex(0x111111),
                primary: Rgba::hex(0xff3b30),
                accent: Rgba::hex(0x111111),
                text: Rgba::hex(0x111111),
            },
            StylePreset::Pastel => Palette {
                background: Rgba::hex(0xfdf2f8),
                surface: Rgba::hex(0xffffff),
                primary: Rgba::hex(0xa78bfa),
                accent: Rgba::hex(0xfbbf24),
                text: Rgba::hex(0x3b0764),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Palette {
    pub background: Rgba,
    pub surface: Rgba,
    pub primary: Rgba,
    pub accent: Rgba,
    pub text: Rgba,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaletteSlot {
    Background,
    Surface,
    Primary,
    Accent,
    Text,
    /// Whichever of the palette text, white or ink reads best on the background (WCAG contrast).
    OnBackground,
    /// Same, on the surface color.
    OnSurface,
    /// Same, on the primary color: text sitting on a primary pill or card.
    OnPrimary,
    /// Same, on the accent color.
    OnAccent,
}

/// A color is either a palette slot (preferred, follows the style) or a raw value.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ColorRef {
    Slot(PaletteSlot),
    Raw(Rgba),
    /// "#rrggbb" or "#rrggbbaa".
    Hex(HexColor),
}

impl Default for ColorRef {
    fn default() -> Self {
        ColorRef::Slot(PaletteSlot::Primary)
    }
}

impl ColorRef {
    pub fn resolve(self, p: &Palette) -> Rgba {
        match self {
            ColorRef::Raw(c) | ColorRef::Hex(HexColor(c)) => c,
            ColorRef::Slot(PaletteSlot::Background) => p.background,
            ColorRef::Slot(PaletteSlot::Surface) => p.surface,
            ColorRef::Slot(PaletteSlot::Primary) => p.primary,
            ColorRef::Slot(PaletteSlot::Accent) => p.accent,
            ColorRef::Slot(PaletteSlot::Text) => p.text,
            ColorRef::Slot(PaletteSlot::OnBackground) => readable_on(p.background, p),
            ColorRef::Slot(PaletteSlot::OnSurface) => readable_on(p.surface, p),
            ColorRef::Slot(PaletteSlot::OnPrimary) => readable_on(p.primary, p),
            ColorRef::Slot(PaletteSlot::OnAccent) => readable_on(p.accent, p),
        }
    }
}

/// The candidate with the highest WCAG contrast against `bg`: the palette's text color, white or
/// a near-black ink. Lets a text layer read on any palette color without anyone picking the ink.
pub fn readable_on(bg: Rgba, p: &Palette) -> Rgba {
    let ink = Rgba([0.07, 0.07, 0.1, 1.0]);
    let white = Rgba([1.0, 1.0, 1.0, 1.0]);
    [p.text, white, ink]
        .into_iter()
        .max_by(|a, b| contrast(*a, bg).total_cmp(&contrast(*b, bg)))
        .unwrap_or(ink)
}

/// WCAG contrast ratio of two colors (1 to 21), ignoring alpha.
pub fn contrast(a: Rgba, b: Rgba) -> f32 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// Relative luminance of an sRGB color (WCAG definition).
pub fn luminance(c: Rgba) -> f32 {
    let lin = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    let [r, g, b, _] = c.0;
    0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/// How captions are animated. Picked by the user, rendered by the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptionStyle {
    #[default]
    Minimal,
    Karaoke,
    PopWord,
    Highlight,
    Sticker,
}

impl CaptionStyle {
    pub const ALL: [CaptionStyle; 5] = [Self::Minimal, Self::Karaoke, Self::PopWord, Self::Highlight, Self::Sticker];
}

/// A `#rrggbb` color as written in brick payloads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HexColor(pub Rgba);

impl Serialize for HexColor {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let [r, g, b, a] = self.0 .0.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
        if a == 255 {
            s.serialize_str(&format!("#{r:02x}{g:02x}{b:02x}"))
        } else {
            s.serialize_str(&format!("#{r:02x}{g:02x}{b:02x}{a:02x}"))
        }
    }
}

impl<'de> Deserialize<'de> for HexColor {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let hex = s.strip_prefix('#').unwrap_or(&s);
        if hex.len() != 6 && hex.len() != 8 {
            return Err(serde::de::Error::custom(format!("expected #rrggbb or #rrggbbaa, got '{s}'")));
        }
        let v = u32::from_str_radix(&hex[..6], 16).map_err(serde::de::Error::custom)?;
        let mut c = Rgba::hex(v);
        if hex.len() == 8 {
            c.0[3] = u8::from_str_radix(&hex[6..], 16).map_err(serde::de::Error::custom)? as f32 / 255.0;
        }
        Ok(HexColor(c))
    }
}

/// Palette from a palette brick. Overrides the style preset's colors.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CustomPalette {
    pub background: HexColor,
    pub surface: HexColor,
    pub primary: HexColor,
    pub accent: HexColor,
    pub text: HexColor,
}

impl From<CustomPalette> for Palette {
    fn from(p: CustomPalette) -> Self {
        Palette {
            background: p.background.0,
            surface: p.surface.0,
            primary: p.primary.0,
            accent: p.accent.0,
            text: p.text.0,
        }
    }
}

/// Finish applied to the whole frame by the engine's post-processing pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderKind {
    #[default]
    Flat,
    SoftDepth,
    ToonOutline,
    CelAnime,
    PaperCut,
    IsoFlat,
}

impl RenderKind {
    pub const ALL: [RenderKind; 6] =
        [Self::Flat, Self::SoftDepth, Self::ToonOutline, Self::CelAnime, Self::PaperCut, Self::IsoFlat];
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RenderStyle {
    pub kind: RenderKind,
    /// Strength of the effect (shadow distance, outline width…). 1 = as designed.
    #[serde(default = "unit_amount")]
    pub amount: f32,
}

fn unit_amount() -> f32 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palette(primary: [f32; 4]) -> Palette {
        Palette {
            background: Rgba([0.95, 0.95, 0.93, 1.0]),
            surface: Rgba([1.0, 1.0, 1.0, 1.0]),
            primary: Rgba(primary),
            accent: Rgba([0.2, 0.5, 1.0, 1.0]),
            text: Rgba([0.1, 0.1, 0.12, 1.0]),
        }
    }

    #[test]
    fn on_tokens_pick_the_readable_ink_for_each_slot() {
        // Dark pill: white reads best, not the dark palette text.
        let dark = palette([0.07, 0.1, 0.3, 1.0]);
        let on_primary = ColorRef::Slot(PaletteSlot::OnPrimary).resolve(&dark);
        assert_eq!(on_primary, Rgba([1.0, 1.0, 1.0, 1.0]));
        // Light background: a dark ink reads best (the palette text or the near-black, both clear 4.5:1).
        let light = palette([1.0, 0.9, 0.2, 1.0]);
        let on_bg = ColorRef::Slot(PaletteSlot::OnBackground).resolve(&light);
        assert!(on_bg.0[0] < 0.2, "dark ink on a light background: {on_bg:?}");
        // The chosen color always clears the WCAG 4.5:1 text threshold on these palettes.
        for p in [&dark, &light] {
            for slot in [PaletteSlot::OnBackground, PaletteSlot::OnSurface, PaletteSlot::OnPrimary, PaletteSlot::OnAccent] {
                let bg = match slot {
                    PaletteSlot::OnBackground => p.background,
                    PaletteSlot::OnSurface => p.surface,
                    PaletteSlot::OnPrimary => p.primary,
                    _ => p.accent,
                };
                assert!(contrast(ColorRef::Slot(slot).resolve(p), bg) >= 4.5, "{slot:?} on {bg:?}");
            }
        }
    }

    #[test]
    fn on_tokens_parse_by_name() {
        let slot: PaletteSlot = serde_json::from_str("\"on_primary\"").unwrap();
        assert_eq!(slot, PaletteSlot::OnPrimary);
    }
}

