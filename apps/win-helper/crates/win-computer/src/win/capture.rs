//! Screen capture (the mac helper's ScreenCaptureKit use in `Screenshots.swift`):
//!
//! - **Windows.Graphics.Capture** single frames, per monitor (`CreateForMonitor`) or per window
//!   (`CreateForWindow`, the content of that window alone, like `SCContentFilter(desktopIndependentWindow:)`),
//!   with the yellow capture border off (`IsBorderRequired = false`, after asking for borderless
//!   access) where Windows allows it;
//! - a **GDI fallback** (`BitBlt` of the monitor, `PrintWindow(PW_RENDERFULLCONTENT)` of a window)
//!   when WGC is unavailable or fails;
//! - **exclusions**: ScreenCaptureKit drops excluded apps' windows from a display capture; WGC
//!   cannot, so their visible parts are blacked out (front-to-back occlusion, `hygiene::redactions`).
//!   Psyche's own windows also set `WDA_EXCLUDEFROMCAPTURE`, which both paths honour;
//! - **encoding** with WIC: high-quality-cubic downscale to the size bounds, then PNG (when asked
//!   and it fits) or JPEG down the quality ladder until it fits the 600 KB budget.

use crate::error::{CapError, CapResult};
use crate::hygiene::{JPEG_QUALITY_LADDER, MAX_ENCODED_BYTES};
use crate::snapshot::Rect;
use std::ffi::c_void;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows::core::{Interface, BOOL, PWSTR};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HGLOBAL, HMODULE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream, IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STREAM_SEEK_CUR};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::System::Variant::{VARIANT, VT_R4};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

/// A captured frame: tightly packed BGRA rows.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

impl Frame {
    /// Blacks out `r` (frame-local pixels).
    pub fn fill_black(&mut self, r: Rect) {
        let x0 = r.x.max(0.0).floor() as u32;
        let y0 = r.y.max(0.0).floor() as u32;
        let x1 = (r.max_x().ceil().max(0.0) as u32).min(self.width);
        let y1 = (r.max_y().ceil().max(0.0) as u32).min(self.height);
        for y in y0..y1 {
            let row = (y * self.width) as usize * 4;
            for x in x0..x1 {
                let i = row + x as usize * 4;
                self.bgra[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
    }

    /// The sub-rectangle `r` (frame-local pixels).
    pub fn crop(&self, r: Rect) -> Frame {
        let x0 = (r.x.max(0.0) as u32).min(self.width);
        let y0 = (r.y.max(0.0) as u32).min(self.height);
        let w = (r.w.max(0.0) as u32).min(self.width - x0);
        let h = (r.h.max(0.0) as u32).min(self.height - y0);
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for y in y0..y0 + h {
            let start = ((y * self.width + x0) * 4) as usize;
            out.extend_from_slice(&self.bgra[start..start + (w * 4) as usize]);
        }
        Frame { width: w, height: h, bgra: out }
    }
}

/// One monitor, physical pixels.
#[derive(Debug, Clone)]
pub struct Monitor {
    pub handle: isize,
    pub rect: Rect,
    pub primary: bool,
    /// DPI / 96 (the Mac's `backingScaleFactor`).
    pub scale: f64,
}

unsafe extern "system" fn monitor_proc(h: HMONITOR, _dc: HDC, _r: *mut RECT, lparam: LPARAM) -> BOOL {
    let v = &mut *(lparam.0 as *mut Vec<isize>);
    v.push(h.0 as isize);
    BOOL(1)
}

/// Monitors in enumeration order (the primary one flagged).
pub fn monitors() -> Vec<Monitor> {
    let mut hs: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(monitor_proc), LPARAM(&mut hs as *mut Vec<isize> as isize));
    }
    hs.into_iter()
        .filter_map(|h| {
            let hm = HMONITOR(h as *mut c_void);
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !unsafe { GetMonitorInfoW(hm, &mut mi) }.as_bool() {
                return None;
            }
            let (mut dx, mut dy) = (96u32, 96u32);
            let _ = unsafe { GetDpiForMonitor(hm, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
            Some(Monitor { handle: h, rect: super::apps::rect_of(mi.rcMonitor), primary: mi.dwFlags & 1 != 0, scale: dx as f64 / 96.0 })
        })
        .collect()
}

/// The monitor that holds most of `r`.
pub fn monitor_for_rect(r: Rect) -> Option<Monitor> {
    let ms = monitors();
    ms.iter()
        .filter_map(|m| m.rect.intersection(&r).map(|i| (m, i.w * i.h)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(m, _)| m.clone())
        .or_else(|| ms.into_iter().find(|m| m.primary))
}

fn d3d_device() -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        let mut device = None;
        let mut ctx = None;
        let r = unsafe {
            D3D11CreateDevice(
                None,
                driver,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut ctx),
            )
        };
        if r.is_ok() {
            if let (Some(d), Some(c)) = (device, ctx) {
                return Ok((d, c));
            }
        }
    }
    Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x887A_0004u32 as i32)))
    // DXGI_ERROR_UNSUPPORTED
}

