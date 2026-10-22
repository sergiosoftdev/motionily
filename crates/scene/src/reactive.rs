//! Audio-reactive expressions: `vol`, `bass`, `mid`, `high`, `beat`, `beats` and `spec(k)`.
//!
//! The editor decodes the project's voice-over/music to mono samples and hands them to
//! [`analyze`] once per file. The result describes a file, not a scene, so it lives in a
//! thread-local registry (never saved, recomputed whenever the editor loads the audio) and
//! expressions read it on the scene timeline through the scene's `audio` placement (start/trim).
//! Everything is deterministic: the same samples always give the same curves and beats.

use crate::AudioTrack;
use std::cell::RefCell;
use std::rc::Rc;

/// Analysis frames per second (one every 10 ms); values in between are interpolated.
pub const ANALYSIS_RATE: f32 = 100.0;
/// Sample rate the editor decodes the audio at before analysing it (a whole number of samples per frame).
pub const SAMPLE_RATE: f32 = 24000.0;
/// Bands of the spectrum `spec(k)` reads, log-spaced from [`LOW_HZ`] to [`HIGH_HZ`].
pub const BANDS: usize = 16;
pub const LOW_HZ: f32 = 40.0;
pub const HIGH_HZ: f32 = 8000.0;
/// `bass` = bands up to this frequency, `mid` up to [`MID_MAX_HZ`], `high` above.
pub const BASS_MAX_HZ: f32 = 250.0;
pub const MID_MAX_HZ: f32 = 2000.0;
/// 0..1 maps the last this-many dB below the track's loud level (its 98th percentile).
pub const RANGE_DB: f32 = 40.0;
/// Envelope follower: rises within ~15 ms, falls over ~150 ms (smooth, never flickers).
pub const ATTACK_S: f32 = 0.015;
pub const RELEASE_S: f32 = 0.15;
/// `beat` is 1 at a beat and decays as exp(-seconds since it / this).
pub const BEAT_DECAY_S: f32 = 0.15;
/// Two beats are never closer than this (keeps the stronger one).
pub const MIN_BEAT_GAP_S: f32 = 0.15;
/// Silences at least this long are pauses (breaths between words are shorter).
pub const MIN_PAUSE_S: f32 = 0.25;
/// Pauses this long read as a change of scene in a voice-over ("[long pause]" in the script).
pub const LONG_PAUSE_S: f32 = 0.6;
/// Loudness (0..1 of the track's range, ≈ -35 dB under its loud level) below which a frame is silent.
pub const SILENCE_LEVEL: f32 = 0.12;
/// Phrases listed in the scene summary (the rest are counted).
const MAX_PHRASES: usize = 40;
/// Characters of a phrase's words shown in the summary.
const PHRASE_CHARS: usize = 70;
/// Level (dBFS) under which a whole track counts as silence (everything reads 0).
const SILENCE_DB: f32 = -70.0;
/// Percentile of the levels used as the track's "loud" reference.
const LOUD_PERCENTILE: f32 = 0.98;
/// Band filter sharpness (neighbouring bands overlap a little, like an analyser display).
const BAND_Q: f64 = 2.0;
/// Onset weight of low, mid and high bands: kicks and stressed syllables over hi-hats.
const ONSET_WEIGHT: [f32; 3] = [2.0, 1.0, 0.5];
/// Onset peaks must stand this far above the local mean (±0.5 s) …
const ONSET_LOCAL: f32 = 1.4;
const ONSET_WINDOW: usize = 50;
/// … and above this share of the track's strong onsets.
const ONSET_FLOOR: f32 = 0.15;
/// A peak is the maximum within ±50 ms.
const PEAK_HALF: usize = 5;

/// A value an expression can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Vol,
    Bass,
    Mid,
    High,
    Beat,
    Beats,
    Spec,
}

