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
}

/// A color is either a palette slot (preferred, follows the style) or a raw value.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ColorRef {
    Slot(PaletteSlot),
    Raw(Rgba),
}

impl Default for ColorRef {
    fn default() -> Self {
        ColorRef::Slot(PaletteSlot::Primary)
    }
}

impl ColorRef {
    pub fn resolve(self, p: &Palette) -> Rgba {
        match self {
            ColorRef::Raw(c) => c,
            ColorRef::Slot(PaletteSlot::Background) => p.background,
            ColorRef::Slot(PaletteSlot::Surface) => p.surface,
            ColorRef::Slot(PaletteSlot::Primary) => p.primary,
            ColorRef::Slot(PaletteSlot::Accent) => p.accent,
            ColorRef::Slot(PaletteSlot::Text) => p.text,
        }
    }
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
}

impl CaptionStyle {
    pub const ALL: [CaptionStyle; 4] = [Self::Minimal, Self::Karaoke, Self::PopWord, Self::Highlight];
}

/// A `#rrggbb` color as written in brick payloads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HexColor(pub Rgba);

impl Serialize for HexColor {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let [r, g, b, _] = self.0 .0.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
        s.serialize_str(&format!("#{r:02x}{g:02x}{b:02x}"))
    }
}

impl<'de> Deserialize<'de> for HexColor {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let hex = s.strip_prefix('#').unwrap_or(&s);
        if hex.len() != 6 {
            return Err(serde::de::Error::custom(format!("expected #rrggbb, got '{s}'")));
        }
        let v = u32::from_str_radix(hex, 16).map_err(serde::de::Error::custom)?;
        Ok(HexColor(Rgba::hex(v)))
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
