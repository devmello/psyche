//! The on-device engine: the SAPI 5.4 in-process desktop recognizer with a dictation grammar,
//! reading 16 kHz mono 16-bit PCM from a [`Feed`] through a COM `IStream`.
//!
//! Hypotheses become volatile segments (`speech.partial`), recognitions final ones; times come
//! from the result's stream offsets, so a file chunk's segments are relative to its first byte.

use super::wide;
use crate::error::{CapError, win_err};
use crate::speech::pcm::ENGINE_RATE;
use crate::speech::transcript::Segment;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use windows::Win32::Foundation::{E_NOTIMPL, LPARAM, S_FALSE, S_OK};
use windows::Win32::Media::Audio::WAVEFORMATEX;
use windows::Win32::Media::Speech::{
    ISpObjectToken, ISpRecoContext, ISpRecoGrammar, ISpRecoResult, ISpRecognizer, ISpStream, SPEI_END_SR_STREAM, SPEI_FALSE_RECOGNITION,
    SPEI_HYPOTHESIS, SPEI_RECOGNITION, SPEI_RESERVED1, SPEI_RESERVED2, SPET_LPARAM_IS_OBJECT, SPET_LPARAM_IS_POINTER, SPET_LPARAM_IS_STRING,
    SPET_LPARAM_IS_TOKEN, SPEVENT, SPLO_STATIC, SPRECORESULTTIMES, SPRS_ACTIVE, SPRST_ACTIVE, SpInprocRecognizer, SpObjectToken, SpStream,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, CoCreateInstance, CoTaskMemFree, ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE, STATFLAG, STATSTG, STGC,
    STREAM_SEEK, STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET,
};
use windows::Win32::System::Registry::{HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_SZ, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW};
use windows::core::{GUID, HRESULT, IUnknown, Interface, PCWSTR, PWSTR, implement};

/// `SPDFID_WaveFormatEx`.
const SPDFID_WAVEFORMATEX: GUID = GUID::from_u128(0xc31adbae_527f_4ff5_a230_f62bb61ff70c);
const SP_GETWHOLEPHRASE: u32 = u32::MAX;
const TOKENS_KEY: &str = r"SOFTWARE\Microsoft\Speech\Recognizers\Tokens";
const TOKENS_PATH: &str = r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\Recognizers\Tokens\";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Engine-format audio between a source and the recognizer. Reads block until the requested
/// bytes are there or the feed is finished, so a short read always means end of stream.
#[derive(Default)]
pub(crate) struct Feed {
    state: Mutex<FeedState>,
    cv: Condvar,
}

#[derive(Default)]
struct FeedState {
    data: VecDeque<u8>,
    finished: bool,
    read_total: u64,
}

impl Feed {
    pub fn new() -> Arc<Feed> {
        Arc::new(Feed::default())
    }

    /// All of `bytes`, finished (a file chunk).
    pub fn from_bytes(bytes: Vec<u8>) -> Arc<Feed> {
        let f = Feed::new();
        lock(&f.state).data.extend(bytes);
        f.finish();
        f
    }

    pub fn write(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut s = lock(&self.state);
        if s.finished {
            return;
        }
        s.data.extend(bytes);
        drop(s);
        self.cv.notify_all();
    }

    pub fn finish(&self) {
        lock(&self.state).finished = true;
        self.cv.notify_all();
    }

    /// Ends the stream now, dropping queued audio.
    pub fn cancel(&self) {
        let mut s = lock(&self.state);
        s.finished = true;
        s.data.clear();
        drop(s);
        self.cv.notify_all();
    }

    fn read(&self, out: &mut [u8]) -> usize {
        let mut s = lock(&self.state);
        while s.data.len() < out.len() && !s.finished {
            s = self.cv.wait(s).unwrap_or_else(|e| e.into_inner());
        }
        let n = out.len().min(s.data.len());
        for (o, b) in out.iter_mut().zip(s.data.drain(..n)) {
            *o = b;
        }
        s.read_total += n as u64;
        n
    }

