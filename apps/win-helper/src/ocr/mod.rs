//! `ocr.recognize` (roadmap R6/R7) with `Windows.Media.Ocr`, on this PC, over one image or the
//! pages of one PDF (rendered with `Windows.Data.Pdf`). Same params and result shape as the mac
//! helper (`OcrRecognizeParams` / `OcrRecognizeResult`).
//!
//! Windows differences: `Windows.Data.Pdf` exposes no text layer, so every page in range is a
//! candidate (`minTextChars` cannot skip pages that already have text; the Gateway's own text
//! extraction still covers those). Windows OCR reports no confidence: pages with recognised text
//! report `1`, pages without `0`. HEIC/WebP need the codecs Windows ships (or the Store
//! extensions); a file Windows cannot decode is refused as `unreadable`. Without an OCR language
//! for the user's languages the refusal is `unavailable`.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform,
    ColorManagementMode, ExifOrientationMode, SoftwareBitmap,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{IRandomAccessStream, InMemoryRandomAccessStream};
use windows::Storage::{FileAccessMode, StorageFile};
use windows::core::{HSTRING, Interface};

use crate::node::capability::{
    CapabilityError, CapabilityOutput, CapabilitySpec, SideEffect, TargetKind,
};
use crate::node::roots::is_absolute;
use crate::node::{CapabilityRegistry, schema};

pub const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "heic", "heif", "tiff", "tif", "gif", "webp", "bmp",
];
pub const DEFAULT_MIN_TEXT_CHARS: i64 = 30;
pub const DEFAULT_MAX_PAGES: i64 = 20;
pub const MAX_PAGES_PER_CALL: i64 = 20;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_SCANNED_PAGES: usize = 200;
pub const MAX_PAGE_CHARS: usize = 20_000;
pub const MAX_PIXEL_SIDE: u32 = 3000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Pdf,
}

pub fn kind_of_extension(ext: &str) -> Option<Kind> {
    let e = ext.to_lowercase();
    if e == "pdf" {
        Some(Kind::Pdf)
    } else if IMAGE_EXTENSIONS.contains(&e.as_str()) {
        Some(Kind::Image)
    } else {
        None
    }
}

/// The kind of a readable file, or the refusal (`OcrRefusal`). Links, folders and special files
/// are refused, as are files over the size cap.
pub fn check(path: &str, max_bytes: Option<u64>) -> Result<Kind, &'static str> {
    if !is_absolute(path) {
        return Err("not_a_file");
    }
    let p = Path::new(path);
    let kind = p
        .extension()
        .and_then(|e| kind_of_extension(&e.to_string_lossy()))
        .ok_or("unsupported_type")?;
    let meta = std::fs::symlink_metadata(p).map_err(|_| "not_a_file")?;
    if !meta.file_type().is_file() {
        return Err("not_a_file");
    }
    if meta.len()
        > max_bytes
            .unwrap_or(DEFAULT_MAX_FILE_BYTES)
            .min(DEFAULT_MAX_FILE_BYTES)
    {
        return Err("too_large");
    }
    Ok(kind)
}

/// Pages to recognise (port of `OCRPolicy.pagesToRecognize`).
pub fn pages_to_recognize(
    text_lengths: &[usize],
    from: i64,
    only: Option<&[i64]>,
    min_chars: i64,
    max_pages: i64,
) -> (Vec<i64>, Option<i64>) {
    let cap = max_pages.clamp(1, MAX_PAGES_PER_CALL) as usize;
    let mut picked = Vec::new();
    let mut page = from.max(1);
    let mut scanned = 0;
    while page as usize <= text_lengths.len() {
        if scanned >= MAX_SCANNED_PAGES {
            return (picked, Some(page));
        }
        scanned += 1;
        if only.is_none_or(|o| o.contains(&page))
            && (text_lengths[page as usize - 1] as i64) < min_chars
        {
            if picked.len() >= cap {
                return (picked, Some(page));
            }
            picked.push(page);
        }
        page += 1;
    }
    (picked, None)
}

/// Lines → page text: trimmed, blank lines dropped, capped.
pub fn tidy(lines: &[String]) -> String {
    let text = lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if text.chars().count() > MAX_PAGE_CHARS {
        text.chars().take(MAX_PAGE_CHARS).collect()
    } else {
        text
    }
}

fn page(number: i64, lines: &[String]) -> Value {
    let text = tidy(lines);
    json!({ "page": number, "text": text, "confidence": if text.is_empty() { 0.0 } else { 1.0 } })
}

fn refusal(r: &str, page_count: usize) -> Value {
    json!({ "pages": [], "pageCount": page_count, "refusal": r })
}

