//! Text: layer content, the typography brick, and the captions track.
//!
//! The scene decides *what* text shows and how each span is colored; the
//! engine does layout and glyphs, since that needs the font files.

use crate::{CaptionStyle, Easing, Palette, Rgba, Scene};
use serde::{Deserialize, Serialize};

/// Which weight of the typography brick a text uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextRole {
    Body,
    #[default]
    Heading,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

/// Payload of a typography brick: `{"family":"Inter","body":500,"heading":600}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Typography {
    pub family: String,
    pub body: u16,
    pub heading: u16,
}

impl Typography {
    pub fn weight(&self, role: TextRole) -> u16 {
        match role {
            TextRole::Body => self.body,
            TextRole::Heading => self.heading,
        }
    }
}

/// A run of text with its own color, scale and optional block behind it.
#[derive(Debug, Clone, PartialEq)]
pub struct TextSpan {
    pub text: String,
    pub color: Rgba,
    pub scale: f32,
    pub highlight: Option<Rgba>,
}

/// One block of text for one frame, in scene pixels. The engine lays it out.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawText {
    pub spans: Vec<TextSpan>,
    /// Font size in scene pixels.
    pub size: f32,
    pub family: String,
    pub weight: u16,
    pub align: TextAlign,
    pub line_height: f32,
    /// Center of the block.
    pub center: [f32; 2],
    /// Wrap width in scene pixels.
    pub max_width: f32,
    /// Box height: the engine shrinks the type until the block fits. `None` = grow freely.
    pub max_height: Option<f32>,
    pub rotation: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub text: String,
    /// Seconds.
    pub start: f32,
    pub end: f32,
    /// Key word: styles that care (highlight, pop) make it stand out.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub emphasis: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Captions {
    pub words: Vec<Word>,
}

/// How the project's voice-over/music sits on the video timeline.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct AudioTrack {
    /// Video time (s) where the audio starts playing.
    #[serde(default)]
    pub start: f32,
    /// Seconds cut from the beginning of the file.
    #[serde(default)]
    pub trim_in: f32,
    /// File time (s) where playback stops; `None` = end of file.
    #[serde(default)]
    pub trim_out: Option<f32>,
}

pub const DEFAULT_FAMILY: &str = "Inter";
const CAPTION_SIZE: f32 = 76.0;
const PHRASE_MAX_WORDS: usize = 4;
const PHRASE_MAX_CHARS: usize = 26;
/// A silence this long starts a new phrase.
const PHRASE_GAP: f32 = 0.6;
/// Keep a phrase on screen this long after its last word.
const PHRASE_LINGER: f32 = 0.35;
const POP_IN: f32 = 0.16;

impl Captions {
    /// Word index ranges that are shown together.
    pub fn phrases(&self) -> Vec<std::ops::Range<usize>> {
        let mut out = Vec::new();
        let mut start = 0;
        let mut chars = 0;
        for (i, w) in self.words.iter().enumerate() {
            let gap = i > start && w.start - self.words[i - 1].end > PHRASE_GAP;
            let full = i - start >= PHRASE_MAX_WORDS || chars + w.text.len() > PHRASE_MAX_CHARS;
            if i > start && (gap || full) {
                out.push(start..i);
                start = i;
                chars = 0;
            }
            chars += w.text.len() + 1;
        }
        if start < self.words.len() {
            out.push(start..self.words.len());
        }
        out
    }
}

