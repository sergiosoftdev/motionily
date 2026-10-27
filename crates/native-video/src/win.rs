//! Windows: Media Foundation's source reader decodes the file (hardware transforms allowed) and its
//! video processing converts the frames to 32-bit RGB (B, G, R, X in memory); the stream's rotation
//! (MF_MT_VIDEO_ROTATION, phone videos) is applied while converting to RGBA.

use windows::core::{GUID, HSTRING};
use windows::Win32::Media::MediaFoundation::{
    IMFSourceReader, MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Video, MFStartup, MFVideoFormat_RGB32, MFSTARTUP_NOSOCKET, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_MT_VIDEO_ROTATION, MF_PD_DURATION, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READER_MEDIASOURCE, MF_VERSION,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::{bgra_to_rgba, Backend, Info};

/// Media Foundation counts time in 100 ns units.
const HNS: f64 = 10_000_000.0;

pub struct Platform {
    reader: IMFSourceReader,
    stream: u32,
    /// Decoded size (before the rotation), row stride in bytes (negative: bottom-up rows).
    size: (usize, usize),
    stride: isize,
    turns: u8,
    ended: bool,
}

// One thread at a time owns a reader (the native viewer's or an export's); COM is initialized
// multithreaded on the threads that use it.
unsafe impl Send for Platform {}

fn err(e: windows::core::Error) -> String {
    format!("Media Foundation: {}", e.message())
}

impl Backend for Platform {
    fn open(path: &str) -> Result<(Self, Info), String> {
        unsafe {
            // Already initialized on this thread (in any mode) is fine.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(err)?;
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 2).map_err(err)?;
            let attrs = attrs.ok_or("no attributes")?;
            attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1).map_err(err)?;
            attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1).map_err(err)?;
            let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path), &attrs).map_err(err)?;
            let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
            let rotation = reader.GetNativeMediaType(stream, 0).ok().and_then(|t| t.GetUINT32(&MF_MT_VIDEO_ROTATION).ok()).unwrap_or(0);
            let want = MFCreateMediaType().map_err(err)?;
            want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
            want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(err)?;
            reader.SetCurrentMediaType(stream, None, &want).map_err(err)?;
            let cur = reader.GetCurrentMediaType(stream).map_err(err)?;
            let size = cur.GetUINT64(&MF_MT_FRAME_SIZE).map_err(err)?;
            let (w, h) = ((size >> 32) as usize, (size & 0xffff_ffff) as usize);
            let stride = cur.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|s| s as i32 as isize).unwrap_or((w * 4) as isize);
            let rate = cur.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or(0);
            let fps = if rate & 0xffff_ffff != 0 { (rate >> 32) as f64 / (rate & 0xffff_ffff) as f64 } else { 30.0 };
            let duration = reader
                .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
                .ok()
                .and_then(|v| u64::try_from(&v).ok())
                .map_or(0.0, |d| d as f64 / HNS);
            // The stream is stored turned counter-clockwise by `rotation`: turn it back clockwise.
            let turns = ((rotation / 90) % 4) as u8;
            let info = Info {
                width: (if turns % 2 == 1 { h } else { w }) as u32,
                height: (if turns % 2 == 1 { w } else { h }) as u32,
                fps: if fps > 0.0 { fps } else { 30.0 },
                duration,
            };
            Ok((Self { reader, stream, size: (w, h), stride, turns, ended: false }, info))
        }
    }

    fn seek(&mut self, t: f64) -> Result<(), String> {
        unsafe {
            let at = PROPVARIANT::from((t * HNS) as i64);
            self.reader.SetCurrentPosition(&GUID::zeroed(), &at).map_err(err)?;
        }
        self.ended = false;
        Ok(())
    }

    fn next(&mut self, out: &mut Vec<u8>) -> Result<Option<f64>, String> {
        if self.ended {
            return Ok(None);
        }
        unsafe {
            let (mut flags, mut time) = (0u32, 0i64);
            let mut sample = None;
            self.reader.ReadSample(self.stream, 0, None, Some(&mut flags), Some(&mut time), Some(&mut sample)).map_err(err)?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                self.ended = true;
            }
            let Some(sample) = sample else { return Ok(None) };
            let buffer = sample.ConvertToContiguousBuffer().map_err(err)?;
            let (mut ptr, mut len) = (std::ptr::null_mut(), 0u32);
            buffer.Lock(&mut ptr, None, Some(&mut len)).map_err(err)?;
            let (w, h) = self.size;
            let row = self.stride.unsigned_abs();
            if !ptr.is_null() && len as usize >= row * h {
                let data = std::slice::from_raw_parts(ptr, row * h);
                if self.stride >= 0 {
                    bgra_to_rgba(data, row, w, h, self.turns, out);
                } else {
                    // Bottom-up rows: flip them first.
                    let mut flipped = vec![0u8; row * h];
                    for y in 0..h {
                        flipped[y * row..(y + 1) * row].copy_from_slice(&data[(h - 1 - y) * row..(h - y) * row]);
                    }
                    bgra_to_rgba(&flipped, row, w, h, self.turns, out);
                }
            }
            let _ = buffer.Unlock();
            Ok(Some(time as f64 / HNS))
        }
    }
}
