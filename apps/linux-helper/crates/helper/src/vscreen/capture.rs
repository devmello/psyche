//! Frame capture of the virtual display's root window: XShm when the server has it (it always
//! does on Xvfb), plain `GetImage` otherwise. Frames are pulled (`vscreen.frame`), never
//! streamed: nothing is captured when nobody asks.
//!
//! A frame is a JPEG of the screen. A hash of the raw pixels decides whether the screen changed,
//! and `frame_seq` counts the changes, so the watch pane can ask "anything new since N?" and get
//! an empty answer for the price of one capture and one hash.

use std::sync::Arc;
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, Window};
use x11rb::rust_connection::RustConnection;

/// Raw pixels in X's 32-bit little-endian layout: B, G, R, unused.
pub struct Raw<'a> {
    pub width: u32,
    pub height: u32,
    pub bgrx: &'a [u8],
}

struct Segment {
    id: i32,
    ptr: *mut u8,
    len: usize,
    seg: shm::Seg,
}

// SAFETY: the segment is only touched while holding the Capturer's mutex.
unsafe impl Send for Segment {}

impl Drop for Segment {
    fn drop(&mut self) {
        // SAFETY: `ptr` came from shmat and is detached once.
        unsafe {
            libc::shmdt(self.ptr as *const libc::c_void);
        }
        let _ = self.id;
    }
}

pub struct Capturer {
    conn: Arc<RustConnection>,
    root: Window,
    width: u32,
    height: u32,
    shm: Option<Segment>,
    copy: Vec<u8>,
    last_hash: u64,
    pub seq: u64,
    last_at: Option<Instant>,
    jpeg: Option<(u64, u32, Vec<u8>)>,
}

impl Capturer {
    pub fn new(conn: Arc<RustConnection>, screen_num: usize) -> Result<Self, String> {
        let screen = &conn.setup().roots[screen_num];
        let (root, width, height) = (
            screen.root,
            u32::from(screen.width_in_pixels),
            u32::from(screen.height_in_pixels),
        );
        let fmt = conn
            .setup()
            .pixmap_formats
            .iter()
            .find(|f| f.depth == screen.root_depth)
            .ok_or("no pixmap format for the root depth")?;
        if fmt.bits_per_pixel != 32 {
            return Err(format!("unsupported pixel format ({} bpp)", fmt.bits_per_pixel));
        }
        let shm = Self::attach(&conn, width, height);
        Ok(Self {
            conn,
            root,
            width,
            height,
            shm,
            copy: Vec::new(),
            last_hash: 0,
            seq: 0,
            last_at: None,
            jpeg: None,
        })
    }

    pub fn uses_shm(&self) -> bool {
        self.shm.is_some()
    }

