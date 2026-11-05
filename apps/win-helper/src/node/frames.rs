//! Wire frames (wire spec v1, `packages/protocol/src/frames.ts`): `req`, `res`, `event`, one JSON
//! object per NDJSON line, at most 1 MiB. Frames are closed objects on the Gateway side, so the
//! encoder emits exactly the keys the TypeBox schemas allow (`res ok` carries `payload`, never
//! `error`; `res !ok` carries `error`, never `payload`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Largest accepted frame in UTF-8 bytes (`MAX_FRAME_BYTES`).
pub const MAX_FRAME_BYTES: usize = 1_048_576;

/// Protocol version this helper speaks (`PROTOCOL_VERSION`).
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReqFrame {
    pub id: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    #[serde(default, rename = "idempotencyKey", skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ResFrame {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub error: Option<WireError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventFrame {
    pub event: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub seq: u64,
    #[serde(default, rename = "stateVersion")]
    pub state_version: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Req(ReqFrame),
    Res(ResFrame),
    Event(EventFrame),
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    TooLarge { limit: usize },
    Invalid(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::TooLarge { limit } => write!(f, "frame over {limit} bytes"),
            FrameError::Invalid(why) => write!(f, "invalid frame: {why}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl Frame {
    pub fn req(id: impl Into<String>, method: impl Into<String>, params: Option<Value>) -> Frame {
        Frame::Req(ReqFrame { id: id.into(), method: method.into(), params, idempotency_key: None })
    }

    pub fn res_ok(id: impl Into<String>, payload: Value) -> Frame {
        Frame::Res(ResFrame { id: id.into(), ok: true, payload: Some(payload), error: None })
    }

    pub fn res_err(id: impl Into<String>, error: WireError) -> Frame {
        Frame::Res(ResFrame { id: id.into(), ok: false, payload: None, error: Some(error) })
    }

    /// Parses one line. Unknown envelope keys are tolerated (the Gateway never sends them).
    pub fn decode(line: &[u8]) -> Result<Frame, FrameError> {
        let value: Value = serde_json::from_slice(line).map_err(|e| FrameError::Invalid(e.to_string()))?;
        let kind = value.get("type").and_then(Value::as_str).unwrap_or_default().to_owned();
        let map_err = |e: serde_json::Error| FrameError::Invalid(e.to_string());
        match kind.as_str() {
            "req" => serde_json::from_value(value).map(Frame::Req).map_err(map_err),
            "res" => serde_json::from_value(value).map(Frame::Res).map_err(map_err),
            "event" => serde_json::from_value(value).map(Frame::Event).map_err(map_err),
            other => Err(FrameError::Invalid(format!("unknown frame type {other:?}"))),
        }
    }

    /// The JSON object for this frame.
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        match self {
            Frame::Req(r) => {
                o.insert("type".into(), "req".into());
                o.insert("id".into(), r.id.clone().into());
                o.insert("method".into(), r.method.clone().into());
                if let Some(p) = &r.params {
                    o.insert("params".into(), p.clone());
                }
                if let Some(k) = &r.idempotency_key {
                    o.insert("idempotencyKey".into(), k.clone().into());
                }
            }
            Frame::Res(r) => {
                o.insert("type".into(), "res".into());
                o.insert("id".into(), r.id.clone().into());
                o.insert("ok".into(), r.ok.into());
                if r.ok {
                    o.insert("payload".into(), r.payload.clone().unwrap_or(Value::Null));
                } else {
                    let err = r.error.clone().unwrap_or(WireError {
                        code: "internal".into(),
                        message: "error".into(),
                        details: None,
                        retryable: None,
                    });
                    o.insert("error".into(), serde_json::to_value(err).unwrap_or(Value::Null));
                }
            }
            Frame::Event(e) => {
                o.insert("type".into(), "event".into());
                o.insert("event".into(), e.event.clone().into());
                o.insert("payload".into(), e.payload.clone());
                o.insert("seq".into(), e.seq.into());
                o.insert("stateVersion".into(), e.state_version.into());
            }
        }
        Value::Object(o)
    }

    /// Encodes the frame as one NDJSON line (with the trailing `\n`).
    pub fn encode_line(&self) -> Result<Vec<u8>, FrameError> {
        let body = serde_json::to_vec(&self.to_value()).map_err(|e| FrameError::Invalid(e.to_string()))?;
        super::ndjson::line_for(body, MAX_FRAME_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ok_response_has_payload_and_no_error() {
        let v = Frame::res_ok("a", json!({"accepted": true})).to_value();
        assert_eq!(v, json!({"type": "res", "id": "a", "ok": true, "payload": {"accepted": true}}));
    }

    #[test]
    fn error_response_has_error_and_no_payload() {
        let e = WireError { code: "not_found".into(), message: "x".into(), details: None, retryable: None };
        let v = Frame::res_err("b", e).to_value();
        assert_eq!(v, json!({"type": "res", "id": "b", "ok": false, "error": {"code": "not_found", "message": "x"}}));
    }

    #[test]
    fn request_omits_absent_params() {
        assert_eq!(Frame::req("1", "x", None).to_value(), json!({"type": "req", "id": "1", "method": "x"}));
    }

    #[test]
    fn decodes_each_kind() {
        let req = Frame::decode(br#"{"type":"req","id":"r1","method":"node.invoke","params":{"a":1}}"#).unwrap();
        assert!(matches!(req, Frame::Req(ref r) if r.method == "node.invoke"));
        let res = Frame::decode(br#"{"type":"res","id":"connect","ok":true,"payload":{"phase":"challenge"}}"#).unwrap();
        assert!(matches!(res, Frame::Res(ref r) if r.ok && r.payload.is_some()));
        let err = Frame::decode(br#"{"type":"res","id":"x","ok":false,"error":{"code":"forbidden","message":"no"}}"#).unwrap();
        assert!(matches!(err, Frame::Res(ref r) if r.error.as_ref().unwrap().code == "forbidden"));
        let ev = Frame::decode(br#"{"type":"event","event":"tick","payload":null,"seq":3,"stateVersion":9}"#).unwrap();
        assert!(matches!(ev, Frame::Event(ref e) if e.seq == 3 && e.state_version == 9));
        assert!(Frame::decode(br#"{"type":"nope"}"#).is_err());
        assert!(Frame::decode(b"not json").is_err());
    }

    #[test]
    fn encoding_rejects_oversized_frames() {
        let big = "x".repeat(MAX_FRAME_BYTES);
        let f = Frame::req("1", "node.result", Some(json!({"result": big})));
        assert_eq!(f.encode_line(), Err(FrameError::TooLarge { limit: MAX_FRAME_BYTES }));
    }
}
