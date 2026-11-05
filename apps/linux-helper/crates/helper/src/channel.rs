//! Reads frames from a byte stream that has a short read timeout, so callers can interleave
//! other work (idle checks, deadlines, stop flags) with waiting for the Gateway.

use std::collections::VecDeque;
use std::io::{ErrorKind, Read};

use psyche_protocol::frame::{FrameError, Incoming, LineBuffer};

#[derive(Debug)]
pub enum HelperError {
    Io(std::io::Error),
    Frame(FrameError),
    /// The Gateway answered `connect` or `connect.verify` with an error.
    Gateway {
        code: String,
    },
    /// A frame that cannot belong to the handshake.
    Unexpected(&'static str),
    Timeout,
    Closed,
}

impl std::fmt::Display for HelperError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HelperError::Io(e) => write!(f, "i/o error: {e}"),
            HelperError::Frame(e) => write!(f, "{e}"),
            HelperError::Gateway { code } => write!(f, "Gateway refused the handshake: {code}"),
            HelperError::Unexpected(what) => write!(f, "unexpected frame from the Gateway: {what}"),
            HelperError::Timeout => write!(f, "the Gateway did not answer in time"),
            HelperError::Closed => write!(f, "the Gateway closed the connection"),
        }
    }
}

impl std::error::Error for HelperError {}

impl From<std::io::Error> for HelperError {
    fn from(e: std::io::Error) -> Self {
        HelperError::Io(e)
    }
}

impl From<FrameError> for HelperError {
    fn from(e: FrameError) -> Self {
        HelperError::Frame(e)
    }
}

pub enum Read1 {
    Frame(Incoming),
    /// The read timeout elapsed with no complete frame.
    Tick,
    /// The peer closed the stream.
    Closed,
}

pub struct FrameReader<R: Read> {
    inner: R,
    buffer: LineBuffer,
    queued: VecDeque<Incoming>,
}

impl<R: Read> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buffer: LineBuffer::default(),
            queued: VecDeque::new(),
        }
    }

    /// The next frame, `Tick` when the stream's read timeout elapsed, `Closed` at end of stream.
    /// Frames that arrived together stay queued, so none is lost between the handshake and the
    /// serve loop.
    pub fn read_frame(&mut self) -> Result<Read1, HelperError> {
        loop {
            if let Some(frame) = self.queued.pop_front() {
                return Ok(Read1::Frame(frame));
            }
            let mut chunk = [0u8; 16 * 1024];
            match self.inner.read(&mut chunk) {
                Ok(0) => return Ok(Read1::Closed),
                Ok(n) => {
                    for line in self.buffer.push(&chunk[..n])? {
                        self.queued.push_back(Incoming::parse(&line)?);
                    }
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    return Ok(Read1::Tick)
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Yields one canned chunk per read, then `WouldBlock`, then EOF.
    struct Script(Vec<Result<Vec<u8>, ErrorKind>>);

    impl Read for Script {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.is_empty() {
                return Ok(0);
            }
            match self.0.remove(0) {
                Ok(bytes) => {
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
                Err(kind) => Err(kind.into()),
            }
        }
    }

    #[test]
    fn frames_in_one_chunk_are_all_delivered_in_order() {
        let two = br#"{"type":"res","id":"a","ok":true,"payload":1}
{"type":"res","id":"b","ok":true,"payload":2}
"#;
        let mut reader = FrameReader::new(Script(vec![Ok(two.to_vec())]));
        for want in ["a", "b"] {
            match reader.read_frame().unwrap() {
                Read1::Frame(Incoming::ResOk(r)) => assert_eq!(r.id.to_string(), want),
                _ => panic!("expected a res frame"),
            }
        }
        assert!(matches!(reader.read_frame().unwrap(), Read1::Closed));
    }

    #[test]
    fn a_partial_frame_waits_for_the_rest_and_timeouts_are_ticks() {
        let mut reader = FrameReader::new(Script(vec![
            Ok(br#"{"type":"res","id":"a","#.to_vec()),
            Err(ErrorKind::WouldBlock),
            Ok(br#""ok":true,"payload":1}"#.to_vec()),
            Ok(b"\n".to_vec()),
        ]));
        assert!(matches!(reader.read_frame().unwrap(), Read1::Tick));
        assert!(matches!(
            reader.read_frame().unwrap(),
            Read1::Frame(Incoming::ResOk(_))
        ));
    }

    #[test]
    fn a_garbage_line_is_a_frame_error() {
        let mut reader = FrameReader::new(Script(vec![Ok(b"nope\n".to_vec())]));
        assert!(matches!(reader.read_frame(), Err(HelperError::Frame(_))));
    }
}