    fn position(&self) -> u64 {
        lock(&self.state).read_total
    }
}

#[implement(IStream)]
struct FeedStream {
    feed: Arc<Feed>,
}

impl ISequentialStream_Impl for FeedStream_Impl {
    fn Read(&self, pv: *mut c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if pv.is_null() {
            return windows::Win32::Foundation::E_POINTER;
        }
        // SAFETY: the caller hands a buffer of `cb` bytes.
        let out = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, cb as usize) };
        let n = self.feed.read(out);
        if !pcbread.is_null() {
            // SAFETY: optional out-pointer from the caller.
            unsafe { *pcbread = n as u32 };
        }
        if n < cb as usize { S_FALSE } else { S_OK }
    }

    fn Write(&self, _pv: *const c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        E_NOTIMPL
    }
}

impl IStream_Impl for FeedStream_Impl {
    fn Seek(&self, dlibmove: i64, dworigin: STREAM_SEEK, plibnewposition: *mut u64) -> windows::core::Result<()> {
        // Forward-only: SAPI asks for the current position (a zero move) and nothing else.
        let pos = self.feed.position();
        let ok = match dworigin {
            STREAM_SEEK_CUR => dlibmove == 0,
            STREAM_SEEK_SET => dlibmove as u64 == pos,
            STREAM_SEEK_END => false,
            _ => false,
        };
        if !ok {
            return Err(E_NOTIMPL.into());
        }
        if !plibnewposition.is_null() {
            // SAFETY: optional out-pointer from the caller.
            unsafe { *plibnewposition = pos };
        }
        Ok(())
    }
    fn SetSize(&self, _: u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn CopyTo(&self, _: windows::core::Ref<IStream>, _: u64, _: *mut u64, _: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Commit(&self, _: &STGC) -> windows::core::Result<()> {
        Ok(())
    }
    fn Revert(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Stat(&self, pstatstg: *mut STATSTG, _: &STATFLAG) -> windows::core::Result<()> {
        if !pstatstg.is_null() {
            // SAFETY: the caller's STATSTG; an unknown-length stream reports its size so far.
            unsafe {
                *pstatstg = STATSTG { r#type: 2, cbSize: self.feed.position(), ..Default::default() };
            }
        }
        Ok(())
    }
    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

/// One installed desktop recognizer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Recognizer {
    pub token_id: String,
    pub name: String,
    /// BCP-47 tags of its languages (first is primary).
    pub languages: Vec<String>,
}

fn reg_string(key: HKEY, sub: &str, value: &str) -> Option<String> {
    let (sub, value) = (wide(sub), wide(value));
    let mut buf = vec![0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    // SAFETY: buf holds len bytes.
    let r = unsafe { RegGetValueW(key, PCWSTR(sub.as_ptr()), PCWSTR(value.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut c_void), Some(&mut len)) };
    if r.is_err() {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]))
}

/// `409;9` → `en-US`.
fn lcid_tags(langs: &str) -> Vec<String> {
    langs
        .split(';')
        .filter_map(|h| u32::from_str_radix(h.trim(), 16).ok())
        .filter_map(|lcid| {
            let mut buf = [0u16; 85];
            // SAFETY: buffer of LOCALE_NAME_MAX_LENGTH units.
            let n = unsafe { windows::Win32::Globalization::LCIDToLocaleName(lcid, Some(&mut buf), 0) };
            (n > 1).then(|| String::from_utf16_lossy(&buf[..n as usize - 1]))
        })
        .filter(|t| t.contains('-'))
        .collect()
}

/// Installed SAPI desktop recognizers (`HKLM\SOFTWARE\Microsoft\Speech\Recognizers\Tokens`).
pub(crate) fn recognizers() -> Vec<Recognizer> {
    let mut out = vec![];
    let sub = wide(TOKENS_KEY);
    let mut key = HKEY::default();
    // SAFETY: read-only registry enumeration.
    unsafe {
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(sub.as_ptr()), None, KEY_READ, &mut key).is_err() {
            return out;
        }
        for i in 0.. {
            let mut name = [0u16; 256];
            let mut len = name.len() as u32;
            if RegEnumKeyExW(key, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None).is_err() {
                break;
            }
            let id = String::from_utf16_lossy(&name[..len as usize]);
            let attrs = format!(r"{TOKENS_KEY}\{id}\Attributes");
            let languages = reg_string(HKEY_LOCAL_MACHINE, &attrs, "Language").map(|l| lcid_tags(&l)).unwrap_or_default();
            let display = reg_string(HKEY_LOCAL_MACHINE, &format!(r"{TOKENS_KEY}\{id}"), "").unwrap_or_else(|| id.clone());
            if !languages.is_empty() {
                out.push(Recognizer { token_id: id, name: display, languages });
            }
        }
        let _ = windows::Win32::System::Registry::RegCloseKey(key);
    }
    out
}

/// The recognizer serving `language` (a tag from [`recognizers`]).
pub(crate) fn recognizer_for(language: &str) -> Option<Recognizer> {
    recognizers().into_iter().find(|r| r.languages.iter().any(|l| l.eq_ignore_ascii_case(language)))
}

fn spfei(id: i32) -> u64 {
    (1u64 << id) | (1u64 << SPEI_RESERVED1.0) | (1u64 << SPEI_RESERVED2.0)
}

/// Releases what an event's lParam owns (`SpClearEvent`).
fn clear_event(ev: &SPEVENT) {
    let kind = (ev._bitfield >> 16) & 0xFFFF;
    let p = ev.lParam.0 as *mut c_void;
    if p.is_null() {
        return;
    }
    // SAFETY: lParam ownership per its declared type.
    unsafe {
        if kind == SPET_LPARAM_IS_OBJECT.0 || kind == SPET_LPARAM_IS_TOKEN.0 {
            drop(IUnknown::from_raw(p));
        } else if kind == SPET_LPARAM_IS_POINTER.0 || kind == SPET_LPARAM_IS_STRING.0 {
            CoTaskMemFree(Some(p));
        }
    }
}

fn result_segment(result: &ISpRecoResult, r#final: bool) -> Option<Segment> {
    // SAFETY: COM calls on a live result; returned memory is freed with CoTaskMemFree.
    unsafe {
        let mut text = PWSTR::null();
        result.GetText(SP_GETWHOLEPHRASE, SP_GETWHOLEPHRASE, true, &mut text, None).ok()?;
        let s = text.to_string().unwrap_or_default();
        CoTaskMemFree(Some(text.0 as *const c_void));
        let mut times = SPRECORESULTTIMES::default();
        result.GetResultTimes(&mut times).ok()?;
        let confidence = if r#final {
            result.GetPhrase().ok().and_then(|p| {
                let phrase = &*p;
                let n = phrase.Base.Rule.ulCountOfElements as usize;
                let c = if n > 0 && !phrase.Base.pElements.is_null() {
                    let els = std::slice::from_raw_parts(phrase.Base.pElements, n);
                    let xs: Vec<f64> = els.iter().map(|e| e.SREngineConfidence as f64).filter(|c| (0.0..=1.0).contains(c)).collect();
                    (!xs.is_empty()).then(|| xs.iter().sum::<f64>() / xs.len() as f64)
                } else {
                    None
                };
                CoTaskMemFree(Some(p as *const c_void));
                c
            })
        } else {
            None
        };
        Some(Segment::from_hns(s, times.ullStart, times.ullLength, r#final, confidence))
    }
}

fn engine_format() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: 1, // WAVE_FORMAT_PCM
        nChannels: 1,
        nSamplesPerSec: ENGINE_RATE,
        nAvgBytesPerSec: ENGINE_RATE * 2,
        nBlockAlign: 2,
        wBitsPerSample: 16,
        cbSize: 0,
    }
}

fn failed(e: &windows::core::Error) -> CapError {
    win_err("transcription_failed", "On-device transcription failed", e).retryable()
}

struct Session {
    _reco: ISpRecognizer,
    ctx: ISpRecoContext,
    _grammar: ISpRecoGrammar,
}

fn open(token_id: &str, feed: &Arc<Feed>) -> windows::core::Result<Session> {
    // SAFETY: COM object setup on this (COM-initialized) thread.
    unsafe {
        let reco: ISpRecognizer = CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL)?;
        let token: ISpObjectToken = CoCreateInstance(&SpObjectToken, None, CLSCTX_ALL)?;
        let id = wide(&format!("{TOKENS_PATH}{token_id}"));
        token.SetId(PCWSTR::null(), PCWSTR(id.as_ptr()), false)?;
        reco.SetRecognizer(&token)?;
        // Other people's audio must never train the owner's speech profile.
        for p in ["AdaptationOn", "PersistedBackgroundAdaptation", "PersistedLanguageModelAdaptation"] {
            let name = wide(p);
            let _ = reco.SetPropertyNum(PCWSTR(name.as_ptr()), 0);
        }
        let stream: IStream = FeedStream { feed: feed.clone() }.into();
        let sp: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL)?;
        let wfx = engine_format();
        sp.SetBaseStream(&stream, &SPDFID_WAVEFORMATEX, &wfx)?;
        reco.SetInput(&sp, false)?;
        let ctx = reco.CreateRecoContext()?;
        ctx.SetNotifyWin32Event()?;
        let interest = spfei(SPEI_RECOGNITION.0) | spfei(SPEI_HYPOTHESIS.0) | spfei(SPEI_END_SR_STREAM.0) | spfei(SPEI_FALSE_RECOGNITION.0);
        ctx.SetInterest(interest, interest)?;
        let grammar = ctx.CreateGrammar(0)?;
        grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC)?;
        grammar.SetDictationState(SPRS_ACTIVE)?;
        reco.SetRecoState(SPRST_ACTIVE)?;
        Ok(Session { _reco: reco, ctx, _grammar: grammar })
    }
}

