//! One NDJSON frame stream over a connected transport (port of `FrameChannel`). Reads happen in
//! one task (the handshake, then the serve loop); writes may come from any task and are
//! serialized through a queue drained by a single writer task.

use std::collections::VecDeque;
use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::frames::{Frame, FrameError, MAX_FRAME_BYTES};
use super::ndjson::LineBuffer;

pub struct FrameReader<R> {
    inner: R,
    buffer: LineBuffer,
    queued: VecDeque<Vec<u8>>,
    chunk: Vec<u8>,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        FrameReader { inner, buffer: LineBuffer::new(MAX_FRAME_BYTES), queued: VecDeque::new(), chunk: vec![0u8; 64 * 1024] }
    }

    /// Next frame, or `None` on EOF. Lines that are not valid frames are skipped (a malformed
    /// line must not kill the node); a line over 1 MiB is a fatal framing error.
    pub async fn next(&mut self) -> io::Result<Option<Frame>> {
        loop {
            while let Some(line) = self.queued.pop_front() {
                if let Ok(frame) = Frame::decode(&line) {
                    return Ok(Some(frame));
                }
            }
            let n = match self.inner.read(&mut self.chunk).await {
                Ok(n) => n,
                // A pipe whose server went away reports "broken pipe": that is EOF here.
                Err(e) if e.kind() == io::ErrorKind::BrokenPipe => 0,
                Err(e) => return Err(e),
            };
            if n == 0 {
                return Ok(None);
            }
            let lines = self.buffer.append(&self.chunk[..n]).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            self.queued.extend(lines);
        }
    }
}

/// Cloneable handle that queues encoded frames for the writer task.
#[derive(Clone)]
pub struct FrameWriter {
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    TooLarge,
    Closed,
    Encode,
}

impl FrameWriter {
    pub fn send(&self, frame: &Frame) -> Result<(), SendError> {
        let line = match frame.encode_line() {
            Ok(l) => l,
            Err(FrameError::TooLarge { .. }) => return Err(SendError::TooLarge),
            Err(_) => return Err(SendError::Encode),
        };
        self.tx.send(line).map_err(|_| SendError::Closed)
    }
}

/// Starts the writer task. It ends when every `FrameWriter` is dropped or a write fails.
pub fn spawn_writer<W: AsyncWrite + Unpin + Send + 'static>(mut w: W) -> (FrameWriter, JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if w.write_all(&line).await.is_err() || w.flush().await.is_err() {
                break;
            }
        }
        let _ = w.shutdown().await;
    });
    (FrameWriter { tx }, task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn reads_frames_and_skips_garbage() {
        let (client, mut server) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            server.write_all(b"garbage\n{\"type\":\"req\",\"id\":\"1\",\"method\":\"m\"}\n").await.unwrap();
            server.write_all(b"{\"type\":\"res\",\"id\":\"2\",\"ok\":true,\"payload\":null}\n").await.unwrap();
        });
        let mut r = FrameReader::new(client);
        assert!(matches!(r.next().await.unwrap(), Some(Frame::Req(f)) if f.id == "1"));
        assert!(matches!(r.next().await.unwrap(), Some(Frame::Res(f)) if f.id == "2"));
        assert!(r.next().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn writer_serializes_lines() {
        let (client, server) = tokio::io::duplex(4096);
        let (w, task) = spawn_writer(client);
        w.send(&Frame::req("a", "x", Some(json!({"n": 1})))).unwrap();
        w.send(&Frame::res_ok("b", json!(null))).unwrap();
        drop(w);
        task.await.unwrap();
        let mut r = FrameReader::new(server);
        assert!(matches!(r.next().await.unwrap(), Some(Frame::Req(f)) if f.id == "a"));
        assert!(matches!(r.next().await.unwrap(), Some(Frame::Res(f)) if f.id == "b"));
    }
}