impl Channel {
    pub fn parse(name: &str) -> Option<Channel> {
        Some(match name {
            "vol" => Channel::Vol,
            "bass" => Channel::Bass,
            "mid" => Channel::Mid,
            "high" => Channel::High,
            "beat" => Channel::Beat,
            "beats" => Channel::Beats,
            "spec" => Channel::Spec,
            _ => return None,
        })
    }

    /// Arguments allowed when called: `vol(T)`, `spec(k)`, `spec(k, T)`.
    pub fn arity(self) -> std::ops::RangeInclusive<usize> {
        if self == Channel::Spec { 1..=2 } else { 1..=1 }
    }

    /// As written in expressions.
    pub fn name(self) -> &'static str {
        match self {
            Channel::Vol => "vol",
            Channel::Bass => "bass",
            Channel::Mid => "mid",
            Channel::High => "high",
            Channel::Beat => "beat",
            Channel::Beats => "beats",
            Channel::Spec => "spec",
        }
    }
}

/// Curves and beats of one audio file, in file seconds.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AudioAnalysis {
    /// Seconds of audio analysed.
    pub duration: f32,
    /// Exact seconds per analysis frame (a whole number of samples, ≈ 1 / ANALYSIS_RATE).
    frame_s: f32,
    vol: Vec<f32>,
    bass: Vec<f32>,
    mid: Vec<f32>,
    high: Vec<f32>,
    /// `BANDS` values per analysis frame.
    spec: Vec<f32>,
    /// Detected beats (onsets), file seconds, ascending.
    pub beats: Vec<f32>,
    /// Tempo estimate when the beats are regular enough.
    pub bpm: Option<f32>,
    /// Silences ≥ `MIN_PAUSE_S` between the first and the last sound, file seconds `[from, to]`.
    pub pauses: Vec<[f32; 2]>,
    /// First and last audible moment, file seconds.
    pub sound: Option<[f32; 2]>,
}

thread_local! {
    static ANALYSIS: RefCell<Option<Rc<AudioAnalysis>>> = const { RefCell::new(None) };
    /// Placement of the analysed file on the timeline of the scene being evaluated.
    static TRACK: RefCell<AudioTrack> = RefCell::new(AudioTrack::default());
}

/// Install (or clear) the analysis of the project's audio for every scene on this thread.
pub fn set_analysis(a: Option<AudioAnalysis>) {
    ANALYSIS.with(|c| *c.borrow_mut() = a.map(Rc::new));
}

pub fn analysis() -> Option<Rc<AudioAnalysis>> {
    ANALYSIS.with(|c| c.borrow().clone())
}

/// Run `f` with the scene's audio placement in effect (the scene does it around every evaluation).
pub(crate) fn with_track<R>(track: AudioTrack, f: impl FnOnce() -> R) -> R {
    struct Restore(AudioTrack);
    impl Drop for Restore {
        fn drop(&mut self) {
            TRACK.with(|c| *c.borrow_mut() = std::mem::take(&mut self.0));
        }
    }
    let _restore = Restore(TRACK.with(|c| c.replace(track)));
    f()
}

/// Value of `ch` for an expression: `args` are the call's arguments (none for the variable form),
/// `gt` the current scene time. 0 when there is no analysed audio.
pub fn eval(ch: Channel, args: &[f32], gt: f32) -> f32 {
    let Some(a) = analysis() else { return 0.0 };
    TRACK.with(|c| {
        let track = c.borrow();
        match ch {
            Channel::Spec => a.sample_at(ch, args.first().copied().unwrap_or(0.0), &track, args.get(1).copied().unwrap_or(gt)),
            _ => a.sample_at(ch, 0.0, &track, args.first().copied().unwrap_or(gt)),
        }
    })
}