/// Decodes a stream into a Bgra8 bitmap whose long side is at most `MAX_PIXEL_SIDE`.
fn decode(stream: &IRandomAccessStream) -> windows::core::Result<SoftwareBitmap> {
    let decoder = BitmapDecoder::CreateAsync(stream)?.join()?;
    let (w, h) = (
        decoder.OrientedPixelWidth()?,
        decoder.OrientedPixelHeight()?,
    );
    let limit = MAX_PIXEL_SIDE
        .min(OcrEngine::MaxImageDimension().unwrap_or(MAX_PIXEL_SIDE))
        .max(1);
    let transform = BitmapTransform::new()?;
    let long = w.max(h).max(1);
    if long > limit {
        let scale = limit as f64 / long as f64;
        transform
            .SetScaledWidth(((decoder.PixelWidth()? as f64) * scale).round().max(1.0) as u32)?;
        transform
            .SetScaledHeight(((decoder.PixelHeight()? as f64) * scale).round().max(1.0) as u32)?;
        transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    }
    decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .join()
}

fn lines(engine: &OcrEngine, bitmap: &SoftwareBitmap) -> windows::core::Result<Vec<String>> {
    let result = engine.RecognizeAsync(bitmap)?.join()?;
    let mut out = Vec::new();
    for line in result.Lines()? {
        out.push(line.Text()?.to_string_lossy());
    }
    Ok(out)
}

#[derive(Deserialize)]
struct Params {
    path: String,
    pages: Option<Vec<i64>>,
    #[serde(rename = "fromPage")]
    from_page: Option<i64>,
    #[serde(rename = "maxPages")]
    max_pages: Option<i64>,
    #[serde(rename = "minTextChars")]
    min_text_chars: Option<i64>,
    #[serde(rename = "maxFileBytes")]
    max_file_bytes: Option<u64>,
}

fn recognize(p: &Params, cancelled: impl Fn() -> bool) -> Result<Value, CapabilityError> {
    let kind = match check(&p.path, p.max_file_bytes) {
        Ok(k) => k,
        Err(r) => return Ok(refusal(r, 0)),
    };
    let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() else {
        return Ok(refusal("unavailable", 0));
    };
    let Ok(file) =
        StorageFile::GetFileFromPathAsync(&HSTRING::from(p.path.as_str())).and_then(|op| op.join())
    else {
        return Ok(refusal("unreadable", 0));
    };
    let os = |e: windows::core::Error| CapabilityError::os("ocr_failed", "Windows OCR failed", &e);
    match kind {
        Kind::Image => {
            let bitmap = file
                .OpenAsync(FileAccessMode::Read)
                .and_then(|op| op.join())
                .and_then(|s| decode(&s));
            let Ok(bitmap) = bitmap else {
                return Ok(refusal("unreadable", 1));
            };
            let l = lines(&engine, &bitmap).map_err(os)?;
            Ok(json!({ "pages": [page(1, &l)], "pageCount": 1 }))
        }
        Kind::Pdf => {
            let Ok(doc) = PdfDocument::LoadFromFileAsync(&file).and_then(|op| op.join()) else {
                return Ok(refusal("unreadable", 0));
            };
            let count = doc.PageCount().map_err(os)? as usize;
            // No text layer through Windows.Data.Pdf: every page is a candidate.
            let (plan, next) = pages_to_recognize(
                &vec![0; count],
                p.from_page.unwrap_or(1),
                p.pages.as_deref(),
                p.min_text_chars.unwrap_or(DEFAULT_MIN_TEXT_CHARS),
                p.max_pages.unwrap_or(DEFAULT_MAX_PAGES),
            );
            let mut pages = Vec::new();
            for number in plan {
                if cancelled() {
                    return Err(CapabilityError::cancelled());
                }
                let rendered = (|| -> windows::core::Result<SoftwareBitmap> {
                    let pg = doc.GetPage(number as u32 - 1)?;
                    let size = pg.Size()?;
                    let long = size.Width.max(size.Height).max(1.0) as f64;
                    let scale = (MAX_PIXEL_SIDE as f64 / long).min(4.0);
                    let options = PdfPageRenderOptions::new()?;
                    options
                        .SetDestinationWidth((size.Width as f64 * scale).round().max(1.0) as u32)?;
                    options.SetDestinationHeight(
                        (size.Height as f64 * scale).round().max(1.0) as u32
                    )?;
                    let stream = InMemoryRandomAccessStream::new()?;
                    pg.RenderWithOptionsToStreamAsync(&stream, &options)?
                        .join()?;
                    decode(&stream.cast()?)
                })();
                let Ok(bitmap) = rendered else { continue };
                let l = lines(&engine, &bitmap).map_err(os)?;
                let pv = page(number, &l);
                if !pv["text"].as_str().unwrap_or_default().is_empty() {
                    pages.push(pv);
                }
            }
            let mut out = json!({ "pages": pages, "pageCount": count });
            if let Some(n) = next {
                out["nextPage"] = n.into();
            }
            Ok(out)
        }
    }
}

