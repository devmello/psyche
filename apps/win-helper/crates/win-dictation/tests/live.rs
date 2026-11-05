//! Live Windows integration tests (ignored by default: they install a keyboard hook, take
//! focus, type, use the clipboard and run speech recognizers). Run with
//! `cargo test -- --ignored --test-threads=1`.

// CapError with preserve_order Maps (see lib.rs).
#![allow(clippy::result_large_err)]

use psyche_win_dictation::testing::{self, KeyEvent};
use psyche_win_dictation::{
    Invocation, dictation_insert, dictation_target, dictation_watch, speech_audio_push,
    speech_status, speech_transcribe_file, speech_transcribe_stream,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Storage::Streams::DataReader;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, keybd_event,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, FindWindowW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    SW_RESTORE, SetForegroundWindow, ShowWindow,
};
use windows::core::{HSTRING, PCWSTR};

const VK_RCONTROL: u16 = 0xA3;
const REMIND: &str = "Please send the report to the team before the meeting tomorrow morning. Remind me to call Alice at noon.";

fn com() {
    // SAFETY: test-thread COM init (idempotent per thread).
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// `PSYCHE_HOME` for this run, with an empty Library the file tests write into.
fn home() -> &'static PathBuf {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let h =
            std::env::temp_dir().join(format!("psyche-win-dictation-it-{}", std::process::id()));
        std::fs::create_dir_all(h.join("library")).unwrap();
        // SAFETY: set once, before any test reads it.
        unsafe { std::env::set_var("PSYCHE_HOME", &h) };
        h
    })
}

/// A WAV of `text` from Windows.Media.SpeechSynthesis (test fixture only; Psyche never speaks).
/// Zira at 0.9× when installed (the voice the desktop recognizer hears best), else the default.
fn synthesize(text: &str, path: &Path) {
    com();
    let synth = SpeechSynthesizer::new().unwrap();
    if let Some(v) = SpeechSynthesizer::AllVoices()
        .unwrap()
        .into_iter()
        .find(|v| {
            v.DisplayName()
                .is_ok_and(|n| n.to_string().contains("Zira"))
        })
    {
        synth.SetVoice(&v).unwrap();
    }
    synth.Options().unwrap().SetSpeakingRate(0.9).unwrap();
    let stream = synth
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))
        .unwrap()
        .join()
        .unwrap();
    let size = stream.Size().unwrap() as u32;
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).unwrap()).unwrap();
    reader.LoadAsync(size).unwrap().join().unwrap();
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).unwrap();
    std::fs::write(path, buf).unwrap();
}

/// (sample rate, channels, bits, PCM bytes) of a PCM WAV.
fn wav_pcm(bytes: &[u8]) -> (u32, u16, u16, Vec<u8>) {
    let mut i = 12;
    let (mut rate, mut ch, mut bits, mut data) = (0, 0, 0, vec![]);
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
        let body = &bytes[i + 8..(i + 8 + len).min(bytes.len())];
        if id == b"fmt " {
            ch = u16::from_le_bytes([body[2], body[3]]);
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            data = body.to_vec();
        }
        i += 8 + len + (len & 1);
    }
    (rate, ch, bits, data)
}

type Events = Arc<Mutex<Vec<(String, Value)>>>;

fn collect() -> (Events, impl Fn(&str, Value)) {
    let events: Events = Arc::default();
    let e = events.clone();
    (events, move |name: &str, v: Value| {
        e.lock().unwrap().push((name.to_string(), v))
    })
}

fn words(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect()
}

#[test]
#[ignore]
fn speech_status_reports_engines_gates_and_permissions() {
    let s = speech_status(json!({})).unwrap();
    println!(
        "speech.status = {}",
        serde_json::to_string_pretty(&s).unwrap()
    );
    for k in [
        "os",
        "gates",
        "locale",
        "engines",
        "defaultEngine",
        "permissions",
        "blockers",
        "recognizerLocales",
        "activeStreams",
        "timings",
        "microphoneBusy",
    ] {
        assert!(s.get(k).is_some(), "missing {k}");
    }
    assert_eq!(s["engines"]["sapi"]["onDevice"], true);
    assert_eq!(s["engines"]["windowsSpeech"]["onDevice"], false);
    let fr = speech_status(json!({"locale": "fr-FR"})).unwrap();
    println!("speech.status fr-FR blockers = {}", fr["blockers"]);
    assert_eq!(fr["locale"], "fr-FR");
}