/// Recognizes `feed` until it ends (or `cancelled()`), calling `on_segment` in order. Partials
/// only when `volatile`. Blocks the calling thread, which must have COM initialized.
pub(crate) fn recognize(
    token_id: &str,
    feed: &Arc<Feed>,
    volatile: bool,
    on_segment: &mut dyn FnMut(Segment),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CapError> {
    let session = open(token_id, feed).map_err(|e| failed(&e))?;
    loop {
        if cancelled() {
            feed.cancel();
            return Err(CapError::cancelled());
        }
        // SAFETY: COM calls on the session's context.
        unsafe {
            let _ = session.ctx.WaitForNotifyEvent(200);
            loop {
                let mut ev = SPEVENT { lParam: LPARAM(0), ..Default::default() };
                let mut fetched = 0u32;
                if session.ctx.GetEvents(1, &mut ev, &mut fetched).is_err() || fetched == 0 {
                    break;
                }
                let id = ev._bitfield & 0xFFFF;
                let kind = (ev._bitfield >> 16) & 0xFFFF;
                if (id == SPEI_RECOGNITION.0 || (volatile && id == SPEI_HYPOTHESIS.0)) && kind == SPET_LPARAM_IS_OBJECT.0 && ev.lParam.0 != 0 {
                    let raw = ev.lParam.0 as *mut c_void;
                    let unk = IUnknown::from_raw_borrowed(&raw);
                    if let Some(r) = unk.and_then(|u| u.cast::<ISpRecoResult>().ok())
                        && let Some(seg) = result_segment(&r, id == SPEI_RECOGNITION.0)
                    {
                        on_segment(seg);
                    }
                }
                clear_event(&ev);
                if id == SPEI_END_SR_STREAM.0 {
                    return Ok(());
                }
            }
        }
    }
}