/// One line for the scene summary: what the agent can sync to (beats in scene seconds).
pub fn summary_line(track: Option<AudioTrack>) -> Option<String> {
    let a = analysis()?;
    let track = track.unwrap_or_default();
    let beats: Vec<String> = a.scene_beats(&track).iter().take(32).map(|b| format!("{b:.2}")).collect();
    let tempo = a.bpm.map(|b| format!(" ≈{b:.0} BPM")).unwrap_or_default();
    Some(format!(
        "audio-reactive: ready ({:.1}s analysed, {} beats{tempo}) beats at [{}{}] — vol bass mid high beat beats spec(k)",
        a.duration,
        a.beats.len(),
        beats.join(" "),
        if a.beats.len() > 32 { " …" } else { "" }
    ))
}

impl AudioAnalysis {
    fn frames(&self) -> usize {
        self.vol.len()
    }

    /// End of the audible window in file seconds.
    fn end(&self, track: &AudioTrack) -> f32 {
        track.trim_out.map_or(self.duration, |o| o.min(self.duration))
    }

    /// Beats inside the trimmed window, in scene seconds.
    pub fn scene_beats(&self, track: &AudioTrack) -> Vec<f32> {
        let end = self.end(track);
        self.beats.iter().filter(|b| **b < end).filter_map(|b| track.to_scene(*b)).collect()
    }

    /// `ch` at scene time `gt` (band position `k` for `spec`).
    pub fn sample_at(&self, ch: Channel, k: f32, track: &AudioTrack, gt: f32) -> f32 {
        let end = self.end(track);
        // Past the last piece the file clock keeps running (beats go on decaying); before the start, nothing.
        let ft = match track.to_file(gt) {
            Some(f) => f,
            None if gt >= track.start => match track.pieces(f32::INFINITY).last() {
                Some(&(at, a, b)) if gt >= at + (b - a) => b + (gt - at - (b - a)),
                _ => return 0.0,
            },
            None => return 0.0,
        };
        if !ft.is_finite() {
            return 0.0;
        }
        match ch {
            Channel::Beat | Channel::Beats => {
                // Beats keep decaying after the audio ends; only beats inside the window count.
                let window = &self.beats[self.beats.partition_point(|b| *b < track.trim_in)..self.beats.partition_point(|b| *b < end)];
                let n = window.partition_point(|b| *b <= ft);
                if ch == Channel::Beats {
                    return n as f32;
                }
                n.checked_sub(1).map_or(0.0, |i| (-(ft - window[i]) / BEAT_DECAY_S).exp())
            }
            _ if ft >= end || self.frames() == 0 => 0.0,
            Channel::Spec => {
                let pos = k.clamp(0.0, 1.0) * (BANDS - 1) as f32;
                let (b0, u) = (pos.floor() as usize, pos.fract());
                let b1 = (b0 + 1).min(BANDS - 1);
                let band = |b: usize| self.interp(|f| self.spec[f * BANDS + b], ft);
                band(b0) * (1.0 - u) + band(b1) * u
            }
            Channel::Vol => self.interp(|f| self.vol[f], ft),
            Channel::Bass => self.interp(|f| self.bass[f], ft),
            Channel::Mid => self.interp(|f| self.mid[f], ft),
            Channel::High => self.interp(|f| self.high[f], ft),
        }
    }

    /// Linear interpolation between analysis frames at file time `ft`.
    fn interp(&self, at: impl Fn(usize) -> f32, ft: f32) -> f32 {
        let pos = (ft / self.frame_s).max(0.0);
        let f0 = (pos.floor() as usize).min(self.frames() - 1);
        let f1 = (f0 + 1).min(self.frames() - 1);
        let u = (pos - f0 as f32).clamp(0.0, 1.0);
        at(f0) * (1.0 - u) + at(f1) * u
    }
}

/// Center frequency of band `b`.
pub fn band_hz(b: usize) -> f32 {
    LOW_HZ * (HIGH_HZ / LOW_HZ).powf(b as f32 / (BANDS - 1) as f32)
}

