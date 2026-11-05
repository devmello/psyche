//! Clipboard paste with save and restore (pure logic over a [`Clipboard`] trait; the Win32
//! implementation is in `win::clipboard`).
//!
//! Long dictated text is pasted: the clipboard's formats are saved, the text is offered with
//! delayed rendering (so the helper knows when the target actually reads it) and marked to stay
//! out of clipboard history and cloud sync, Ctrl+V is sent, and the saved formats go back once
//! the target has read the text. A paste nobody read inserted nothing, so the inserter falls
//! back to typing. The saved contents are never restored over something another app copied in
//! the meantime.

use crate::error::CapError;
use crate::dictation::policy::PasteOutcome;
use std::time::Duration;

pub const CF_TEXT: u32 = 1;
pub const CF_BITMAP: u32 = 2;
pub const CF_METAFILEPICT: u32 = 3;
pub const CF_OEMTEXT: u32 = 7;
pub const CF_DIB: u32 = 8;
pub const CF_PALETTE: u32 = 9;
pub const CF_UNICODETEXT: u32 = 13;
pub const CF_ENHMETAFILE: u32 = 14;
pub const CF_DIBV5: u32 = 17;
pub const CF_OWNERDISPLAY: u32 = 0x80;
pub const CF_DSPBITMAP: u32 = 0x82;
pub const CF_DSPMETAFILEPICT: u32 = 0x83;
pub const CF_DSPENHMETAFILE: u32 = 0x8E;

/// Formats that keep dictated text (and the restored contents) out of Win+V history, cloud
/// clipboard and clipboard monitors.
pub const PRIVATE_MARKERS: &[(&str, &[u8])] = &[
    ("ExcludeClipboardContentFromMonitorProcessing", &[0, 0, 0, 0]),
    ("CanIncludeInClipboardHistory", &[0, 0, 0, 0]),
    ("CanUploadToCloudClipboard", &[0, 0, 0, 0]),
];

/// A clipboard larger than this is not saved; the text is typed instead.
pub const MAX_SAVE_BYTES: usize = 64 << 20;
/// How long the target has to read the pasted text.
pub const PASTE_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClipData {
    /// An HGLOBAL format's bytes.
    Memory(Vec<u8>),
    /// `CF_ENHMETAFILE` as `GetEnhMetaFileBits`.
    EnhMetafile(Vec<u8>),
}