#[test]
#[ignore]
fn transcribe_file_synthesized_speech() {
    let path = home().join("library").join("remind.wav");
    synthesize(REMIND, &path);
    let (events, sink) = collect();
    let inv = Invocation::new("file-1", &sink);
    let t0 = Instant::now();
    let r = speech_transcribe_file(
        json!({"path": path.to_string_lossy(), "locale": "en-US"}),
        &inv,
    )
    .unwrap();
    println!(
        "speech.transcribe_file ({:?}) = {}",
        t0.elapsed(),
        serde_json::to_string_pretty(&r).unwrap()
    );
    let text = words(r["text"].as_str().unwrap());
    for w in [
        "send", "report", "team", "meeting", "tomorrow", "morning", "call", "noon",
    ] {
        assert!(text.contains(w), "{w:?} not in {text:?}");
    }
    assert_eq!(
        (
            r["engine"].as_str(),
            r["chunks"].as_u64(),
            r["provenance"].as_str()
        ),
        (Some("sapi"), Some(1), Some("untrusted"))
    );
    assert!(r["audioMs"].as_u64().unwrap() > 2000);
    let ev = events.lock().unwrap();
    let progress: Vec<&Value> = ev
        .iter()
        .filter(|(n, _)| n == "speech.progress")
        .map(|(_, v)| v)
        .collect();
    assert_eq!(progress.len(), 2);
    assert_eq!(progress[1]["fraction"], 1.0);
}

#[test]
#[ignore]
fn transcribe_file_repo_fixture_and_folder_guard() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../packages/speech/test/fixtures/remind-alice.wav");
    let dest = home().join("library").join("remind-alice.wav");
    std::fs::copy(&fixture, &dest).unwrap();
    let (_events, sink) = collect();
    let inv = Invocation::new("file-2", &sink);
    let r = speech_transcribe_file(json!({"path": dest.to_string_lossy()}), &inv).unwrap();
    println!(
        "remind-alice.wav → {:?} ({} ms, {} segments)",
        r["text"],
        r["audioMs"],
        r["segments"].as_array().unwrap().len()
    );
    assert!(words(r["text"].as_str().unwrap()).contains("remind"));

    let outside = std::env::temp_dir().join("psyche-outside.wav");
    std::fs::copy(&fixture, &outside).unwrap();
    let e = speech_transcribe_file(json!({"path": outside.to_string_lossy()}), &inv).unwrap_err();
    assert_eq!(e.reason, "outside_granted_folders");
    let e = speech_transcribe_file(
        json!({"path": home().join("library").join("missing.wav").to_string_lossy()}),
        &inv,
    )
    .unwrap_err();
    assert_eq!(e.reason, "not_found");
    let junk = home().join("library").join("junk.wav");
    std::fs::write(&junk, b"not audio at all").unwrap();
    assert_eq!(
        speech_transcribe_file(json!({"path": junk.to_string_lossy()}), &inv)
            .unwrap_err()
            .reason,
        "unsupported_audio"
    );
    let _ = std::fs::remove_file(outside);
}

