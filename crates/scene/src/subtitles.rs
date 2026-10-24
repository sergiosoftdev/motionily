//! Subtitle files (SRT, WebVTT) from the captions, cue by cue as they show on screen (`Captions::phrases`).

use serde::{Deserialize, Serialize};

use crate::text::{Captions, PHRASE_LINGER};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtitleFormat {
    Srt,
    Vtt,
}

fn stamp(t: f32, format: SubtitleFormat) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    let sep = if format == SubtitleFormat::Srt { ',' } else { '.' };
    format!("{:02}:{:02}:{:02}{sep}{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

impl Captions {
    /// The captions as a subtitle file. With `range` (`[in, out]` s, an export of part of the video)
    /// only the cues inside it, timed from its start.
    pub fn subtitles(&self, format: SubtitleFormat, range: Option<[f32; 2]>) -> String {
        let phrases = self.phrases();
        let [from, to] = range.unwrap_or([0.0, f32::INFINITY]);
        let mut out = String::new();
        if format == SubtitleFormat::Vtt {
            out.push_str("WEBVTT\n\n");
        }
        let mut n = 0;
        for (i, r) in phrases.iter().enumerate() {
            let words = &self.words[r.clone()];
            let start = words[0].start;
            // On screen a phrase lingers a little, until the next one takes its place.
            let next = phrases.get(i + 1).map(|n| self.words[n.start].start).unwrap_or(f32::INFINITY);
            let end = (words[words.len() - 1].end + PHRASE_LINGER).min(next);
            let (a, b) = (start.max(from), end.min(to));
            if b <= a {
                continue;
            }
            n += 1;
            let text = words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            if format == SubtitleFormat::Srt {
                out.push_str(&format!("{n}\n"));
            }
            out.push_str(&format!("{} --> {}\n{text}\n\n", stamp(a - from, format), stamp(b - from, format)));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::Word;

    fn caps() -> Captions {
        let w = |text: &str, start: f32, end: f32| Word { text: text.into(), start, end, emphasis: false };
        Captions { words: vec![w("Hola", 0.0, 0.3), w("qué", 0.3, 0.5), w("tal", 0.5, 0.7), w("Vale", 2.0, 2.3), w("adiós", 2.3, 3661.5)] }
    }

    #[test]
    fn srt_and_vtt_cues_follow_the_phrases() {
        let srt = caps().subtitles(SubtitleFormat::Srt, None);
        assert_eq!(srt, "1\n00:00:00,000 --> 00:00:01,050\nHola qué tal\n\n2\n00:00:02,000 --> 01:01:01,850\nVale adiós\n\n");
        let vtt = caps().subtitles(SubtitleFormat::Vtt, Some([0.5, 2.5]));
        assert_eq!(vtt, "WEBVTT\n\n00:00:00.000 --> 00:00:00.550\nHola qué tal\n\n00:00:01.500 --> 00:00:02.000\nVale adiós\n\n");
    }
}