/// Borderless capture needs consent once per process (granted for desktop apps).
fn request_borderless() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        if let Ok(op) = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
            let _ = op.join();
        }
    });
}

pub fn wgc_supported() -> bool {
    GraphicsCaptureSession::IsSupported().unwrap_or(false)
}

fn wgc_capture(item: &GraphicsCaptureItem, cursor: bool) -> windows::core::Result<Frame> {
    request_borderless();
    let (device, ctx) = d3d_device()?;
    let dxgi: IDXGIDevice = device.cast()?;
    let d3d: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    let size = item.Size()?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size)?;
    let session = pool.CreateCaptureSession(item)?;
    let _ = session.SetIsBorderRequired(false);
    let _ = session.SetIsCursorCaptureEnabled(cursor);
    session.StartCapture()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let frame = loop {
        if let Ok(f) = pool.TryGetNextFrame() {
            break f;
        }
        if Instant::now() > deadline {
            let _ = session.Close();
            let _ = pool.Close();
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_000Au32 as i32)));
            // E_PENDING
        }
        std::thread::sleep(Duration::from_millis(8));
    };
    let result = (|| -> windows::core::Result<Frame> {
        let content = frame.ContentSize()?;
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let tex: ID3D11Texture2D = unsafe { access.GetInterface()? };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex.GetDesc(&mut desc) };
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging: Option<ID3D11Texture2D> = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging))? };
        let staging = staging.ok_or_else(windows::core::Error::empty)?;
        unsafe { ctx.CopyResource(&staging, &tex) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))? };
        let w = (content.Width.max(1) as u32).min(desc.Width);
        let h = (content.Height.max(1) as u32).min(desc.Height);
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        for y in 0..h as usize {
            let src =
                unsafe { std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), (w * 4) as usize) };
            bgra[y * (w * 4) as usize..(y + 1) * (w * 4) as usize].copy_from_slice(src);
        }
        unsafe { ctx.Unmap(&staging, 0) };
        Ok(Frame { width: w, height: h, bgra })
    })();
    let _ = frame.Close();
    let _ = session.Close();
    let _ = pool.Close();
    result
}

fn interop() -> windows::core::Result<IGraphicsCaptureItemInterop> {
    windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
}

fn gdi_capture(src: Rect, window: Option<HWND>) -> CapResult<Frame> {
    let (w, h) = (src.w.max(1.0) as i32, src.h.max(1.0) as i32);
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let ok = match window {
            Some(hw) => PrintWindow(hw, mem, PRINT_WINDOW_FLAGS(2)).as_bool(), // PW_RENDERFULLCONTENT
            None => BitBlt(mem, 0, 0, w, h, Some(screen), src.x as i32, src.y as i32, SRCCOPY | CAPTUREBLT).is_ok(),
        };
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if !ok || lines == 0 {
            return Err(CapError::unavailable("capture_failed", "The screen could not be captured").retryable());
        }
        for px in bgra.chunks_exact_mut(4) {
            px[3] = 255;
        }
        Ok(Frame { width: w as u32, height: h as u32, bgra })
    }
}

/// One monitor, WGC first, GDI as the fallback.
pub fn capture_monitor(m: &Monitor, cursor: bool) -> CapResult<Frame> {
    if wgc_supported() {
        let item = interop().and_then(|i| unsafe { i.CreateForMonitor::<GraphicsCaptureItem>(HMONITOR(m.handle as *mut c_void)) });
        if let Ok(f) = item.and_then(|item| wgc_capture(&item, cursor)) {
            return Ok(f);
        }
    }
    gdi_capture(m.rect, None)
}

/// One window's own content, WGC first, `PrintWindow` as the fallback.
pub fn capture_window(hwnd: isize, cursor: bool) -> CapResult<Frame> {
    let h = super::apps::hwnd(hwnd);
    if wgc_supported() {
        let item = interop().and_then(|i| unsafe { i.CreateForWindow::<GraphicsCaptureItem>(h) });
        if let Ok(f) = item.and_then(|item| wgc_capture(&item, cursor)) {
            return Ok(f);
        }
    }
    let mut r = RECT::default();
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(h, &mut r);
    }
    gdi_capture(super::apps::rect_of(r), Some(h))
}