/// Caption block for time `t`, styled by the scene's caption style. `None` between phrases.
pub(crate) fn caption_frame(scene: &Scene, palette: &Palette, t: f32) -> Option<DrawText> {
    let captions = scene.captions.as_ref()?;
    let words = &captions.words;
    let phrase = captions.phrases().into_iter().find(|r| {
        let (first, last) = (&words[r.start], &words[r.end - 1]);
        t >= first.start && t < last.end + PHRASE_LINGER
    })?;
    let (w, h) = (scene.width as f32, scene.height as f32);
    let anchor = scene.library.anchor("caption").unwrap_or([0.5, 0.82]);
    let typo = scene.typography.clone().unwrap_or(Typography { family: DEFAULT_FAMILY.into(), body: 500, heading: 700 });
    let faded = |c: Rgba, a: f32| Rgba([c.0[0], c.0[1], c.0[2], c.0[3] * a]);
    let spoken = |wd: &Word| t >= wd.start;

    let spans: Vec<TextSpan> = match scene.caption_style {
        CaptionStyle::Minimal => vec![TextSpan {
            text: words[phrase.clone()].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "),
            color: palette.text,
            scale: 1.0,
            highlight: None,
        }],
        CaptionStyle::Karaoke => words[phrase.clone()]
            .iter()
            .map(|wd| TextSpan {
                text: wd.text.clone(),
                color: if spoken(wd) { palette.primary } else { faded(palette.text, 0.45) },
                scale: 1.0,
                highlight: None,
            })
            .collect(),
        CaptionStyle::PopWord => {
            // Only the word being said, popping in; key words in the accent color.
            let current = words[phrase.clone()].iter().rev().find(|wd| spoken(wd))?;
            let p = Easing::Back.apply(((t - current.start) / POP_IN).clamp(0.0, 1.0));
            vec![TextSpan {
                text: current.text.to_uppercase(),
                color: if current.emphasis { palette.accent } else { palette.text },
                scale: (0.6 + 0.4 * p) * 1.35,
                highlight: None,
            }]
        }
        CaptionStyle::Highlight => words[phrase.clone()]
            .iter()
            .map(|wd| TextSpan {
                text: wd.text.clone(),
                color: if wd.emphasis { palette.surface } else { palette.text },
                scale: 1.0,
                highlight: wd.emphasis.then_some(palette.primary),
            })
            .collect(),
        CaptionStyle::Sticker => words[phrase.clone()]
            .iter()
            .filter(|wd| spoken(wd))
            .map(|wd| TextSpan {
                text: wd.text.clone(),
                color: if wd.emphasis { palette.primary } else { palette.text },
                scale: 1.0,
                highlight: Some(palette.surface),
            })
            .collect(),
    };
    Some(DrawText {
        spans,
        size: CAPTION_SIZE,
        weight: typo.heading,
        family: typo.family,
        align: TextAlign::Center,
        line_height: 1.2,
        center: [anchor[0] * w, anchor[1] * h],
        max_width: w * 0.84,
        max_height: None,
        rotation: 0.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(spec: &[(&str, f32, f32)]) -> Captions {
        Captions {
            words: spec.iter().map(|(t, s, e)| Word { text: (*t).into(), start: *s, end: *e, emphasis: false }).collect(),
        }
    }

    #[test]
    fn phrases_break_on_pauses_and_length() {
        let c = words(&[("hola", 0.0, 0.3), ("qué", 0.3, 0.5), ("tal", 0.5, 0.7), ("vale", 2.0, 2.3)]);
        assert_eq!(c.phrases(), vec![0..3, 3..4]);
        let long = words(&[("a", 0.0, 0.1), ("b", 0.1, 0.2), ("c", 0.2, 0.3), ("d", 0.3, 0.4), ("e", 0.4, 0.5)]);
        assert_eq!(long.phrases(), vec![0..4, 4..5]);
    }

    #[test]
    fn styles_pick_the_right_words() {
        let mut scene = Scene::default();
        scene.captions = Some(words(&[("uno", 0.0, 0.4), ("dos", 0.4, 0.8), ("tres", 0.8, 1.2)]));
        let p = scene.palette();
        scene.caption_style = CaptionStyle::PopWord;
        let pop = caption_frame(&scene, &p, 0.5).unwrap();
        assert_eq!(pop.spans.len(), 1);
        assert_eq!(pop.spans[0].text, "DOS");
        scene.caption_style = CaptionStyle::Karaoke;
        let k = caption_frame(&scene, &p, 0.5).unwrap();
        assert_eq!(k.spans[1].color, p.primary);
        assert_ne!(k.spans[2].color, p.primary);
        assert!(caption_frame(&scene, &p, 3.0).is_none());
    }
}