impl ClipData {
    pub fn len(&self) -> usize {
        match self {
            ClipData::Memory(b) | ClipData::EnhMetafile(b) => b.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Whether one format of the current clipboard is saved. GDI handles (`CF_BITMAP`, palettes,
/// metafile pictures), owner-display and private formats are not memory the helper can copy;
/// Windows re-synthesizes `CF_BITMAP` from `CF_DIB`, `CF_METAFILEPICT` from `CF_ENHMETAFILE` and
/// ANSI/OEM text from `CF_UNICODETEXT`, so those are skipped when their source is present.
pub fn should_save(format: u32, all: &[u32]) -> bool {
    match format {
        CF_BITMAP | CF_PALETTE | CF_METAFILEPICT | CF_OWNERDISPLAY | CF_DSPBITMAP | CF_DSPMETAFILEPICT | CF_DSPENHMETAFILE => false,
        0x0200..=0x03FF => false, // CF_PRIVATEFIRST..CF_GDIOBJLAST
        CF_TEXT | CF_OEMTEXT => !all.contains(&CF_UNICODETEXT),
        _ => true,
    }
}

/// OLE clipboard bookkeeping formats point at the previous owner's data object; restored under
/// another owner they would mislead OLE, which rebuilds them from the plain formats anyway.
pub fn is_ole_bookkeeping(name: &str) -> bool {
    matches!(name, "DataObject" | "Ole Private Data" | "OleClipboardPersistOnFlush")
}

/// The clipboard operations paste-and-restore needs (Win32 in production, a fake in tests).
pub trait Clipboard {
    /// OpenClipboard with a few retries (another app may hold it briefly).
    fn open(&mut self) -> bool;
    fn close(&mut self);
    /// EnumClipboardFormats order (while open).
    fn formats(&mut self) -> Vec<u32>;
    fn get(&mut self, format: u32) -> Option<ClipData>;
    /// EmptyClipboard: the helper becomes the owner.
    fn empty(&mut self) -> bool;
    fn set(&mut self, format: u32, data: &ClipData) -> bool;
    /// Delayed rendering: the owner window renders on WM_RENDERFORMAT.
    fn set_delayed(&mut self, format: u32) -> bool;
    fn register(&mut self, name: &str) -> u32;
    /// A registered format's name (formats from 0xC000).
    fn name(&mut self, format: u32) -> Option<String>;
    /// Still the owner (nobody copied since the helper's last EmptyClipboard).
    fn owned_by_us(&mut self) -> bool;
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub items: Vec<(u32, ClipData)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveError {
    Busy,
    TooLarge,
}

pub fn save(cb: &mut dyn Clipboard) -> Result<Snapshot, SaveError> {
    if !cb.open() {
        return Err(SaveError::Busy);
    }
    let all = cb.formats();
    let mut items = vec![];
    let mut total = 0usize;
    for &f in &all {
        if !should_save(f, &all) || (f >= 0xC000 && cb.name(f).is_some_and(|n| is_ole_bookkeeping(&n))) {
            continue;
        }
        let Some(d) = cb.get(f) else { continue };
        total += d.len();
        if total > MAX_SAVE_BYTES {
            cb.close();
            return Err(SaveError::TooLarge);
        }
        items.push((f, d));
    }
    cb.close();
    Ok(Snapshot { items })
}

fn mark_private(cb: &mut dyn Clipboard) {
    for (name, bytes) in PRIVATE_MARKERS {
        let f = cb.register(name);
        if f != 0 {
            cb.set(f, &ClipData::Memory(bytes.to_vec()));
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreOutcome {
    Restored,
    /// Someone copied after the helper: their contents stay.
    ChangedByOthers,
    Busy,
}

/// Puts `snap` back (marked private, so the restore adds no history entry) unless another app
/// owns the clipboard now.
pub fn restore(cb: &mut dyn Clipboard, snap: &Snapshot) -> RestoreOutcome {
    if !cb.open() {
        return RestoreOutcome::Busy;
    }
    if !cb.owned_by_us() {
        cb.close();
        return RestoreOutcome::ChangedByOthers;
    }
    cb.empty();
    for (f, d) in &snap.items {
        cb.set(*f, d);
    }
    if !snap.items.is_empty() {
        mark_private(cb);
    }
    cb.close();
    RestoreOutcome::Restored
}

/// The input side of a paste (SendInput and the owner window's message pump in production).
pub trait PasteDriver {
    /// Shift, Ctrl, Alt or Win physically held: Ctrl+V would become another shortcut.
    fn modifiers_held(&mut self) -> bool;
    /// The text the owner window renders on WM_RENDERFORMAT.
    fn stage(&mut self, text: &str);
    /// Sends Ctrl+V; false when Windows dropped the input.
    fn send_paste(&mut self) -> bool;
    /// Pumps messages until the target read the text (true) or `timeout`.
    fn wait_for_render(&mut self, timeout: Duration) -> bool;
    /// A short grace after the read, so the target finishes with the clipboard.
    fn settle(&mut self);
}

pub fn paste_with_restore(
    cb: &mut dyn Clipboard,
    driver: &mut dyn PasteDriver,
    text: &str,
    guard: &mut dyn FnMut() -> Result<(), CapError>,
) -> Result<PasteOutcome, CapError> {
    if driver.modifiers_held() {
        return Ok(PasteOutcome::NotPasted);
    }
    let Ok(snap) = save(cb) else { return Ok(PasteOutcome::NotPasted) };
    driver.stage(text);
    if !cb.open() {
        return Ok(PasteOutcome::NotPasted);
    }
    cb.empty();
    cb.set_delayed(CF_UNICODETEXT);
    mark_private(cb);
    cb.close();
    if let Err(e) = guard() {
        restore(cb, &snap);
        return Err(e);
    }
    let read = driver.send_paste() && driver.wait_for_render(PASTE_TIMEOUT);
    if read {
        driver.settle();
    }
    restore(cb, &snap);
    Ok(if read { PasteOutcome::Pasted } else { PasteOutcome::NotPasted })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[derive(Default)]
    struct FakeClipboard {
        items: Vec<(u32, Option<ClipData>)>, // None = delayed
        registered: Vec<String>,
        ours: bool,
        busy: bool,
        open: bool,
        opens: usize,
    }

    impl Clipboard for FakeClipboard {
        fn open(&mut self) -> bool {
            assert!(!self.open, "opened twice");
            self.opens += 1;
            self.open = !self.busy;
            self.open
        }
        fn close(&mut self) {
            assert!(self.open);
            self.open = false;
        }
        fn formats(&mut self) -> Vec<u32> {
            self.items.iter().map(|(f, _)| *f).collect()
        }
        fn get(&mut self, f: u32) -> Option<ClipData> {
            self.items.iter().find(|(g, _)| *g == f).and_then(|(_, d)| d.clone())
        }
        fn empty(&mut self) -> bool {
            assert!(self.open);
            self.items.clear();
            self.ours = true;
            true
        }
        fn set(&mut self, f: u32, d: &ClipData) -> bool {
            assert!(self.open);
            self.items.push((f, Some(d.clone())));
            true
        }
        fn set_delayed(&mut self, f: u32) -> bool {
            self.items.push((f, None));
            true
        }
        fn register(&mut self, name: &str) -> u32 {
            let i = self.registered.iter().position(|n| n == name).unwrap_or_else(|| {
                self.registered.push(name.into());
                self.registered.len() - 1
            });
            0xC000 + i as u32
        }
        fn name(&mut self, f: u32) -> Option<String> {
            match f {
                0xC777 => Some("Ole Private Data".into()),
                0xC123 => Some("HTML Format".into()),
                _ => self.registered.get((f - 0xC000) as usize).cloned(),
            }
        }
        fn owned_by_us(&mut self) -> bool {
            self.ours
        }
    }

    struct Driver<'a> {
        cb: Option<&'a std::cell::RefCell<Vec<String>>>,
        held: bool,
        reads: bool,
        staged: String,
        log: Vec<String>,
    }

    impl PasteDriver for Driver<'_> {
        fn modifiers_held(&mut self) -> bool {
            self.held
        }
        fn stage(&mut self, text: &str) {
            self.staged = text.into();
        }
        fn send_paste(&mut self) -> bool {
            self.log.push("ctrl+v".into());
            true
        }
        fn wait_for_render(&mut self, _: Duration) -> bool {
            if self.reads
                && let Some(c) = self.cb
            {
                c.borrow_mut().push(self.staged.clone());
            }
            self.reads
        }
        fn settle(&mut self) {
            self.log.push("settle".into());
        }
    }

    fn mem(s: &str) -> ClipData {
        ClipData::Memory(s.as_bytes().to_vec())
    }

    fn user_clipboard() -> FakeClipboard {
        FakeClipboard {
            items: vec![
                (CF_UNICODETEXT, Some(mem("u\0s\0e\0r\0"))),
                (0xC123, Some(mem("<b>user</b>"))), // "HTML Format"
                (CF_LOCALE, Some(mem("\x09\x04\0\0"))),
                (CF_TEXT, Some(mem("user"))),        // synthesized
                (CF_OEMTEXT, Some(mem("user"))),     // synthesized
                (CF_BITMAP, Some(mem("hbitmap"))),   // GDI handle
                (CF_DIB, Some(mem("BITMAPINFO..."))),
                (0x0250, Some(mem("private"))),
                (CF_ENHMETAFILE, Some(ClipData::EnhMetafile(b"EMF".to_vec()))),
                (0xC777, Some(mem("ole"))), // "Ole Private Data"
            ],
            ..Default::default()
        }
    }
    const CF_LOCALE: u32 = 16;

    #[test]
    fn format_policy() {
        let all = [CF_UNICODETEXT, CF_TEXT, CF_OEMTEXT, CF_BITMAP, CF_DIB];
        assert!(should_save(CF_UNICODETEXT, &all));
        assert!(!should_save(CF_TEXT, &all));
        assert!(!should_save(CF_OEMTEXT, &all));
        assert!(should_save(CF_TEXT, &[CF_TEXT]), "ANSI-only text is the original");
        assert!(!should_save(CF_BITMAP, &all));
        assert!(should_save(CF_DIB, &all) && should_save(CF_DIBV5, &all));
        assert!(!should_save(0x0200, &all) && !should_save(0x03FF, &all));
        assert!(should_save(0xC0DE, &all) && should_save(CF_ENHMETAFILE, &all));
        assert!(is_ole_bookkeeping("Ole Private Data") && is_ole_bookkeeping("DataObject") && !is_ole_bookkeeping("HTML Format"));
    }

    #[test]
    fn pastes_then_restores_every_saved_format_in_order() {
        let mut cb = user_clipboard();
        let read = std::cell::RefCell::new(vec![]);
        let mut d = Driver { cb: Some(&read), held: false, reads: true, staged: String::new(), log: vec![] };
        let out = paste_with_restore(&mut cb, &mut d, "dictated text", &mut || Ok(())).unwrap();
        assert_eq!(out, PasteOutcome::Pasted);
        assert_eq!(*read.borrow(), ["dictated text"]);
        assert_eq!(d.log, ["ctrl+v", "settle"]);
        let restored: Vec<u32> = cb.items.iter().map(|(f, _)| *f).collect();
        let marker = |n: &str| 0xC000 + cb.registered.iter().position(|r| r == n).unwrap() as u32;
        assert_eq!(
            restored,
            [
                CF_UNICODETEXT,
                0xC123,
                CF_LOCALE,
                CF_DIB,
                CF_ENHMETAFILE,
                marker("ExcludeClipboardContentFromMonitorProcessing"),
                marker("CanIncludeInClipboardHistory"),
                marker("CanUploadToCloudClipboard")
            ]
        );
        assert_eq!(cb.get(0xC123), Some(mem("<b>user</b>")));
        assert_eq!(cb.get(CF_ENHMETAFILE), Some(ClipData::EnhMetafile(b"EMF".to_vec())));
        assert!(!cb.open);
    }

    #[test]
    fn dictated_text_is_delayed_and_kept_out_of_history() {
        let mut cb = FakeClipboard::default();
        let mut d = Driver { cb: None, held: false, reads: true, staged: String::new(), log: vec![] };
        // Inspect the clipboard as the target sees it, right before Ctrl+V.
        let mut seen = vec![];
        let mut guard = || Ok(());
        paste_with_restore(&mut cb, &mut d, "x", &mut guard).unwrap();
        // An empty original clipboard is restored empty (no markers needed).
        assert!(cb.items.is_empty());
        let mut cb = FakeClipboard::default();
        save(&mut cb).unwrap();
        assert!(cb.open());
        cb.empty();
        cb.set_delayed(CF_UNICODETEXT);
        mark_private(&mut cb);
        cb.close();
        seen.extend(cb.items.iter().map(|(f, d)| (*f, d.is_none())));
        assert_eq!(seen[0], (CF_UNICODETEXT, true));
        assert_eq!(seen.len(), 4);
        assert_eq!(cb.get(0xC001), Some(ClipData::Memory(vec![0, 0, 0, 0])));
    }

    #[test]
    fn a_paste_nobody_read_restores_and_reports_not_pasted() {
        let mut cb = user_clipboard();
        let mut d = Driver { cb: None, held: false, reads: false, staged: String::new(), log: vec![] };
        assert_eq!(paste_with_restore(&mut cb, &mut d, "t", &mut || Ok(())).unwrap(), PasteOutcome::NotPasted);
        assert_eq!(d.log, ["ctrl+v"]);
        assert_eq!(cb.get(CF_UNICODETEXT), Some(mem("u\0s\0e\0r\0")));
    }

    #[test]
    fn never_restores_over_a_newer_copy() {
        let mut cb = user_clipboard();
        save(&mut cb).unwrap();
        let snap = Snapshot { items: vec![(CF_UNICODETEXT, mem("old"))] };
        cb.ours = false; // another app copied after the helper
        assert_eq!(restore(&mut cb, &snap), RestoreOutcome::ChangedByOthers);
        assert_eq!(cb.get(CF_UNICODETEXT), Some(mem("u\0s\0e\0r\0")));
    }

    #[test]
    fn busy_large_or_modifiers_held_mean_no_paste_and_no_change() {
        let mut cb = FakeClipboard { busy: true, ..user_clipboard() };
        let mut d = Driver { cb: None, held: false, reads: true, staged: String::new(), log: vec![] };
        assert_eq!(paste_with_restore(&mut cb, &mut d, "t", &mut || Ok(())).unwrap(), PasteOutcome::NotPasted);
        assert!(d.log.is_empty());

        let mut cb = FakeClipboard { items: vec![(CF_DIB, Some(ClipData::Memory(vec![0; MAX_SAVE_BYTES + 1])))], ..Default::default() };
        assert_eq!(save(&mut cb), Err(SaveError::TooLarge));
        assert_eq!(paste_with_restore(&mut cb, &mut d, "t", &mut || Ok(())).unwrap(), PasteOutcome::NotPasted);
        assert_eq!(cb.items.len(), 1, "untouched");

        let mut cb = user_clipboard();
        let mut d = Driver { cb: None, held: true, reads: true, staged: String::new(), log: vec![] };
        assert_eq!(paste_with_restore(&mut cb, &mut d, "t", &mut || Ok(())).unwrap(), PasteOutcome::NotPasted);
        assert_eq!(cb.opens, 0);
    }

    #[test]
    fn a_failed_guard_restores_before_erroring() {
        let mut cb = user_clipboard();
        let mut d = Driver { cb: None, held: false, reads: true, staged: String::new(), log: vec![] };
        let e = paste_with_restore(&mut cb, &mut d, "t", &mut || Err(CapError::new(ErrorCode::PolicyDenied, "secure_field", "pw"))).unwrap_err();
        assert_eq!(e.reason, "secure_field");
        assert!(d.log.is_empty(), "no Ctrl+V");
        assert_eq!(cb.get(CF_UNICODETEXT), Some(mem("u\0s\0e\0r\0")));
    }
}