#[test]
#[ignore]
fn transcribe_stream_from_pushed_pcm() {
    let path = home().join("library").join("push.wav");
    synthesize(REMIND, &path);
    let (rate, ch, bits, pcm) = wav_pcm(&std::fs::read(&path).unwrap());
    assert_eq!((bits, ch), (16, 1));
    println!("pushing {} bytes of {rate} Hz × {ch} s16 PCM", pcm.len());
    let (r, events) = push_stream(
        "push-stream-1",
        pcm.clone(),
        json!({"encoding": "pcm_s16le", "sampleRate": rate, "channels": ch}),
        (rate / 5 * 2) as usize,
        json!({}),
    );
    println!(
        "speech.transcribe_stream (push) = {}",
        serde_json::to_string_pretty(&r).unwrap()
    );
    let ev = events.lock().unwrap();
    let names: Vec<&str> = ev.iter().map(|(n, _)| n.as_str()).collect();
    println!("events: {names:?}");
    assert_eq!(names[0], "speech.started");
    assert_eq!(ev[0].1["engine"], "sapi");
    assert_eq!(ev[0].1["format"]["sampleRate"], rate);
    assert!(names.contains(&"speech.final"));
    assert!(
        names.contains(&"speech.partial"),
        "volatile partials stream by default"
    );
    assert_eq!(
        (r["stopReason"].as_str(), r["preset"].as_str()),
        (Some("end_of_input"), Some("long"))
    );
    let text = words(r["text"].as_str().unwrap());
    assert!(
        text.contains("report") && text.contains("meeting") && text.contains("noon"),
        "{text}"
    );
    assert!(r["audioMs"].as_u64().unwrap() > 2000);
    drop(ev);

    // The same speech as 48 kHz stereo float (downmixed and resampled in the helper), capped
    // at 4 s by maxDurationMs.
    let mono: Vec<f32> = pcm
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    let mut f32_48k = Vec::with_capacity(mono.len() * 3 * 8);
    for w in mono.windows(2) {
        for k in 0..3 {
            let s = w[0] + (w[1] - w[0]) * k as f32 / 3.0;
            f32_48k.extend_from_slice(&s.to_le_bytes());
            f32_48k.extend_from_slice(&s.to_le_bytes());
        }
    }
    let (r, _) = push_stream(
        "push-stream-2",
        f32_48k,
        json!({"encoding": "pcm_f32le", "sampleRate": 48000, "channels": 2}),
        48_000 / 5 * 8,
        json!({"maxDurationMs": 4000, "volatile": false}),
    );
    println!(
        "48 kHz stereo float, capped = {}",
        serde_json::to_string(&r).unwrap()
    );
    assert_eq!(
        (r["stopReason"].as_str(), r["audioMs"].as_u64()),
        (Some("max_duration"), Some(4000))
    );
    assert!(words(r["text"].as_str().unwrap()).contains("report"));

    let status = speech_status(json!({})).unwrap();
    println!("timings after the streams: {}", status["timings"]);
}

#[test]
#[ignore]
fn windows_speech_reports_the_online_privacy_gate() {
    let online = speech_status(json!({})).unwrap()["gates"]["onlineSpeechRecognition"]
        .as_bool()
        .unwrap();
    match testing::windows_speech_probe("en-US") {
        Ok(lang) => {
            println!("Windows dictation session started for {lang}");
            assert!(online);
        }
        Err(e) => {
            println!(
                "Windows dictation refused: {}",
                serde_json::to_string(&e.wire()).unwrap()
            );
            assert!(
                !online,
                "online recognition is on, so the session should start"
            );
            assert_eq!(
                (e.reason.as_str(), e.details["permission"].as_str()),
                ("permission_missing", Some("speechRecognition"))
            );
            assert_eq!(e.details["settingsUri"], "ms-settings:privacy-speech");
        }
    }
}

/// The microphone path end to end for 1.5 s (on-device when online recognition is off). The
/// transcript of whatever the room said is not printed.
#[test]
#[ignore]
fn microphone_stream_starts_and_stops_at_the_cap() {
    let (events, sink) = collect();
    let inv = Invocation::new("mic-1", &sink);
    let r = speech_transcribe_stream(json!({"source": "microphone", "maxDurationMs": 1500}), &inv);
    match r {
        Ok(r) => {
            println!(
                "microphone stream: engine={} stopReason={} audioMs={} segments={}",
                r["engine"],
                r["stopReason"],
                r["audioMs"],
                r["segments"].as_array().unwrap().len()
            );
            assert_eq!(events.lock().unwrap()[0].0, "speech.started");
            assert_eq!(r["stopReason"], "max_duration");
            assert!((1400..=1600).contains(&r["audioMs"].as_u64().unwrap()));
            // speech.stop ends a microphone stream early; a second microphone stream is busy.
            let stopper = std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(1200));
                let busy = speech_transcribe_stream(
                    json!({"source": "microphone"}),
                    &Invocation::new("mic-3", &|_: &str, _: Value| {}),
                )
                .unwrap_err();
                assert_eq!(busy.reason, "microphone_busy");
                psyche_win_dictation::speech_stop(json!({"streamId": "mic-2"})).unwrap()
            });
            let r = speech_transcribe_stream(
                json!({"source": "microphone", "maxDurationMs": 10000}),
                &Invocation::new("mic-2", &sink),
            )
            .unwrap();
            assert_eq!(
                stopper.join().unwrap(),
                json!({"stopped": true, "streamId": "mic-2"})
            );
            println!(
                "stopped microphone stream: stopReason={} audioMs={}",
                r["stopReason"], r["audioMs"]
            );
            assert_eq!(r["stopReason"], "stopped");
            assert!(r["audioMs"].as_u64().unwrap() < 3000);
        }
        Err(e) => {
            println!(
                "microphone stream refused: {}",
                serde_json::to_string(&e.wire()).unwrap()
            );
            assert!(
                [
                    "no_input_device",
                    "permission_missing",
                    "microphone_start_failed"
                ]
                .contains(&e.reason.as_str())
            );
        }
    }
}

