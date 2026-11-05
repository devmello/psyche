//! The always-visible sign that "Record in an app" is running (the Mac's menu-bar item): a small
//! topmost pill at the top of the primary screen, "Recording <app>", with its own **Stop
//! recording** button. It does not take focus (`WS_EX_NOACTIVATE`), so the app being recorded keeps
//! the keyboard, and it belongs to the helper's process, so the recorder never describes it. The
//! owner can end a recording from it whether or not the Psyche window is in front or even running.

use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    DEFAULT_GUI_FONT, GetDC, GetDeviceCaps, GetStockObject, LOGPIXELSX, ReleaseDC,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{HSTRING, w};

use super::controller::Indicator;

const STOP_ID: usize = 1001;
// Static control styles: left-aligned without wrapping, centred vertically.
const SS_LEFTNOWORDWRAP: u32 = 0x0000_000C;
const SS_CENTERIMAGE: u32 = 0x0000_0200;

type OnStop = Arc<dyn Fn() + Send + Sync>;

/// What the window procedure needs, owned by the window (`GWLP_USERDATA`).
struct Data {
    on_stop: OnStop,
}

#[derive(Default)]
pub struct LiveIndicator {
    /// The window's handle (as an integer), once the indicator thread created it.
    hwnd: Mutex<Option<isize>>,
}

unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_COMMAND if (wp.0 & 0xFFFF) == STOP_ID => {
                let p = GetWindowLongPtrW(h, GWLP_USERDATA) as *const Data;
                if !p.is_null() {
                    let on_stop = (*p).on_stop.clone();
                    // Off the window thread: Stop tears this window down.
                    std::thread::spawn(move || on_stop());
                }
                LRESULT(0)
            }
            WM_CLOSE => {
                let _ = DestroyWindow(h);
                LRESULT(0)
            }
            WM_DESTROY => {
                let p = SetWindowLongPtrW(h, GWLP_USERDATA, 0) as *mut Data;
                if !p.is_null() {
                    drop(Box::from_raw(p));
                }
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(h, msg, wp, lp),
        }
    }
}

fn scale() -> f64 {
    unsafe {
        let dc = GetDC(None);
        let dpi = if dc.0.is_null() {
            96
        } else {
            GetDeviceCaps(Some(dc), LOGPIXELSX)
        };
        if !dc.0.is_null() {
            ReleaseDC(None, dc);
        }
        f64::from(dpi.max(96)) / 96.0
    }
}

fn run(app_name: String, on_stop: OnStop, ready: std::sync::mpsc::Sender<Option<isize>>) {
    psyche_win_computer::win::com::ensure_dpi_awareness();
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else {
            let _ = ready.send(None);
            return;
        };
        let instance: windows::Win32::Foundation::HINSTANCE = module.into();
        let class = w!("PsycheTeachIndicator");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: instance,
            lpszClassName: class,
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(
                (windows::Win32::Graphics::Gdi::COLOR_WINDOW.0 + 1) as isize as *mut _,
            ),
            ..Default::default()
        };
        // A second registration of the same class fails harmlessly.
        RegisterClassW(&wc);
        let k = scale();
        let (width, height) = ((420.0 * k) as i32, (40.0 * k) as i32);
        let mut work = RECT::default();
        let _ = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut work as *mut RECT as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        let x = work.left + ((work.right - work.left) - width) / 2;
        let y = work.top + (8.0 * k) as i32;
        let title = format!("Psyche is recording in {app_name}");
        let Ok(hwnd) = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            &HSTRING::from(title.as_str()),
            WS_POPUP | WS_BORDER | WS_VISIBLE,
            x,
            y,
            width,
            height,
            None,
            None,
            Some(instance),
            None,
        ) else {
            let _ = ready.send(None);
            return;
        };
        let label = format!("\u{25CF} Recording {app_name}");
        let pad = (10.0 * k) as i32;
        let button_w = (130.0 * k) as i32;
        let text = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            &HSTRING::from(label.as_str()),
            WS_CHILD | WS_VISIBLE | WINDOW_STYLE(SS_LEFTNOWORDWRAP | SS_CENTERIMAGE),
            pad,
            0,
            width - button_w - pad * 3,
            height,
            Some(hwnd),
            None,
            Some(instance),
            None,
        );
        let button = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("BUTTON"),
            w!("Stop recording"),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(BS_PUSHBUTTON as u32),
            width - button_w - pad,
            (6.0 * k) as i32,
            button_w,
            height - (14.0 * k) as i32,
            Some(hwnd),
            Some(windows::Win32::UI::WindowsAndMessaging::HMENU(
                STOP_ID as *mut _,
            )),
            Some(instance),
            None,
        );
        let font = GetStockObject(DEFAULT_GUI_FONT);
        for c in [text, button].into_iter().flatten() {
            SendMessageW(
                c,
                WM_SETFONT,
                Some(WPARAM(font.0 as usize)),
                Some(LPARAM(1)),
            );
        }
        SetWindowLongPtrW(
            hwnd,
            GWLP_USERDATA,
            Box::into_raw(Box::new(Data { on_stop })) as isize,
        );
        let _ = ready.send(Some(hwnd.0 as isize));
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

impl Indicator for LiveIndicator {
    fn show(&self, app_name: &str, on_stop: OnStop) {
        self.hide();
        let (tx, rx) = std::sync::mpsc::channel();
        let name = app_name.to_owned();
        if std::thread::Builder::new()
            .name("psyche-teach-indicator".into())
            .spawn(move || run(name, on_stop, tx))
            .is_err()
        {
            return;
        }
        if let Ok(Some(h)) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
            *self.hwnd.lock().unwrap_or_else(|p| p.into_inner()) = Some(h);
        }
    }

    fn hide(&self) {
        let h = self.hwnd.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(h) = h {
            unsafe {
                let _ = PostMessageW(Some(HWND(h as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
}

/// The indicator's window (live tests): its handle while it is showing.
#[cfg(test)]
impl LiveIndicator {
    pub(crate) fn window(&self) -> Option<isize> {
        *self.hwnd.lock().unwrap_or_else(|p| p.into_inner())
    }
}
