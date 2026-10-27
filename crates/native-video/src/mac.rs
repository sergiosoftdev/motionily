//! macOS: AVFoundation reads the file and VideoToolbox decodes it (hardware where the Mac has it),
//! as 32-bit BGRA pixel buffers; the track's rotation (its preferred transform, a quarter turn for
//! phone videos) is applied while converting to RGBA.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVAssetTrack, AVMediaTypeVideo, AVURLAsset};
use objc2_core_media::{kCMTimePositiveInfinity, CMTime, CMTimeRange};
use objc2_core_video::{
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

use crate::{bgra_to_rgba, Backend, Info};

/// Time scale for seek times (CMTime): fine enough for any frame rate.
const TIMESCALE: i32 = 600;

pub struct Platform {
    asset: Retained<AVURLAsset>,
    track: Retained<AVAssetTrack>,
    /// Clockwise quarter turns that make the picture upright.
    turns: u8,
    reading: Option<(Retained<AVAssetReader>, Retained<AVAssetReaderTrackOutput>)>,
}

// Each reader is owned and used by one thread at a time (the native viewer's or an export's); the
// AVFoundation objects are created on that thread when the clip is first needed.
unsafe impl Send for Platform {}

fn settings() -> Retained<NSDictionary<NSString, AnyObject>> {
    // CFString and NSString are toll-free bridged.
    let key: &NSString = unsafe { &*(kCVPixelBufferPixelFormatTypeKey as *const _ as *const NSString) };
    let value = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
    NSDictionary::from_slices(&[key], &[value.as_ref() as &AnyObject])
}

impl Backend for Platform {
    fn open(path: &str) -> Result<(Self, Info), String> {
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let asset = AVURLAsset::URLAssetWithURL_options(&url, None);
            let media = AVMediaTypeVideo.ok_or("AVMediaTypeVideo missing")?;
            #[allow(deprecated)]
            let tracks = asset.tracksWithMediaType(media);
            let track = tracks.firstObject().ok_or_else(|| format!("{path}: no video track"))?;
            let size = track.naturalSize();
            let m = track.preferredTransform();
            // The transform's angle, to the nearest quarter turn (phone videos carry 90°, 180°, 270°).
            let turns = ((m.b.atan2(m.a).to_degrees() / 90.0).round().rem_euclid(4.0)) as u8;
            if std::env::var_os("NATIVE_VIDEO_DEBUG").is_some() {
                eprintln!("[native-video] {path}: natural {}x{}, transform a={} b={} c={} d={} tx={} ty={} → {turns} turns", size.width, size.height, m.a, m.b, m.c, m.d, m.tx, m.ty);
            }
            let (w, h) = (size.width.round().max(0.0) as u32, size.height.round().max(0.0) as u32);
            let fps = f64::from(track.nominalFrameRate());
            let info = Info {
                width: if turns % 2 == 1 { h } else { w },
                height: if turns % 2 == 1 { w } else { h },
                fps: if fps > 0.0 { fps } else { 30.0 },
                duration: asset.duration().seconds(),
            };
            Ok((Self { asset, track, turns, reading: None }, info))
        }
    }

    fn seek(&mut self, t: f64) -> Result<(), String> {
        unsafe {
            self.reading = None;
            let reader = AVAssetReader::assetReaderWithAsset_error(&self.asset).map_err(|e| e.localizedDescription().to_string())?;
            let output = AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(&self.track, Some(&settings()));
            // The decoder's own buffers, not a copy each.
            output.setAlwaysCopiesSampleData(false);
            reader.setTimeRange(CMTimeRange { start: CMTime::with_seconds(t, TIMESCALE), duration: kCMTimePositiveInfinity });
            if !reader.canAddOutput(&output) {
                return Err("the reader cannot output this video".into());
            }
            reader.addOutput(&output);
            if !reader.startReading() {
                return Err(reader.error().map_or_else(|| "could not start reading".into(), |e| e.localizedDescription().to_string()));
            }
            self.reading = Some((reader, output));
            Ok(())
        }
    }

    fn next(&mut self, out: &mut Vec<u8>) -> Result<Option<f64>, String> {
        let Some((reader, output)) = &self.reading else { return Ok(None) };
        unsafe {
            let Some(sample) = output.copyNextSampleBuffer() else {
                return match reader.status() {
                    AVAssetReaderStatus::Failed => Err(reader.error().map_or_else(|| "decoding failed".into(), |e| e.localizedDescription().to_string())),
                    _ => Ok(None),
                };
            };
            let time = sample.presentation_time_stamp().seconds();
            let Some(image) = sample.image_buffer() else { return Ok(None) };
            if CVPixelBufferLockBaseAddress(&image, CVPixelBufferLockFlags::ReadOnly) != 0 {
                return Err("could not read the decoded frame".into());
            }
            let (w, h, stride) = (CVPixelBufferGetWidth(&image), CVPixelBufferGetHeight(&image), CVPixelBufferGetBytesPerRow(&image));
            let base = CVPixelBufferGetBaseAddress(&image) as *const u8;
            if !base.is_null() {
                bgra_to_rgba(std::slice::from_raw_parts(base, stride * h), stride, w, h, self.turns, out);
            }
            CVPixelBufferUnlockBaseAddress(&image, CVPixelBufferLockFlags::ReadOnly);
            Ok(Some(time))
        }
    }
}