/// RBJ band-pass biquad (0 dB peak), run in f64 so low bands stay clean at any sample rate.
struct BandPass {
    b0: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl BandPass {
    fn new(hz: f64, rate: f64) -> Self {
        let w = std::f64::consts::TAU * hz.min(rate * 0.45) / rate;
        let alpha = w.sin() / (2.0 * BAND_Q);
        let a0 = 1.0 + alpha;
        BandPass { b0: alpha / a0, b2: -alpha / a0, a1: -2.0 * w.cos() / a0, a2: (1.0 - alpha) / a0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }

    fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// dB level of each frame's mean square -> 0..1 against the track's loud level.
fn normalize(ms: &[f64]) -> Vec<f32> {
    let n = ms.len();
    let level: Vec<f32> = ms.iter().map(|m| (10.0 * (m + 1e-12).log10()) as f32).collect();
    let mut sorted = level.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let loud = sorted[((n - 1) as f32 * LOUD_PERCENTILE).round() as usize];
    if loud < SILENCE_DB {
        return vec![0.0; n];
    }
    level.iter().map(|l| ((l - (loud - RANGE_DB)) / RANGE_DB).clamp(0.0, 1.0)).collect()
}

/// Fast-attack, slow-release envelope follower.
fn smooth(v: &[f32]) -> Vec<f32> {
    let dt = 1.0 / ANALYSIS_RATE;
    let (up, down) = (1.0 - (-dt / ATTACK_S).exp(), 1.0 - (-dt / RELEASE_S).exp());
    let mut y = 0.0;
    v.iter()
        .map(|&x| {
            y += (x - y) * if x > y { up } else { down };
            y
        })
        .collect()
}

/// Analyse mono `samples` at `rate` Hz: loudness, bands, spectrum and beats.
pub fn analyze(samples: &[f32], rate: f32) -> AudioAnalysis {
    let rate = rate.max(1000.0);
    let hop = ((rate / ANALYSIS_RATE).round() as usize).max(1);
    let frames = samples.len().div_ceil(hop);
    if frames == 0 {
        return AudioAnalysis::default();
    }
    let mut filters: Vec<BandPass> = (0..BANDS).map(|b| BandPass::new(band_hz(b) as f64, rate as f64)).collect();
    let mut full = vec![0.0f64; frames];
    let mut bands = vec![vec![0.0f64; frames]; BANDS];
    for (f, chunk) in samples.chunks(hop).enumerate() {
        for &x in chunk {
            let x = x as f64;
            full[f] += x * x;
            for (b, filter) in filters.iter_mut().enumerate() {
                let y = filter.run(x);
                bands[b][f] += y * y;
            }
        }
        let k = 1.0 / chunk.len() as f64;
        full[f] *= k;
        bands.iter_mut().for_each(|band| band[f] *= k);
    }
    // Ranges sum their bands' energy before normalising: each reads 0..1 against its own loud level.
    let range = |lo: f32, hi: f32| -> Vec<f64> {
        (0..frames).map(|f| (0..BANDS).filter(|&b| band_hz(b) > lo && band_hz(b) <= hi).map(|b| bands[b][f]).sum()).collect()
    };
    let raw_bands: Vec<Vec<f32>> = bands.iter().map(|b| normalize(b)).collect();
    let smooth_bands: Vec<Vec<f32>> = raw_bands.iter().map(|b| smooth(b)).collect();
    let mut spec = vec![0.0f32; frames * BANDS];
    for (b, band) in smooth_bands.iter().enumerate() {
        for (f, v) in band.iter().enumerate() {
            spec[f * BANDS + b] = *v;
        }
    }
    let frame_s = hop as f32 / rate;
    let beats: Vec<f32> = onsets(&raw_bands, frames).into_iter().map(|f| f as f32 * frame_s).collect();
    let loud = normalize(&full);
    let (pauses, sound) = silences(&loud, frame_s);
    AudioAnalysis {
        duration: samples.len() as f32 / rate,
        frame_s,
        pauses,
        sound,
        vol: smooth(&loud),
        bass: smooth(&normalize(&range(0.0, BASS_MAX_HZ))),
        mid: smooth(&normalize(&range(BASS_MAX_HZ, MID_MAX_HZ))),
        high: smooth(&normalize(&range(MID_MAX_HZ, f32::MAX))),
        spec,
        bpm: tempo(&beats),
        beats,
    }
}

/// Pauses (silences ≥ `MIN_PAUSE_S` between sounds) and the span from the first to the last sound,
/// in file seconds. Raw loudness, not the smoothed `vol`: its release would shorten every pause.
fn silences(level: &[f32], frame_s: f32) -> (Vec<[f32; 2]>, Option<[f32; 2]>) {
    let quiet = |f: usize| level[f] < SILENCE_LEVEL;
    let Some(first) = (0..level.len()).position(|f| !quiet(f)) else { return (Vec::new(), None) };
    let last = (0..level.len()).rposition(|f| !quiet(f)).unwrap_or(first);
    let mut pauses = Vec::new();
    let mut f = first;
    while f <= last {
        if !quiet(f) {
            f += 1;
            continue;
        }
        let from = f;
        while f <= last && quiet(f) {
            f += 1;
        }
        let span = [from as f32 * frame_s, f as f32 * frame_s];
        if span[1] - span[0] >= MIN_PAUSE_S {
            pauses.push(span);
        }
    }
    (pauses, Some([first as f32 * frame_s, (last + 1) as f32 * frame_s]))
}

/// The voice laid out for timing, in scene seconds: phrases (with their caption words) and the
/// pauses between them; LONG ones are where a script's scenes change. From the analysed audio, or
/// from the gaps between caption words when there is no analysis (e.g. music under the voice).
pub fn voice_timeline(track: Option<AudioTrack>, words: &[crate::Word]) -> Option<String> {
    let track = track.unwrap_or_default();
    // File time to video time; a point inside a cut lands on the cut (where the audio jumps).
    let scene = |t: f32| track.to_scene(t).unwrap_or_else(|| track.start + t - track.trim_in - track.cuts.iter().filter(|c| c[1] <= t).map(|c| c[1] - c[0]).sum::<f32>());
    let (pauses, sound): (Vec<[f32; 2]>, [f32; 2]) = match analysis() {
        Some(a) => {
            let end = a.end(&track);
            let inside = |p: &&[f32; 2]| p[1] > track.trim_in && p[0] < end;
            let sound = a.sound?;
            (a.pauses.iter().filter(inside).map(|p| [scene(p[0].max(track.trim_in)), scene(p[1].min(end))]).collect(), [scene(sound[0].max(track.trim_in)), scene(sound[1].min(end))])
        }
        None => {
            let (first, last) = (words.first()?, words.last()?);
            let gaps = words.windows(2).filter(|w| w[1].start - w[0].end >= MIN_PAUSE_S).map(|w| [w[0].end, w[1].start]).collect();
            (gaps, [first.start, last.end])
        }
    };
    let mut cuts = vec![sound[0]];
    for p in &pauses {
        cuts.push(p[0]);
        cuts.push(p[1]);
    }
    cuts.push(sound[1]);
    let phrase = |from: f32, to: f32| {
        let text: Vec<&str> = words.iter().filter(|w| (w.start + w.end) / 2.0 >= from && (w.start + w.end) / 2.0 < to).map(|w| w.text.as_str()).collect();
        let mut line = text.join(" ");
        if line.chars().count() > PHRASE_CHARS {
            line = format!("{}…", line.chars().take(PHRASE_CHARS).collect::<String>().trim_end());
        }
        if line.is_empty() { format!("{from:.2}–{to:.2}") } else { format!("{from:.2}–{to:.2} \"{line}\"") }
    };
    let mut parts = Vec::new();
    for (i, span) in cuts.chunks(2).enumerate() {
        if i == MAX_PHRASES {
            parts.push(format!("… {} more phrases", cuts.len() / 2 - MAX_PHRASES));
            break;
        }
        parts.push(phrase(span[0], span[1]));
        if let Some(p) = pauses.get(i) {
            let len = p[1] - p[0];
            parts.push(format!("pause {len:.2}s{}", if len >= LONG_PAUSE_S { " LONG" } else { "" }));
        }
    }
    let long = pauses.iter().filter(|p| p[1] - p[0] >= LONG_PAUSE_S).count();
    Some(format!("voice timeline ({} phrases, {long} long pauses; scene s): {}", cuts.len() / 2, parts.join(" · ")))
}

/// Frames of the beats: peaks of the weighted spectral flux (rises of band level) above an
/// adaptive threshold.
fn onsets(bands: &[Vec<f32>], frames: usize) -> Vec<usize> {
    let weight = |b: usize| {
        let hz = band_hz(b);
        if hz <= BASS_MAX_HZ { ONSET_WEIGHT[0] } else if hz <= MID_MAX_HZ { ONSET_WEIGHT[1] } else { ONSET_WEIGHT[2] }
    };
    let flux: Vec<f32> = (0..frames)
        .map(|f| if f == 0 { 0.0 } else { (0..BANDS).map(|b| weight(b) * (bands[b][f] - bands[b][f - 1]).max(0.0)).sum() })
        .collect();
    let mut sorted = flux.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let strong = sorted[((frames - 1) as f32 * LOUD_PERCENTILE).round() as usize];
    if strong <= 1e-4 {
        return Vec::new();
    }
    let floor = strong * ONSET_FLOOR;
    let mut beats: Vec<(usize, f32)> = Vec::new();
    for f in 1..frames {
        let v = flux[f];
        if v < floor {
            continue;
        }
        let (lo, hi) = (f.saturating_sub(PEAK_HALF), (f + PEAK_HALF).min(frames - 1));
        // Strict on the left so a flat-topped peak counts once.
        if flux[lo..f].iter().any(|x| *x >= v) || flux[f + 1..=hi].iter().any(|x| *x > v) {
            continue;
        }
        let (wl, wh) = (f.saturating_sub(ONSET_WINDOW), (f + ONSET_WINDOW).min(frames - 1));
        let mean = flux[wl..=wh].iter().sum::<f32>() / (wh - wl + 1) as f32;
        if v < mean * ONSET_LOCAL {
            continue;
        }
        let gap = (MIN_BEAT_GAP_S * ANALYSIS_RATE) as usize;
        match beats.last_mut() {
            Some(last) if f - last.0 < gap => {
                if v > last.1 {
                    *last = (f, v);
                }
            }
            _ => beats.push((f, v)),
        }
    }
    beats.into_iter().map(|(f, _)| f).collect()
}

/// Median beat interval as BPM (folded into 70-180) when most intervals agree within 12%.
fn tempo(beats: &[f32]) -> Option<f32> {
    if beats.len() < 8 {
        return None;
    }
    let mut gaps: Vec<f32> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_by(|a, b| a.total_cmp(b));
    let median = gaps[gaps.len() / 2];
    let regular = gaps.iter().filter(|g| ((*g / median) - (*g / median).round()).abs() < 0.12 && (*g / median).round() >= 1.0).count();
    if (regular as f32) < gaps.len() as f32 * 0.6 {
        return None;
    }
    let mut bpm = 60.0 / median;
    while bpm < 70.0 {
        bpm *= 2.0;
    }
    while bpm > 180.0 {
        bpm /= 2.0;
    }
    Some(bpm)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = SAMPLE_RATE;

    /// `seconds` of a tone at `hz`, amplitude `amp`.
    fn tone(hz: f32, amp: f32, seconds: f32) -> Vec<f32> {
        (0..(seconds * RATE) as usize).map(|i| amp * (std::f32::consts::TAU * hz * i as f32 / RATE).sin()).collect()
    }

    /// A kick (decaying 60 Hz thump) every `period` s over a quiet hiss, for `seconds`.
    fn kicks(period: f32, seconds: f32) -> Vec<f32> {
        let n = (seconds * RATE) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / RATE;
                let since = t % period;
                let hiss = 0.01 * ((i as f32 * 12.9898).sin() * 43758.547).fract();
                0.8 * (-since / 0.06).exp() * (std::f32::consts::TAU * 60.0 * since).sin() + hiss
            })
            .collect()
    }

    #[test]
    fn loudness_follows_the_signal_and_silence_reads_zero() {
        let mut s = tone(440.0, 0.5, 1.0);
        s.extend(vec![0.0; RATE as usize]);
        s.extend(tone(440.0, 0.05, 1.0));
        s.extend(tone(80.0, 0.5, 1.0));
        let a = analyze(&s, RATE);
        assert!((a.duration - 4.0).abs() < 0.01);
        let track = AudioTrack::default();
        let at = |ch, t| a.sample_at(ch, 0.0, &track, t);
        assert!(at(Channel::Vol, 0.5) > 0.95, "loud part ≈ 1: {}", at(Channel::Vol, 0.5));
        assert!(at(Channel::Vol, 1.8) < 0.02, "silence ≈ 0");
        // -20 dB is half of the 40 dB range.
        assert!((at(Channel::Vol, 2.5) - 0.5).abs() < 0.08, "quiet part ≈ 0.5: {}", at(Channel::Vol, 2.5));
        // Smoothed: it falls over ~150 ms instead of dropping to 0 at once.
        assert!(at(Channel::Vol, 1.05) > 0.3 && at(Channel::Vol, 1.05) < 0.95);
        // Each range against its own loud moments: 440 Hz drives mid, 80 Hz drives bass.
        assert!(at(Channel::Mid, 0.5) > 0.9 && at(Channel::Bass, 0.5) < at(Channel::Mid, 0.5));
        assert!(at(Channel::Bass, 3.5) > 0.9 && at(Channel::Mid, 3.5) < at(Channel::Bass, 3.5));
        // Outside the audio, everything is 0.
        assert_eq!(at(Channel::Vol, -1.0), 0.0);
        assert_eq!(at(Channel::Vol, 6.0), 0.0);
    }

    #[test]
    fn spectrum_follows_the_tone_band() {
        let mut s = tone(1000.0, 0.5, 1.0);
        s.extend(tone(100.0, 0.5, 1.0));
        let a = analyze(&s, RATE);
        let track = AudioTrack::default();
        let k_of = |hz: f32| (hz / LOW_HZ).ln() / (HIGH_HZ / LOW_HZ).ln();
        let spec = |hz: f32, t: f32| a.sample_at(Channel::Spec, k_of(hz), &track, t);
        assert!(spec(1000.0, 0.5) > 0.9 && spec(100.0, 0.5) < 0.6, "{} {}", spec(1000.0, 0.5), spec(100.0, 0.5));
        assert!(spec(100.0, 1.5) > 0.9 && spec(1000.0, 1.5) < 0.6, "{} {}", spec(100.0, 1.5), spec(1000.0, 1.5));
    }

    #[test]
    fn beats_land_on_kicks_and_pulse() {
        let a = analyze(&kicks(0.5, 8.0), RATE);
        assert!(a.beats.len() >= 14 && a.beats.len() <= 16, "{:?}", a.beats);
        for b in &a.beats {
            let off = (b + 0.25) % 0.5 - 0.25;
            assert!(off.abs() < 0.04, "beat {b} is off the 0.5 s grid");
        }
        assert!((a.bpm.unwrap() - 120.0).abs() < 3.0, "{:?}", a.bpm);
        let track = AudioTrack::default();
        let b0 = a.beats[2];
        assert!((a.sample_at(Channel::Beat, 0.0, &track, b0) - 1.0).abs() < 1e-6);
        let later = a.sample_at(Channel::Beat, 0.0, &track, b0 + BEAT_DECAY_S);
        assert!((later - (-1.0f32).exp()).abs() < 1e-4);
        assert_eq!(a.sample_at(Channel::Beats, 0.0, &track, b0), 3.0);
    }

    #[test]
    fn placement_shifts_and_trims_the_curves() {
        let a = analyze(&kicks(0.5, 8.0), RATE);
        // Audio starts at 2 s on the timeline, from file second 1, cut at file second 3.
        let track = AudioTrack { start: 2.0, trim_in: 1.0, trim_out: Some(3.0), cuts: vec![] };
        let scene_beats = a.scene_beats(&track);
        assert!(scene_beats.iter().all(|b| *b >= 2.0 && *b < 4.0), "{scene_beats:?}");
        assert_eq!(a.sample_at(Channel::Beat, 0.0, &track, 1.5), 0.0, "before the audio starts");
        assert_eq!(a.sample_at(Channel::Vol, 0.0, &track, 4.5), 0.0, "after trim_out");
        assert_eq!(a.sample_at(Channel::Beats, 0.0, &track, 10.0), scene_beats.len() as f32);
    }

    #[test]
    fn expressions_read_the_installed_analysis() {
        use crate::expr::Expr;
        let e = Expr::new("vol + 10*beats".into());
        e.check().unwrap();
        set_analysis(None);
        assert_eq!(crate::expr::with_vars(0.5, 0.0, 1.0, || e.eval(0.5)), 0.0, "no audio: 0");
        set_analysis(Some(analyze(&kicks(0.5, 4.0), RATE)));
        let v = crate::expr::with_vars(1.2, 0.0, 1.0, || e.eval(0.0));
        assert!(v > 20.0, "{v}");
        let shifted = Expr::new("beat(T - 0.2)".into());
        shifted.check().unwrap();
        assert!(Expr::new("spec".into()).check().is_err());
        assert!(Expr::new("spec(i/n)".into()).check().is_ok());
        assert!(Expr::new("vol(1, 2)".into()).check().is_err());
        set_analysis(None);
    }
}

#[cfg(test)]
mod voice_timeline_tests {
    use super::*;