/// Runs `speech.transcribe_stream {source: push}` for `pcm`, pushed from another thread in
/// `chunk`-byte pieces with `final` on the last.
fn push_stream(
    id: &'static str,
    pcm: Vec<u8>,
    format: Value,
    chunk: usize,
    extra: Value,
) -> (Value, Events) {
    let pusher = std::thread::spawn(move || {
        use base64::Engine as _;
        let pieces: Vec<&[u8]> = pcm.chunks(chunk).collect();
        for (i, piece) in pieces.iter().enumerate() {
            let data = base64::engine::general_purpose::STANDARD.encode(piece);
            let last = i + 1 == pieces.len();
            loop {
                match speech_audio_push(json!({"streamId": id, "data": data, "final": last})) {
                    Ok(r) => {
                        assert_eq!(r["accepted"].as_u64(), Some(piece.len() as u64));
                        break;
                    }
                    Err(e) if e.reason == "stream_finished" => return, // the duration cap ended it
                    Err(e) if e.retryable => std::thread::sleep(Duration::from_millis(20)),
                    Err(e) => panic!("push failed: {e}"),
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    });
    let (events, sink) = collect();
    let inv = Invocation::new(id, &sink);
    let mut params = json!({"source": "push", "format": format, "locale": "en-US"});
    for (k, v) in extra.as_object().unwrap() {
        params[k] = v.clone();
    }
    let r = speech_transcribe_stream(params, &inv).unwrap();
    pusher.join().unwrap();
    (r, events)
}

#[test]
#[ignore]
fn hook_ignores_injected_keys_and_reports_hardware_ones() {
    let events: Arc<Mutex<Vec<Value>>> = Arc::default();
    let e2 = events.clone();
    let watch = std::thread::spawn(move || {
        let sink = move |_: &str, v: Value| e2.lock().unwrap().push(v);
        let inv = Invocation::new("watch-1", &sink);
        dictation_watch(json!({"key": "rightCommand"}), &inv)
    });
    let wait = |n: usize| {
        let t = Instant::now();
        while events.lock().unwrap().len() < n && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    wait(1);
    assert_eq!(
        events.lock().unwrap()[0]["down"],
        false,
        "initial state once the hook is in"
    );
    assert!(testing::watch_active());

    // SendInput events reach the hook flagged injected and are ignored.
    let before = testing::injected_seen();
    assert!(testing::send_key(VK_RCONTROL, true) && testing::send_key(VK_RCONTROL, false));
    let t = Instant::now();
    while testing::injected_seen() < before + 2 && t.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(10));
    }
    println!(
        "injected events seen by the hook: {}",
        testing::injected_seen() - before
    );
    assert!(testing::injected_seen() >= before + 2);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(events.lock().unwrap().len(), 1);

    // A hardware-looking press: down (with auto-repeat), up.
    let hw = |vk, down| KeyEvent {
        vk,
        scan: 0x1D,
        down,
        injected: false,
    };
    for _ in 0..3 {
        testing::simulate_hook_event(hw(VK_RCONTROL, true));
    }
    testing::simulate_hook_event(hw(VK_RCONTROL, false));
    // A chord (Right Ctrl + C) ends the hold at once and swallows the release.
    testing::simulate_hook_event(hw(VK_RCONTROL, true));
    testing::simulate_hook_event(hw(0x43, true));
    testing::simulate_hook_event(hw(0x43, false));
    testing::simulate_hook_event(hw(VK_RCONTROL, false));
    wait(5);
    std::thread::sleep(Duration::from_millis(200));
    let downs: Vec<bool> = events
        .lock()
        .unwrap()
        .iter()
        .map(|v| v["down"].as_bool().unwrap())
        .collect();
    println!(
        "dictation.watch events: {}",
        serde_json::to_string(&*events.lock().unwrap()).unwrap()
    );
    assert_eq!(downs, [false, true, false, true, false]);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .all(|v| v["key"] == "rightCommand"
                && v.get("role").is_none()
                && v["at"].as_str().unwrap().ends_with('Z'))
    );

    // key: null ends the watch; the streaming call returns {watching: false}.
    let sink = |_: &str, _: Value| {};
    let r = dictation_watch(json!({"key": null}), &Invocation::new("watch-2", &sink)).unwrap();
    assert_eq!(r, json!({"watching": false}));
    assert_eq!(watch.join().unwrap().unwrap(), json!({"watching": false}));
    assert!(!testing::watch_active());

    // A two-key watch with roles; a newer watch replaces it.
    let events2: Arc<Mutex<Vec<Value>>> = Arc::default();
    let e3 = events2.clone();
    let w2 = std::thread::spawn(move || {
        let sink = move |_: &str, v: Value| e3.lock().unwrap().push(v);
        dictation_watch(
            json!({"keys": [{"key": "fn", "role": "dictation"}, {"key": "rightCommand", "role": "voice"}]}),
            &Invocation::new("watch-3", &sink),
        )
    });
    let t = Instant::now();
    while events2.lock().unwrap().len() < 2 && t.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let roles: Vec<String> = events2
        .lock()
        .unwrap()
        .iter()
        .map(|v| v["role"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(roles, ["dictation", "voice"]);
    let w3 = std::thread::spawn(|| {
        let sink = |_: &str, _: Value| {};
        dictation_watch(
            json!({"key": "rightOption"}),
            &Invocation::new("watch-4", &sink),
        )
    });
    assert_eq!(
        w2.join().unwrap().unwrap(),
        json!({"watching": false}),
        "replaced by the newer watch"
    );
    std::thread::sleep(Duration::from_millis(100));
    dictation_watch(
        json!({"key": null}),
        &Invocation::new("watch-5", &|_: &str, _: Value| {}),
    )
    .unwrap();
    w3.join().unwrap().unwrap();

    // A Right Alt hold gets the menu mask (an injected unassigned key) after 200 ms, so its
    // release opens no menu bar; on an AltGr layout (fake Left Ctrl first) it does not.
    let ralt = std::thread::spawn(|| {
        let sink = |_: &str, _: Value| {};
        dictation_watch(
            json!({"key": "rightOption"}),
            &Invocation::new("watch-7", &sink),
        )
    });
    std::thread::sleep(Duration::from_millis(300));
    let before = testing::injected_seen();
    testing::simulate_hook_event(KeyEvent {
        vk: 0xA5,
        scan: 0x38,
        down: true,
        injected: false,
    });
    std::thread::sleep(Duration::from_millis(500));
    testing::simulate_hook_event(KeyEvent {
        vk: 0xA5,
        scan: 0x38,
        down: false,
        injected: false,
    });
    let masked = testing::injected_seen() - before;
    testing::simulate_hook_event(KeyEvent {
        vk: 0xA2,
        scan: 0x21D,
        down: true,
        injected: false,
    });
    testing::simulate_hook_event(KeyEvent {
        vk: 0xA5,
        scan: 0x38,
        down: true,
        injected: false,
    });
    std::thread::sleep(Duration::from_millis(500));
    testing::simulate_hook_event(KeyEvent {
        vk: 0xA5,
        scan: 0x38,
        down: false,
        injected: false,
    });
    testing::simulate_hook_event(KeyEvent {
        vk: 0xA2,
        scan: 0x21D,
        down: false,
        injected: false,
    });
    let altgr = testing::injected_seen() - before - masked;
    println!(
        "menu mask: {masked} injected events for a Right Alt hold, {altgr} on an AltGr layout"
    );
    assert_eq!((masked, altgr), (2, 0));
    dictation_watch(
        json!({"key": null}),
        &Invocation::new("watch-8", &|_: &str, _: Value| {}),
    )
    .unwrap();
    ralt.join().unwrap().unwrap();

    // Cancelling the invocation ends its watch.
    let (tx, rx) = std::sync::mpsc::channel();
    let w4 = std::thread::spawn(move || {
        let sink = |_: &str, _: Value| {};
        let inv = Invocation::new("watch-6", &sink);
        tx.send(inv.cancel.clone()).unwrap();
        dictation_watch(json!({"key": "rightCommand"}), &inv)
    });
    let token = rx.recv().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(testing::watch_active());
    token.cancel();
    assert_eq!(w4.join().unwrap().unwrap(), json!({"watching": false}));
    assert!(!testing::watch_active());
}

/// Brings `hwnd` to the front: a synthesized Alt tap first, so Windows lets this background
/// test process set the foreground window.
fn focus(hwnd: HWND) -> bool {
    // SAFETY: plain window calls.
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        for _ in 0..20 {
            // Alt with the unassigned 0xE8 key inside, so no window enters menu mode.
            keybd_event(0x12, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(0xE8, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(0xE8, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(0x12, 0, KEYEVENTF_KEYUP, 0);
            // Share the foreground thread's input state so SetForegroundWindow is allowed.
            let fg = GetForegroundWindow();
            let fg_thread = GetWindowThreadProcessId(fg, None);
            let me = GetCurrentThreadId();
            let attached = fg_thread != 0
                && fg_thread != me
                && AttachThreadInput(me, fg_thread, true).as_bool();
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            if attached {
                let _ = AttachThreadInput(me, fg_thread, false);
            }
            std::thread::sleep(Duration::from_millis(150));
            if GetForegroundWindow() == hwnd {
                return true;
            }
        }
        let mut title = [0u16; 256];
        let n = GetWindowTextW(GetForegroundWindow(), &mut title);
        println!(
            "foreground stayed on {:?}",
            String::from_utf16_lossy(&title[..n as usize])
        );
        false
    }
}

fn find_window(title: &str, limit: Duration) -> Option<HWND> {
    let w: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    let t = Instant::now();
    while t.elapsed() < limit {
        // SAFETY: lookup by exact title.
        if let Ok(h) = unsafe { FindWindowW(PCWSTR::null(), PCWSTR(w.as_ptr())) }
            && !h.is_invalid()
        {
            return Some(h);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

struct Kill(Child);

impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A test window in a separate PowerShell process: `wpf` = a WPF TextBox (UIA Edit with
/// ValuePattern and TextPattern), else a WinForms TextBox (a Win32 EDIT, whose UIA proxy has
/// ValuePattern but no TextPattern).
fn text_window(title: &str, wpf: bool) -> (Kill, HWND) {
    let script = if wpf {
        format!(
            "Add-Type -AssemblyName PresentationFramework; $w = New-Object System.Windows.Window; $w.Title = '{title}'; $w.Topmost = $true; \
             $w.Width = 600; $w.Height = 300; $t = New-Object System.Windows.Controls.TextBox; $t.AcceptsReturn = $true; $w.Content = $t; \
             $w.Add_ContentRendered({{ $w.Activate(); [void]$t.Focus() }}); [void]$w.ShowDialog()"
        )
    } else {
        format!(
            "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = '{title}'; $f.TopMost = $true; \
             $f.Width = 600; $f.Height = 300; $t = New-Object System.Windows.Forms.TextBox; $t.Multiline = $true; $t.Dock = 'Fill'; \
             $f.Controls.Add($t); $f.Add_Shown({{ $f.Activate(); $t.Focus() }}); [System.Windows.Forms.Application]::Run($f)"
        )
    };
    let child = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-Command", &script])
        .spawn()
        .unwrap();
    let kill = Kill(child);
    let hwnd = find_window(title, Duration::from_secs(30)).expect("the test window appears");
    assert!(focus(hwnd), "the test window takes focus");
    std::thread::sleep(Duration::from_millis(500));
    (kill, hwnd)
}

#[test]
#[ignore]
fn insert_into_a_win32_edit_falls_back_to_typing() {
    let (proc_, _hwnd) = text_window("PsycheDictationTest-WinForms", false);
    let pid = proc_.0.id();
    let target = dictation_target(json!({})).unwrap();
    println!("dictation.target (WinForms) = {target}");
    assert_eq!(
        (
            target["target"]["pid"].as_u64(),
            target["target"]["role"].as_str()
        ),
        (Some(pid as u64), Some("Edit"))
    );
    assert!(
        !testing::insert_with("uia", "nope", pid).unwrap(),
        "no TextPattern: the caret could not be kept"
    );
    let r = dictation_insert(json!({"text": "typed into WinForms", "expectPid": pid})).unwrap();
    assert_eq!(r["method"], "typed");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        testing::focused_value().as_deref(),
        Some("typed into WinForms")
    );
}

#[test]
#[ignore]
fn insert_strategies_into_a_native_edit_control_and_restore_the_clipboard() {
    let (proc_, _hwnd) = text_window("PsycheDictationTest-WPF", true);
    let pid = proc_.0.id();
    let target = dictation_target(json!({})).unwrap();
    println!("dictation.target = {target}");
    assert_eq!(target["target"]["pid"], pid);
    assert_eq!(target["target"]["role"], "Edit");
    assert_eq!(target["target"]["insertable"], true);
    assert_eq!(target["target"]["bundleId"], "powershell.exe");

    // UIA write (selection replaced, caret after the text), then typing continues at the caret.
    assert!(testing::insert_with("uia", "alpha", pid).unwrap());
    assert_eq!(testing::focused_value().as_deref(), Some("alpha"));
    assert!(testing::insert_with("typed", " beta é 👍", pid).unwrap());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        testing::focused_value().as_deref(),
        Some("alpha beta é 👍"),
        "typing landed at the caret the UIA write left"
    );

    // Paste with the clipboard saved and restored.
    let before = testing::clipboard_snapshot().expect("clipboard readable");
    assert!(
        testing::insert_with("paste", " gamma", pid).unwrap(),
        "the edit control read the pasted text"
    );
    let after = testing::clipboard_snapshot().unwrap();
    println!(
        "clipboard formats before/after paste: {:?} / {:?}",
        before
            .iter()
            .map(|(f, b)| (*f, b.len()))
            .collect::<Vec<_>>(),
        after.iter().map(|(f, b)| (*f, b.len())).collect::<Vec<_>>()
    );
    for item in &before {
        assert!(
            after.contains(item),
            "format {} is back, byte for byte",
            item.0
        );
    }
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        testing::focused_value().as_deref(),
        Some("alpha beta é 👍 gamma")
    );

    // The capability path: policy, strategy order (UIA first here), wire shape.
    let r = dictation_insert(json!({"text": "\tand\ndelta", "expectPid": pid})).unwrap();
    println!("dictation.insert = {r}");
    assert_eq!(
        (r["method"].as_str(), r["chars"].as_u64()),
        (Some("ax"), Some(9))
    );
    assert_eq!(
        testing::focused_value().as_deref(),
        Some("alpha beta é 👍 gammaand delta")
    );
    let e = dictation_insert(json!({"text": "x", "expectPid": 1})).unwrap_err();
    assert_eq!(e.reason, "focus_changed");
}

fn running(name: &str) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .to_lowercase()
        .contains(&name.to_lowercase())
}

#[test]
#[ignore]
fn insert_into_notepad() {
    if running("notepad.exe") {
        println!(
            "SKIPPED: Notepad is already open on this desktop; the test never types into the owner's Notepad windows"
        );
        return;
    }
    let file = home().join("notepad-target.txt");
    std::fs::write(&file, "").unwrap();
    let _child = Kill(Command::new("notepad.exe").arg(&file).spawn().unwrap());
    let hwnd = find_window("notepad-target.txt - Notepad", Duration::from_secs(20))
        .expect("Notepad opens the file");
    assert!(focus(hwnd));
    std::thread::sleep(Duration::from_millis(800));
    let target = dictation_target(json!({})).unwrap();
    println!("dictation.target (Notepad) = {target}");
    assert_eq!(target["target"]["insertable"], true);
    let pid = target["target"]["pid"].as_u64().unwrap() as u32;

    // UIA write is not used for Notepad's rich edit document.
    assert!(!testing::insert_with("uia", "nope", pid).unwrap());
    let r = dictation_insert(json!({"text": "typed into notepad.", "expectPid": pid})).unwrap();
    assert_eq!(r["method"], "typed");
    std::thread::sleep(Duration::from_millis(300));
    let before = testing::clipboard_snapshot().unwrap();
    let long = " ".to_string() + &"pasted words ".repeat(30);
    let r = dictation_insert(json!({"text": long, "expectPid": pid})).unwrap();
    assert_eq!(r["method"], "typed");
    std::thread::sleep(Duration::from_millis(300));
    let text = testing::focused_value().unwrap_or_default();
    println!("Notepad now holds {} characters", text.chars().count());
    assert!(text.starts_with("typed into notepad.pasted words"));
    let after = testing::clipboard_snapshot().unwrap();
    assert!(
        before.iter().all(|i| after.contains(i)),
        "clipboard restored"
    );
    // Close our Notepad (no other Notepad was open).
    let _ = Command::new("taskkill")
        .args(["/IM", "notepad.exe", "/F"])
        .output();
}
