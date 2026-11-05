//! NDJSON framing for the node socket (wire spec v1): one UTF-8 JSON frame per line, at most
//! [`MAX_FRAME_BYTES`] per frame. The same rules as `apps/node/src/transports/ndjson.ts` and
//! `NDJSONLineBuffer` in the Mac helper.

use serde::Serialize;
use serde_json::{json, Value};

use crate::{
    ErrorCode, ErrorPayload, EventFrame, ReqFrame, ResErrFrame, ResOkFrame, MAX_FRAME_BYTES,
};

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// A line (or an unterminated run of bytes) is longer than the limit.
    TooLarge { limit: usize },
    /// The line is not a frame this side understands.
    Invalid(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::TooLarge { limit } => write!(f, "frame exceeds {limit} bytes"),
            FrameError::Invalid(why) => write!(f, "invalid frame: {why}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// Splits a byte stream into lines. Feed it chunks as they arrive.
#[derive(Debug)]
pub struct LineBuffer {
    max: usize,
    pending: Vec<u8>,
}

impl Default for LineBuffer {
    fn default() -> Self {
        Self::new(MAX_FRAME_BYTES)
    }
}

impl LineBuffer {
    pub fn new(max: usize) -> Self {
        Self {
            max,
            pending: Vec::new(),
        }
    }

    /// Bytes buffered without a terminating newline yet.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Appends `chunk` and returns every complete line (without `\n` or a trailing `\r`). Empty
    /// lines are skipped. A line over the limit is an error, and the buffer is cleared.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        while let Some(offset) = self.pending[start..].iter().position(|b| *b == b'\n') {
            let end = start + offset;
            let mut line = &self.pending[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if line.len() > self.max {
                self.pending.clear();
                return Err(FrameError::TooLarge { limit: self.max });
            }
            if !line.is_empty() {
                lines.push(line.to_vec());
            }
            start = end + 1;
        }
        self.pending.drain(..start);
        if self.pending.len() > self.max {
            self.pending.clear();
            return Err(FrameError::TooLarge { limit: self.max });
        }
        Ok(lines)
    }
}

/// One frame read from the Gateway.
#[derive(Debug, Clone)]
pub enum Incoming {
    Req(ReqFrame),
    ResOk(ResOkFrame),
    ResErr(ResErrFrame),
    Event(EventFrame),
}

impl Incoming {
    pub fn parse(line: &[u8]) -> Result<Self, FrameError> {
        let value: Value =
            serde_json::from_slice(line).map_err(|e| FrameError::Invalid(e.to_string()))?;
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let invalid = |e: serde_json::Error| FrameError::Invalid(e.to_string());
        match kind {
            "req" => serde_json::from_value(value)
                .map(Incoming::Req)
                .map_err(invalid),
            "event" => serde_json::from_value(value)
                .map(Incoming::Event)
                .map_err(invalid),
            "res" => match value.get("ok").and_then(Value::as_bool) {
                Some(true) => serde_json::from_value(value)
                    .map(Incoming::ResOk)
                    .map_err(invalid),
                Some(false) => serde_json::from_value(value)
                    .map(Incoming::ResErr)
                    .map_err(invalid),
                None => Err(FrameError::Invalid("res frame without ok".into())),
            },
            other => Err(FrameError::Invalid(format!("unknown frame type {other:?}"))),
        }
    }
}

fn line(frame: &Value) -> Result<Vec<u8>, FrameError> {
    let mut bytes = serde_json::to_vec(frame).map_err(|e| FrameError::Invalid(e.to_string()))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            limit: MAX_FRAME_BYTES,
        });
    }
    bytes.push(b'\n');
    Ok(bytes)
}

/// `req` frame as one NDJSON line.
pub fn req_line(id: &str, method: &str, params: &impl Serialize) -> Result<Vec<u8>, FrameError> {
    let params = serde_json::to_value(params).map_err(|e| FrameError::Invalid(e.to_string()))?;
    line(&json!({ "type": "req", "id": id, "method": method, "params": params }))
}

