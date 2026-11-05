//! A tiny X11 client for the virtual-screen tests: one window, and (with `--unsaved`) a
//! "Save changes?" dialog instead of closing when asked to. Not shipped.

use x11rb::connection::Connection;
use x11rb::protocol::xproto::*;
use x11rb::protocol::Event;
use x11rb::rust_connection::{DefaultStream, RustConnection};
use x11rb::wrapper::ConnectionExt as _;

fn main() {
    if std::env::args().any(|a| a == "--no-window") {
        // An app that hands its window to someone else: it never opens one here.
        std::thread::sleep(std::time::Duration::from_secs(60));
        return;
    }
    // x11rb only looks for the socket file; under WSLg Xvfb has the abstract socket alone, so
    // connect the way the helper does, with the cookie from XAUTHORITY (its last 16 bytes).
    let display: u32 = std::env::var("DISPLAY")
        .unwrap()
        .trim_start_matches(':')
        .parse()
        .unwrap();
    let auth = std::fs::read(std::env::var("XAUTHORITY").unwrap()).unwrap();
    let (stream, _) = DefaultStream::from_unix_stream(
        psyche_helper::vscreen::xvfb::connect_stream(display).unwrap(),
    )
    .unwrap();
    let conn = RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        auth[auth.len() - 16..].to_vec(),
    )
    .expect("connect");
    let screen_num = 0;
    let screen = &conn.setup().roots[screen_num];
    let protocols = conn
        .intern_atom(false, b"WM_PROTOCOLS")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let delete = conn
        .intern_atom(false, b"WM_DELETE_WINDOW")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let make = |title: &str, w: u16, h: u16, parent: Option<Window>| {
        let id = conn.generate_id().unwrap();
        conn.create_window(
            screen.root_depth,
            id,
            screen.root,
            0,
            0,
            w,
            h,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new()
                .background_pixel(screen.white_pixel)
                .event_mask(EventMask::EXPOSURE | EventMask::KEY_PRESS),
        )
        .unwrap();
        conn.change_property8(
            PropMode::REPLACE,
            id,
            AtomEnum::WM_NAME,
            AtomEnum::STRING,
            title.as_bytes(),
        )
        .unwrap();
        conn.change_property32(PropMode::REPLACE, id, protocols, AtomEnum::ATOM, &[delete])
            .unwrap();
        if let Some(p) = parent {
            conn.change_property32(
                PropMode::REPLACE,
                id,
                AtomEnum::WM_TRANSIENT_FOR,
                AtomEnum::WINDOW,
                &[p],
            )
            .unwrap();
        }
        conn.map_window(id).unwrap();
        id
    };
    let main = make("Fake document", 400, 300, None);
    conn.flush().unwrap();
    let unsaved = std::env::args().any(|a| a == "--unsaved");
    let mut dialog = None;
    loop {
        match conn.wait_for_event() {
            Ok(Event::ClientMessage(e)) if e.format == 32 && e.data.as_data32()[0] == delete => {
                if e.window == main && unsaved && dialog.is_none() {
                    dialog = Some(make("Save changes?", 300, 120, Some(main)));
                    conn.flush().unwrap();
                } else if Some(e.window) == dialog {
                    // "Keep it open": the dialog goes away, the document stays.
                    conn.destroy_window(e.window).unwrap();
                    dialog = None;
                    conn.flush().unwrap();
                } else {
                    return;
                }
            }
            Ok(_) => {}
            Err(_) => return,
        }
    }
}
