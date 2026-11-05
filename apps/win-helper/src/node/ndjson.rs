//! Newline-delimited JSON framing (wire spec v1: one frame per line, UTF-8, at most 1 MiB per
//! frame). Feed bytes as they arrive; complete lines come back. Port of `NDJSONLineBuffer`.

use super::frames::FrameError;

#[derive(Debug, Default)]
pub struct LineBuffer {
    max_frame_bytes: usize,
    pending: Vec<u8>,
}

impl LineBuffer {
    pub fn new(max_frame_bytes: usize) -> Self {
        LineBuffer { max_frame_bytes, pending: Vec::new() }
    }

    /// Bytes buffered without a terminating newline yet.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Appends `chunk` and returns every complete line (without `\n` and a trailing `\r`). Empty
    /// lines are skipped. Fails when a line exceeds the frame limit.
    pub fn append(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        while let Some(off) = self.pending[start..].iter().position(|&b| b == b'\n') {
            let end = start + off;
            let mut line = &self.pending[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if line.len() > self.max_frame_bytes {
                return Err(FrameError::TooLarge { limit: self.max_frame_bytes });
            }
            if !line.is_empty() {
                lines.push(line.to_vec());
            }
            start = end + 1;
        }
        self.pending.drain(..start);
        if self.pending.len() > self.max_frame_bytes {
            return Err(FrameError::TooLarge { limit: self.max_frame_bytes });
        }
        Ok(lines)
    }
}

/// Encodes one frame body as a line. Fails when the body exceeds the frame limit.
pub fn line_for(mut body: Vec<u8>, max_frame_bytes: usize) -> Result<Vec<u8>, FrameError> {
    if body.len() > max_frame_bytes {
        return Err(FrameError::TooLarge { limit: max_frame_bytes });
    }
    body.push(b'\n');
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_across_chunks() {
        let mut b = LineBuffer::new(1024);
        assert!(b.append(b"{\"a\":").unwrap().is_empty());
        assert_eq!(b.pending_len(), 5);
        let lines = b.append(b"1}\n{\"b\":2}\r\n\n{\"c\"").unwrap();
        assert_eq!(lines, vec![b"{\"a\":1}".to_vec(), b"{\"b\":2}".to_vec()]);
        assert_eq!(b.pending_len(), 4);
        assert_eq!(b.append(b":3}\n").unwrap(), vec![b"{\"c\":3}".to_vec()]);
    }

    #[test]
    fn rejects_oversized_line_and_pending() {
        let mut b = LineBuffer::new(4);
        assert_eq!(b.append(b"12345\n"), Err(FrameError::TooLarge { limit: 4 }));
        let mut c = LineBuffer::new(4);
        assert_eq!(c.append(b"12345"), Err(FrameError::TooLarge { limit: 4 }));
        let mut d = LineBuffer::new(4);
        assert_eq!(d.append(b"1234\n").unwrap(), vec![b"1234".to_vec()]);
    }

    #[test]
    fn line_for_appends_newline() {
        assert_eq!(line_for(b"{}".to_vec(), 2).unwrap(), b"{}\n".to_vec());
        assert!(line_for(b"{}".to_vec(), 1).is_err());
    }
}
