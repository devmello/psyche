//! Screen frames from the portal's PipeWire stream (linux-desktop design §6.2): connect with the
//! fd `OpenPipeWireRemote` gave, ask for a raw video format, keep the first frame that arrives
//! and disconnect. Nothing runs between screenshots, so a session costs one connection per
//! capture and no standing stream.
//!
//! Buffers are mapped shared memory (`MAP_BUFFERS`); DMA-BUF is not offered, so the compositor
//! falls back to memory buffers. The frame is converted to RGBA with the stream's own stride.
//! A frame is never kept: the caller scales it, hides protected windows and drops it.

use crate::error::{CapError, CapResult};
use pipewire as pw;
use pw::{properties::properties, spa};
use spa::param::video::{VideoFormat, VideoInfoRaw};
use spa::pod::Pod;
use std::cell::RefCell;
use std::os::fd::OwnedFd;
use std::rc::Rc;
use std::time::Duration;

/// The longest edge a frame may have (guards the allocation below).
const MAX_EDGE: u32 = 16_384;

/// One captured frame, RGBA.
pub struct Raw {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Default)]
struct Shared {
    format: VideoInfoRaw,
    frame: Option<Raw>,
    error: Option<String>,
}

fn pwerr<E: std::fmt::Display>(what: &str, e: E) -> CapError {
    CapError::unavailable(
        "pipewire_error",
        format!("Screen capture failed ({what}): {e}"),
    )
}

/// Converts one row-padded buffer to RGBA. Returns `None` for formats the helper did not ask for.
pub fn to_rgba(
    format: VideoFormat,
    width: u32,
    height: u32,
    stride: usize,
    data: &[u8],
) -> Option<Vec<u8>> {
    let bgr = match format {
        VideoFormat::BGRx | VideoFormat::BGRA => true,
        VideoFormat::RGBx | VideoFormat::RGBA => false,
        _ => return None,
    };
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || stride < width as usize * 4
    {
        return None;
    }
    if data.len() < stride * (height as usize - 1) + width as usize * 4 {
        return None;
    }
    let mut out = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height as usize {
        let row = &data[y * stride..y * stride + width as usize * 4];
        for px in row.chunks_exact(4) {
            if bgr {
                out.extend_from_slice(&[px[2], px[1], px[0], 255]);
            } else {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
    }
    Some(out)
}

/// Grabs the first frame of `node` through the remote behind `fd`, waiting at most `timeout`.
pub fn grab(fd: OwnedFd, node: u32, timeout: Duration) -> CapResult<Raw> {
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|e| pwerr("main loop", e))?;
    let context = pw::context::ContextRc::new(&mainloop, None).map_err(|e| pwerr("context", e))?;
    let core = context
        .connect_fd_rc(fd, None)
        .map_err(|e| pwerr("connect", e))?;
    let shared = Rc::new(RefCell::new(Shared::default()));

    let stream = pw::stream::StreamBox::new(
        &core,
        "psyche-capture",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| pwerr("stream", e))?;

    let quit = mainloop.clone();
    let _listener = stream
        .add_local_listener_with_user_data(shared.clone())
        .param_changed(|_, shared, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param)
            else {
                return;
            };
            if media_type != spa::param::format::MediaType::Video
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            let mut s = shared.borrow_mut();
            if s.format.parse(param).is_err() {
                s.error = Some("the stream's format could not be read".into());
            }
        })
        .process(move |stream, shared| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            let Some(d) = datas.first_mut() else { return };
            let (size, stride) = {
                let c = d.chunk();
                (c.size() as usize, c.stride() as usize)
            };
            let Some(bytes) = d.data() else { return };
            let mut s = shared.borrow_mut();
            let (w, h) = (s.format.size().width, s.format.size().height);
            let fmt = s.format.format();
            let bytes = &bytes[..size.min(bytes.len())];
            match to_rgba(fmt, w, h, stride, bytes) {
                Some(rgba) => {
                    s.frame = Some(Raw {
                        width: w,
                        height: h,
                        rgba,
                    });
                    quit.quit();
                }
                None => {
                    s.error = Some("the stream sent a pixel format the helper cannot read".into());
                    quit.quit();
                }
            }
        })
        .register()
        .map_err(|e| pwerr("listener", e))?;

    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaType,
            Id,
            spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaSubtype,
            Id,
            spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA,
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle {
                width: 1920,
                height: 1080
            },
            spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            spa::utils::Rectangle {
                width: MAX_EDGE,
                height: MAX_EDGE
            }
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: 30, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction { num: 120, denom: 1 }
        ),
    );
    let values: Vec<u8> = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map_err(|e| pwerr("format", format!("{e:?}")))?
    .0
    .into_inner();
    let mut params = [Pod::from_bytes(&values).ok_or_else(|| pwerr("format", "bad pod"))?];

    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(|e| pwerr("connect stream", e))?;

    // Give up after `timeout`: a compositor that never sends a frame must not hang the call.
    let quit = mainloop.clone();
    let timer = mainloop.loop_().add_timer(move |_| quit.quit());
    let _ = timer.update_timer(Some(timeout), None);
    mainloop.run();

    let mut s = shared.borrow_mut();
    if let Some(f) = s.frame.take() {
        return Ok(f);
    }
    Err(match s.error.take() {
        Some(e) => CapError::unavailable("pipewire_format", e),
        None => CapError::unavailable("pipewire_timeout", "The compositor sent no frame in time")
            .retryable(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_unpadded_and_channels_ordered() {
        // 2x2 BGRx with a 12-byte stride (4 bytes of padding per row).
        let data = [
            10, 20, 30, 0, 40, 50, 60, 0, 99, 99, 99, 99, //
            70, 80, 90, 0, 100, 110, 120, 0, 99, 99, 99, 99,
        ];
        let out = to_rgba(VideoFormat::BGRx, 2, 2, 12, &data).unwrap();
        assert_eq!(
            out,
            vec![30, 20, 10, 255, 60, 50, 40, 255, 90, 80, 70, 255, 120, 110, 100, 255]
        );
        let rgbx = to_rgba(VideoFormat::RGBx, 1, 1, 4, &[1, 2, 3, 0]).unwrap();
        assert_eq!(rgbx, vec![1, 2, 3, 255]);
    }

    #[test]
    fn bad_buffers_and_formats_are_refused() {
        assert!(to_rgba(VideoFormat::YUY2, 2, 2, 8, &[0; 16]).is_none());
        assert!(
            to_rgba(VideoFormat::BGRx, 2, 2, 4, &[0; 16]).is_none(),
            "stride smaller than a row"
        );
        assert!(
            to_rgba(VideoFormat::BGRx, 2, 2, 8, &[0; 8]).is_none(),
            "buffer shorter than the image"
        );
        assert!(to_rgba(VideoFormat::BGRx, 0, 2, 8, &[0; 16]).is_none());
        assert!(to_rgba(VideoFormat::BGRx, 100_000, 2, 400_000, &[]).is_none());
    }
}