/// Captures a picked item (screenshot_pick).
pub fn capture_item(item: &GraphicsCaptureItem) -> CapResult<Frame> {
    wgc_capture(item, false)
        .map_err(|_| CapError::unavailable("capture_failed", "The picked window or display could not be captured").retryable())
}

// MARK: - Encoding

fn wic() -> CapResult<IWICImagingFactory> {
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
        .map_err(|_| CapError::unavailable("encoder_unavailable", "The image encoder is unavailable"))
}

fn encode_once(
    f: &IWICImagingFactory,
    source: &IWICBitmapSource,
    w: u32,
    h: u32,
    png: bool,
    quality: f32,
) -> windows::core::Result<Vec<u8>> {
    unsafe {
        let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
        let container = if png { GUID_ContainerFormatPng } else { GUID_ContainerFormatJpeg };
        let enc = f.CreateEncoder(&container, std::ptr::null())?;
        enc.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame: Option<IWICBitmapFrameEncode> = None;
        let mut bag: Option<IPropertyBag2> = None;
        enc.CreateNewFrame(&mut frame, &mut bag)?;
        let frame = frame.ok_or_else(windows::core::Error::empty)?;
        if let (false, Some(b)) = (png, bag.as_ref()) {
            let mut name: Vec<u16> = "ImageQuality".encode_utf16().chain([0]).collect();
            let prop = PROPBAG2 { pstrName: PWSTR(name.as_mut_ptr()), ..Default::default() };
            let mut v = VARIANT::default();
            (*v.Anonymous.Anonymous).vt = VT_R4;
            (*v.Anonymous.Anonymous).Anonymous.fltVal = quality;
            b.Write(1, &prop, &v)?;
        }
        frame.Initialize(bag.as_ref())?;
        frame.SetSize(w, h)?;
        let mut fmt = if png { GUID_WICPixelFormat32bppBGRA } else { GUID_WICPixelFormat24bppBGR };
        frame.SetPixelFormat(&mut fmt)?;
        let converted: IWICBitmapSource = if fmt == GUID_WICPixelFormat32bppBGRA && png {
            source.clone()
        } else {
            let conv = f.CreateFormatConverter()?;
            conv.Initialize(source, &fmt, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;
            conv.cast()?
        };
        frame.WriteSource(&converted, std::ptr::null())?;
        frame.Commit()?;
        enc.Commit()?;
        let mut pos = 0u64;
        stream.Seek(0, STREAM_SEEK_CUR, Some(&mut pos))?;
        let hg = GetHGlobalFromStream(&stream)?;
        let p = GlobalLock(hg) as *const u8;
        if p.is_null() {
            return Err(windows::core::Error::empty());
        }
        let out = std::slice::from_raw_parts(p, pos as usize).to_vec();
        let _ = GlobalUnlock(hg);
        Ok(out)
    }
}

/// Downscales `frame` to `w`×`h` and encodes it: PNG when asked and it fits the budget, else
/// JPEG down the quality ladder. Returns (bytes, mime, width, height).
pub fn encode(frame: &Frame, w: u32, h: u32, png: bool) -> CapResult<(Vec<u8>, &'static str, u32, u32)> {
    if frame.width == 0 || frame.height == 0 {
        return Err(CapError::unavailable("capture_failed", "The capture is empty").retryable());
    }
    let f = wic()?;
    let fail = |_| CapError::unavailable("encode_failed", "The screenshot could not be encoded");
    let source: IWICBitmapSource = unsafe {
        let bmp = f
            .CreateBitmapFromMemory(frame.width, frame.height, &GUID_WICPixelFormat32bppBGRA, frame.width * 4, &frame.bgra)
            .map_err(fail)?;
        if (w, h) == (frame.width, frame.height) {
            bmp.cast().map_err(fail)?
        } else {
            let scaler = f.CreateBitmapScaler().map_err(fail)?;
            scaler.Initialize(&bmp, w, h, WICBitmapInterpolationModeHighQualityCubic).map_err(fail)?;
            // Scale once, encode as often as the ladder needs.
            f.CreateBitmapFromSource(&scaler, WICBitmapCacheOnLoad).map_err(fail)?.cast().map_err(fail)?
        }
    };
    if png {
        if let Ok(d) = encode_once(&f, &source, w, h, true, 0.0) {
            if d.len() <= MAX_ENCODED_BYTES {
                return Ok((d, "image/png", w, h));
            }
        }
    }
    for q in JPEG_QUALITY_LADDER {
        if let Ok(d) = encode_once(&f, &source, w, h, false, q) {
            if d.len() <= MAX_ENCODED_BYTES {
                return Ok((d, "image/jpeg", w, h));
            }
        }
    }
    Err(CapError::unavailable("image_too_large", "The screenshot does not fit the frame budget; lower maxWidth"))
}