    fn attach(conn: &RustConnection, width: u32, height: u32) -> Option<Segment> {
        conn.shm_query_version().ok()?.reply().ok()?;
        let len = (width * height * 4) as usize;
        // SAFETY: plain SysV calls; the segment is marked for removal right after the server
        // attached it, so it disappears when both sides let go.
        unsafe {
            let id = libc::shmget(libc::IPC_PRIVATE, len, libc::IPC_CREAT | 0o600);
            if id < 0 {
                return None;
            }
            let ptr = libc::shmat(id, std::ptr::null(), 0);
            if ptr as isize == -1 {
                libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
                return None;
            }
            let seg = conn.generate_id().ok()?;
            let ok = shm::attach(conn, seg, id as u32, false)
                .ok()
                .and_then(|c| c.check().ok())
                .is_some();
            libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
            if !ok {
                libc::shmdt(ptr as *const libc::c_void);
                return None;
            }
            Some(Segment { id, ptr: ptr as *mut u8, len, seg })
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Grabs the screen into an internal buffer.
    fn grab(&mut self) -> Result<(), String> {
        let (w, h) = (self.width as u16, self.height as u16);
        if let Some(seg) = &self.shm {
            let reply = self
                .conn
                .shm_get_image(self.root, 0, 0, w, h, !0, ImageFormat::Z_PIXMAP.into(), seg.seg, 0)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            let n = (reply.size as usize).min(seg.len);
            self.copy.clear();
            // SAFETY: the server wrote `size` bytes into the segment before it replied.
            self.copy
                .extend_from_slice(unsafe { std::slice::from_raw_parts(seg.ptr, n) });
        } else {
            let reply = self
                .conn
                .get_image(ImageFormat::Z_PIXMAP, self.root, 0, 0, w, h, !0)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            self.copy = reply.data;
        }
        if self.copy.len() < (self.width * self.height * 4) as usize {
            return Err("short image".into());
        }
        Ok(())
    }

    /// Captures if the last capture is older than `max_age`, and bumps `seq` when the pixels
    /// changed. Returns the current sequence number.
    pub fn refresh(&mut self, max_age: Duration) -> Result<u64, String> {
        if self.last_at.is_some_and(|t| t.elapsed() < max_age) {
            return Ok(self.seq);
        }
        self.grab()?;
        self.last_at = Some(Instant::now());
        let h = hash_pixels(&self.copy);
        if h != self.last_hash || self.seq == 0 {
            self.last_hash = h;
            self.seq += 1;
            self.jpeg = None;
        }
        Ok(self.seq)
    }

    pub fn raw(&self) -> Raw<'_> {
        Raw { width: self.width, height: self.height, bgrx: &self.copy }
    }

    /// The JPEG of the current screen at most `max_width` wide.
    pub fn jpeg(&mut self, max_width: Option<u32>, quality: u8) -> Result<(Vec<u8>, u32, u32), String> {
        let target = max_width.map(|m| m.min(self.width)).unwrap_or(self.width).max(16);
        if let Some((seq, w, bytes)) = &self.jpeg {
            if *seq == self.seq && *w == target {
                let h = scaled_height(self.width, self.height, target);
                return Ok((bytes.clone(), target, h));
            }
        }
        let (rgb, w, h) = to_rgb_scaled(&self.raw(), target);
        let mut out = Vec::with_capacity(64 * 1024);
        jpeg_encoder::Encoder::new(&mut out, quality)
            .encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
            .map_err(|e| e.to_string())?;
        self.jpeg = Some((self.seq, target, out.clone()));
        Ok((out, w, h))
    }
}

fn scaled_height(sw: u32, sh: u32, tw: u32) -> u32 {
    ((u64::from(sh) * u64::from(tw)) / u64::from(sw)).max(1) as u32
}

/// FNV-style hash over 8-byte words: cheap, and plenty to notice a changed screen.
pub fn hash_pixels(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut chunks = bytes.chunks_exact(8);
    for c in &mut chunks {
        let w = u64::from_le_bytes(c.try_into().expect("8 bytes"));
        h = (h ^ w).wrapping_mul(0x0100_0000_01b3).rotate_left(5);
    }
    for b in chunks.remainder() {
        h = (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// BGRX -> RGB, shrunk to `target_width` by averaging the source pixels of each target pixel
/// (nearest-neighbour when the ratio is under 2).
pub fn to_rgb_scaled(raw: &Raw<'_>, target_width: u32) -> (Vec<u8>, u32, u32) {
    let tw = target_width.clamp(1, raw.width);
    let th = scaled_height(raw.width, raw.height, tw);
    let mut out = Vec::with_capacity((tw * th * 3) as usize);
    let stride = raw.width as usize * 4;
    for ty in 0..th {
        let sy0 = (u64::from(ty) * u64::from(raw.height) / u64::from(th)) as usize;
        let sy1 = ((u64::from(ty + 1) * u64::from(raw.height) / u64::from(th)) as usize).max(sy0 + 1);
        for tx in 0..tw {
            let sx0 = (u64::from(tx) * u64::from(raw.width) / u64::from(tw)) as usize;
            let sx1 = ((u64::from(tx + 1) * u64::from(raw.width) / u64::from(tw)) as usize).max(sx0 + 1);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for sy in sy0..sy1.min(raw.height as usize) {
                for sx in sx0..sx1.min(raw.width as usize) {
                    let i = sy * stride + sx * 4;
                    b += u32::from(raw.bgrx[i]);
                    g += u32::from(raw.bgrx[i + 1]);
                    r += u32::from(raw.bgrx[i + 2]);
                    n += 1;
                }
            }
            let n = n.max(1);
            out.extend_from_slice(&[(r / n) as u8, (g / n) as u8, (b / n) as u8]);
        }
    }
    (out, tw, th)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, bgr: [u8; 3]) -> Vec<u8> {
        (0..w * h).flat_map(|_| [bgr[0], bgr[1], bgr[2], 0]).collect()
    }

    #[test]
    fn the_hash_notices_one_changed_pixel() {
        let mut a = solid(64, 40, [1, 2, 3]);
        let h1 = hash_pixels(&a);
        assert_eq!(h1, hash_pixels(&a));
        a[4 * 100] ^= 1;
        assert_ne!(h1, hash_pixels(&a));
        // A length that is not a multiple of 8 still hashes its tail.
        let mut b = vec![0u8; 13];
        let hb = hash_pixels(&b);
        b[12] = 1;
        assert_ne!(hb, hash_pixels(&b));
    }

    #[test]
    fn colours_are_swapped_to_rgb() {
        let px = solid(2, 2, [10, 20, 30]); // B=10 G=20 R=30
        let (rgb, w, h) = to_rgb_scaled(&Raw { width: 2, height: 2, bgrx: &px }, 2);
        assert_eq!((w, h), (2, 2));
        assert_eq!(&rgb[..3], &[30, 20, 10]);
    }

    #[test]
    fn shrinking_averages_and_keeps_the_aspect_ratio() {
        // Left half black, right half white, 8x4 -> 4x2.
        let mut px = Vec::new();
        for _y in 0..4 {
            for x in 0..8 {
                let v = if x < 4 { 0 } else { 255 };
                px.extend_from_slice(&[v, v, v, 0]);
            }
        }
        let (rgb, w, h) = to_rgb_scaled(&Raw { width: 8, height: 4, bgrx: &px }, 4);
        assert_eq!((w, h), (4, 2));
        assert_eq!(rgb[0], 0);
        assert_eq!(rgb[(3 * 3) as usize], 255);
        // Asking for more than the screen has gives the screen size.
        let (_, w2, h2) = to_rgb_scaled(&Raw { width: 8, height: 4, bgrx: &px }, 100);
        assert_eq!((w2, h2), (8, 4));
    }

    #[test]
    fn a_jpeg_comes_out_with_the_magic_bytes() {
        let px = solid(32, 20, [200, 100, 50]);
        let (rgb, w, h) = to_rgb_scaled(&Raw { width: 32, height: 20, bgrx: &px }, 32);
        let mut out = Vec::new();
        jpeg_encoder::Encoder::new(&mut out, 70)
            .encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        assert_eq!(&out[..2], &[0xff, 0xd8]);
    }
}