    fn tone(out: &mut Vec<f32>, secs: f32, amp: f32) {
        let n = (secs * SAMPLE_RATE) as usize;
        let start = out.len();
        out.extend((0..n).map(|i| amp * ((start + i) as f32 * 220.0 * std::f32::consts::TAU / SAMPLE_RATE).sin()));
    }

    #[test]
    fn finds_long_and_short_pauses_and_labels_the_phrases() {
        let mut s = Vec::new();
        tone(&mut s, 0.3, 0.0);
        tone(&mut s, 0.6, 0.5);
        tone(&mut s, 0.8, 0.0);
        tone(&mut s, 0.5, 0.5);
        tone(&mut s, 0.3, 0.0);
        tone(&mut s, 0.6, 0.5);
        let a = analyze(&s, SAMPLE_RATE);
        assert_eq!(a.pauses.len(), 2, "{:?}", a.pauses);
        assert!((a.pauses[0][0] - 0.9).abs() < 0.05 && (a.pauses[0][1] - 1.7).abs() < 0.05, "{:?}", a.pauses);
        assert!((a.pauses[1][1] - a.pauses[1][0] - 0.3).abs() < 0.06, "{:?}", a.pauses);
        set_analysis(Some(a));
        let word = |text: &str, start: f32, end: f32| crate::Word { text: text.into(), start, end, emphasis: false };
        let words = [word("Every", 0.35, 0.6), word("word", 0.6, 0.85), word("moves.", 1.75, 2.2), word("Now.", 2.55, 3.1)];
        let line = voice_timeline(None, &words).unwrap();
        set_analysis(None);
        assert!(line.contains("3 phrases, 1 long pauses"), "{line}");
        assert!(line.contains("\"Every word\" · pause 0.80s LONG"), "{line}");
        assert!(line.contains("\"moves.\" · pause 0.3"), "{line}");
        // Without analysis the gaps between caption words stand in for the pauses.
        assert!(voice_timeline(None, &words).unwrap().contains("pause 0.90s LONG"));
    }
}