/// Successful `res` frame as one NDJSON line.
pub fn res_ok_line(id: &str, payload: &impl Serialize) -> Result<Vec<u8>, FrameError> {
    let payload = serde_json::to_value(payload).map_err(|e| FrameError::Invalid(e.to_string()))?;
    line(&json!({ "type": "res", "id": id, "ok": true, "payload": payload }))
}

/// Error `res` frame as one NDJSON line.
pub fn res_err_line(id: &str, error: &ErrorPayload) -> Result<Vec<u8>, FrameError> {
    let error = serde_json::to_value(error).map_err(|e| FrameError::Invalid(e.to_string()))?;
    line(&json!({ "type": "res", "id": id, "ok": false, "error": error }))
}

/// An [`ErrorPayload`] with no details.
pub fn error_payload(code: ErrorCode, message: &str) -> ErrorPayload {
    ErrorPayload {
        code,
        details: None,
        message: message.to_string(),
        retryable: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_across_chunks_and_skips_blanks() {
        let mut buf = LineBuffer::default();
        assert!(buf.push(b"{\"a\":1}\n{\"b\"").unwrap().len() == 1);
        let rest = buf.push(b":2}\r\n\n").unwrap();
        assert_eq!(rest, vec![b"{\"b\":2}".to_vec()]);
        assert_eq!(buf.pending_len(), 0);
    }

    #[test]
    fn rejects_an_oversized_line_and_an_unterminated_run() {
        let mut buf = LineBuffer::new(8);
        assert_eq!(
            buf.push(b"123456789\n"),
            Err(FrameError::TooLarge { limit: 8 })
        );
        assert_eq!(
            buf.push(b"123456789"),
            Err(FrameError::TooLarge { limit: 8 })
        );
        assert_eq!(buf.pending_len(), 0);
    }

    #[test]
    fn parses_each_frame_kind() {
        let req = Incoming::parse(br#"{"type":"req","id":"1","method":"node.invoke","params":{}}"#);
        assert!(matches!(req, Ok(Incoming::Req(_))));
        let ok = Incoming::parse(br#"{"type":"res","id":"1","ok":true,"payload":{"x":1}}"#);
        assert!(matches!(ok, Ok(Incoming::ResOk(_))));
        let err = Incoming::parse(
            br#"{"type":"res","id":"1","ok":false,"error":{"code":"not_found","message":"m"}}"#,
        );
        assert!(matches!(err, Ok(Incoming::ResErr(_))));
        let ev = Incoming::parse(
            br#"{"type":"event","event":"node.updated","payload":{},"seq":0,"stateVersion":1}"#,
        );
        assert!(matches!(ev, Ok(Incoming::Event(_))));
    }

    #[test]
    fn refuses_unknown_or_malformed_frames() {
        assert!(Incoming::parse(b"not json").is_err());
        assert!(Incoming::parse(br#"{"type":"ping"}"#).is_err());
        assert!(Incoming::parse(br#"{"type":"res","id":"1"}"#).is_err());
        // Frames are closed objects: an unknown envelope key is rejected, like the Gateway does.
        assert!(Incoming::parse(br#"{"type":"req","id":"1","method":"m","extra":1}"#).is_err());
    }

    #[test]
    fn encodes_frames_as_single_lines() {
        let line = req_line("a", "connect", &json!({ "k": 1 })).unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        assert_eq!(line.iter().filter(|b| **b == b'\n').count(), 1);
        let v: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(v["type"], "req");
        assert_eq!(v["params"]["k"], 1);
        let err = res_err_line("a", &error_payload(ErrorCode::NotFound, "gone")).unwrap();
        let v: Value = serde_json::from_slice(&err).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "not_found");
    }

    #[test]
    fn refuses_to_encode_an_oversized_frame() {
        let big = "x".repeat(MAX_FRAME_BYTES);
        assert!(matches!(
            res_ok_line("a", &json!({ "big": big })),
            Err(FrameError::TooLarge { .. })
        ));
    }
}