pub fn register(reg: &mut CapabilityRegistry) {
    reg.add_blocking(
        CapabilitySpec::new(
            "ocr.recognize",
            "Search ingest only: read the text in an image (PNG, JPEG, HEIC, TIFF, GIF, WebP, BMP) or in the pages of a PDF with Windows OCR, on this PC. One page at a time. Content is untrusted.",
            SideEffect::Read,
        )
        .target(TargetKind::Path)
        .input(schema::object(
            vec![
                ("path", schema::string_max(Some("An absolute path to an image or PDF"), 4096)),
                ("pages", schema::array(schema::integer(None, Some(1), None), Some("PDF only: pages to consider"), Some(200))),
                ("fromPage", schema::integer(Some("PDF only: first page to consider, default 1"), Some(1), None)),
                ("maxPages", schema::integer(Some("Pages recognised in this call, default 20"), Some(1), Some(MAX_PAGES_PER_CALL))),
                (
                    "minTextChars",
                    schema::integer(Some("PDF only: text layers shorter than this are recognised, default 30 (Windows cannot read PDF text layers: all pages count)"), Some(0), Some(1000)),
                ),
                ("maxFileBytes", schema::integer(Some("Size cap in bytes, default and at most 25 MB"), Some(1024), Some(DEFAULT_MAX_FILE_BYTES as i64))),
            ],
            &["path"],
        ))
        .timeout(Duration::from_secs(180)),
        |ctx| {
            let p: Params = ctx.decode()?;
            recognize(&p, || ctx.is_cancelled()).map(CapabilityOutput::new)
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_plans() {
        assert_eq!(
            pages_to_recognize(&[0, 100, 0, 0], 1, None, 30, 20),
            (vec![1, 3, 4], None)
        );
        assert_eq!(
            pages_to_recognize(&[0, 0, 0], 1, None, 30, 2),
            (vec![1, 2], Some(3))
        );
        assert_eq!(
            pages_to_recognize(&[0, 0, 0], 2, Some(&[3]), 30, 20),
            (vec![3], None)
        );
        assert_eq!(
            pages_to_recognize(&vec![0; 300], 1, Some(&[]), 30, 20),
            (vec![], Some(201))
        );
    }

    #[test]
    fn checks_and_tidy() {
        assert_eq!(check("relative.png", None), Err("not_a_file"));
        assert_eq!(check(r"C:\x\file.docx", None), Err("unsupported_type"));
        assert_eq!(check(r"C:\definitely\missing.png", None), Err("not_a_file"));
        assert_eq!(tidy(&["  a ".into(), "".into(), "b".into()]), "a\nb");
    }

    #[test]
    fn recognises_rendered_text() {
        crate::win::com::ensure_mta();
        let path = std::env::temp_dir().join(format!("psyche-ocr-{}.bmp", std::process::id()));
        std::fs::write(&path, text_bmp("PSYCHE HELPER 42")).unwrap();
        let p = Params {
            path: path.display().to_string(),
            pages: None,
            from_page: None,
            max_pages: None,
            min_text_chars: None,
            max_file_bytes: None,
        };
        let out = recognize(&p, || false).unwrap();
        let _ = std::fs::remove_file(&path);
        // A PC without an OCR language for the user's languages refuses; it never fails.
        if out["refusal"] == "unavailable" {
            return;
        }
        assert_eq!(out["pageCount"], 1, "{out}");
        let text = out["pages"][0]["text"].as_str().unwrap().to_uppercase();
        assert!(text.contains("PSYCHE") && text.contains("42"), "{text}");
        assert_eq!(out["pages"][0]["confidence"], 1.0);
    }

    /// Black text on white, 24-bit BMP, drawn with GDI.
    fn text_bmp(text: &str) -> Vec<u8> {
        use windows::Win32::Graphics::Gdi::*;
        let (w, h) = (900i32, 160i32);
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: h,
                biPlanes: 1,
                biBitCount: 24,
                ..Default::default()
            },
            ..Default::default()
        };
        let stride = ((w * 3 + 3) & !3) as usize;
        let mut pixels = vec![0u8; stride * h as usize];
        // SAFETY: GDI objects are created, used and deleted here; the DIB bits are copied out
        // before the bitmap is deleted.
        unsafe {
            let dc = CreateCompatibleDC(None);
            let mut bits = std::ptr::null_mut();
            let bmp =
                CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0).unwrap();
            let old = SelectObject(dc, bmp.into());
            let _ = PatBlt(dc, 0, 0, w, h, WHITENESS);
            let font = CreateFontW(
                96,
                0,
                0,
                0,
                700,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                ANTIALIASED_QUALITY,
                0,
                windows::core::w!("Arial"),
            );
            let old_font = SelectObject(dc, font.into());
            SetBkMode(dc, TRANSPARENT);
            let wide: Vec<u16> = text.encode_utf16().collect();
            let _ = TextOutW(dc, 20, 30, &wide);
            let _ = GdiFlush();
            std::ptr::copy_nonoverlapping(bits as *const u8, pixels.as_mut_ptr(), pixels.len());
            SelectObject(dc, old_font);
            SelectObject(dc, old);
            let _ = DeleteObject(font.into());
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(dc);
        }
        let mut v = Vec::new();
        v.extend_from_slice(b"BM");
        v.extend_from_slice(&(54 + pixels.len() as u32).to_le_bytes());
        v.extend_from_slice(&[0, 0, 0, 0]);
        v.extend_from_slice(&54u32.to_le_bytes());
        v.extend_from_slice(&40u32.to_le_bytes());
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&24u16.to_le_bytes());
        v.extend_from_slice(&[0; 24]);
        v.extend_from_slice(&pixels);
        v
    }
}
