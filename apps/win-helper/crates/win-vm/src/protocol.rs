//! The control protocol: NDJSON over `\\.\pipe\psyche-vm-<owner SID>`, one JSON object per line.
//!
//! - request  `{"id": "<string>", "method": "<string>", "params": {…}, "progress"?: true}`
//! - response `{"id", "result": …}` or `{"id", "error": {"code", "message", "details": {"reason", …}, "retryable"?}}`
//! - event    `{"event": "<name>", "data": {…}}`: after `watch`, `vm.status` once, then
//!   `vm.updated` / `vm.deleted` (`data` is the mac helper's event object, `type` included);
//!   with `"progress": true` on a request, its progress events (`vm.import`, `vm.state`,
//!   `vm.snapshot`, `vm.reset`, `vm.export`, `vm.psyche_install`) arrive as
//!   `{"event": "progress", "data": {"id": "<request id>", "event": {…}}}` before its response.
//!
//! Methods are the mac `vm.*` capabilities without the prefix, with their params and results
//! (`VMCapabilities.swift`); `share_add` takes the Gateway's `approvalId` in its params. Extra:
//! `service_info`, `unwatch`.

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::error::{Code, VmError, VmResult};
use crate::manager::{self, Emit, Manager};

/// Every method the service answers (`watch` / `unwatch` are handled by the connection).
pub const METHODS: [&str; 27] = [
    "status",
    "create",
    "configure",
    "start",
    "stop",
    "pause",
    "resume",
    "suspend",
    "reset",
    "delete",
    "snapshot",
    "snapshot_delete",
    "restore",
    "share_add",
    "share_remove",
    "copy_in",
    "copy_out",
    "display",
    "export_image",
    "restore_image",
    "watch",
    "agent_status",
    "install_psyche",
    "grant_permissions",
    "service_info",
    "unwatch",
    "ping",
];

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub progress: bool,
}

/// Parses one line; a bad line answers with `id: null`.
pub fn parse(line: &[u8]) -> Result<Request, Value> {
    let v: Value = serde_json::from_slice(line)
        .map_err(|_| error_response(&Value::Null, &VmError::invalid_params("request is not JSON", "request")))?;
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    if !id.is_string() {
        return Err(error_response(&id, &VmError::invalid_params("id must be a string", "id")));
    }
    serde_json::from_value::<Request>(v).map_err(|e| error_response(&id, &VmError::invalid_params(format!("bad request: {e}"), "method")))
}

pub fn response(id: &Value, result: Value) -> Value {
    json!({"id": id, "result": result})
}

pub fn error_response(id: &Value, e: &VmError) -> Value {
    json!({"id": id, "error": e.to_wire()})
}

pub fn event(name: &str, data: Value) -> Value {
    json!({"event": name, "data": data})
}

pub fn progress_event(id: &Value, inner: Value) -> Value {
    event("progress", json!({"id": id, "event": inner}))
}

fn decode<T: DeserializeOwned + Default>(params: &Value) -> VmResult<T> {
    if params.is_null() {
        return Ok(T::default());
    }
    if !params.is_object() {
        return Err(VmError::invalid_params("params must be an object", "params"));
    }
    serde_json::from_value(params.clone()).map_err(|e| {
        let msg = e.to_string();
        let field = msg.split('`').nth(1).unwrap_or("params").to_owned();
        VmError::invalid_params(msg, &field)
    })
}

#[derive(Debug, Default, Deserialize)]
struct NameParams {
    name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct StopParams {
    name: Option<String>,
    force: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct SnapshotRef {
    name: Option<String>,
    snapshot: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareParams {
    name: Option<String>,
    share: Option<String>,
    path: Option<String>,
    read_only: Option<bool>,
    approval_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct DisplayParams {
    name: Option<String>,
    visible: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyInParams {
    name: Option<String>,
    host_path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyOutParams {
    name: Option<String>,
    guest_path: Option<String>,
    host_dir: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PayloadParams {
    name: Option<String>,
    payload: Option<String>,
}

fn name(n: Option<String>) -> String {
    n.unwrap_or_else(|| "sandbox".into())
}

fn required(v: Option<String>, field: &str) -> VmResult<String> {
    v.ok_or_else(|| VmError::invalid_params(format!("{field} is required"), field))
}

/// Runs one method (blocking; the caller is impersonating the owner).
pub fn dispatch(m: &Manager, method: &str, params: &Value, emit: Emit) -> VmResult<Value> {
    match method {
        "ping" => Ok(json!({"pong": true})),
        "status" => Ok(m.status()),
        "service_info" => Ok(m.service_info()),
        "restore_image" => m.restore_image(),
        "create" => m.create(decode::<manager::CreateParams>(params)?, emit),
        "configure" => m.configure(decode::<manager::ConfigureParams>(params)?),
        "start" => m.start(&name(decode::<NameParams>(params)?.name), emit),
        "stop" => {
            let p = decode::<StopParams>(params)?;
            m.stop(&name(p.name), p.force.unwrap_or(false))
        }
        "pause" => m.pause(&name(decode::<NameParams>(params)?.name)),
        "resume" => m.resume(&name(decode::<NameParams>(params)?.name)),
        "suspend" => m.suspend(&name(decode::<NameParams>(params)?.name)),
        "reset" => m.reset(&name(decode::<NameParams>(params)?.name), emit),
        "delete" => m.delete(&name(decode::<NameParams>(params)?.name)),
        "snapshot" => m.snapshot(decode::<manager::SnapshotParams>(params)?, emit),
        "snapshot_delete" => {
            let p = decode::<SnapshotRef>(params)?;
            m.snapshot_delete(&name(p.name), &required(p.snapshot, "snapshot")?)
        }
        "restore" => {
            let p = decode::<SnapshotRef>(params)?;
            m.restore(&name(p.name), &required(p.snapshot, "snapshot")?, emit)
        }
        "share_add" => {
            let p = decode::<ShareParams>(params)?;
            let share = required(p.share, "share")?;
            let path = required(p.path, "path")?;
            m.share_add(&name(p.name), &share, &path, p.read_only.unwrap_or(true), p.approval_id.as_deref())
        }
        "share_remove" => {
            let p = decode::<ShareParams>(params)?;
            m.share_remove(&name(p.name), &required(p.share, "share")?)
        }
        "copy_in" => {
            let p = decode::<CopyInParams>(params)?;
            m.copy_in(&name(p.name), &required(p.host_path, "hostPath")?)
        }
        "copy_out" => {
            let p = decode::<CopyOutParams>(params)?;
            m.copy_out(&name(p.name), &required(p.guest_path, "guestPath")?, &required(p.host_dir, "hostDir")?)
        }
        "display" => {
            let p = decode::<DisplayParams>(params)?;
            let visible = p.visible.ok_or_else(|| VmError::invalid_params("visible is required", "visible"))?;
            m.display(&name(p.name), visible)
        }
        "export_image" => {
            if params.get("outDir").is_none() {
                return Err(VmError::invalid_params("outDir is required", "outDir"));
            }
            m.export_image(decode::<manager::ExportImageParams>(params)?, emit)
        }
        "agent_status" => m.agent_status(&name(decode::<NameParams>(params)?.name)),
        "install_psyche" => {
            let p = decode::<PayloadParams>(params)?;
            m.install_psyche(&name(p.name), &required(p.payload, "payload")?, emit)
        }
        "grant_permissions" => {
            let p = decode::<PayloadParams>(params)?;
            m.grant_permissions(&name(p.name))
        }
        _ => Err(VmError::new(Code::UnknownMethod, "unknown_method", format!("Unknown method {method}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsing_and_shapes() {
        let r = parse(br#"{"id":"1","method":"status"}"#).unwrap();
        assert_eq!((r.id.as_str(), r.method.as_str(), r.progress), (Some("1"), "status", false));
        assert!(r.params.is_null());
        let r = parse(br#"{"id":"2","method":"start","params":{"name":"sandbox"},"progress":true}"#).unwrap();
        assert!(r.progress);
        let bad = parse(b"not json").unwrap_err();
        assert_eq!(bad["id"], Value::Null);
        assert_eq!(bad["error"]["code"], "invalid_params");
        let noid = parse(br#"{"id": 5, "method": "status"}"#).unwrap_err();
        assert_eq!(noid["error"]["details"]["field"], "id");
        assert_eq!(response(&json!("1"), json!({"a": 1})), json!({"id": "1", "result": {"a": 1}}));
        let e = error_response(&json!("1"), &VmError::conflict("vm_busy", "busy"));
        assert_eq!(e, json!({"id": "1", "error": {"code": "conflict", "message": "busy", "details": {"reason": "vm_busy"}}}));
        assert_eq!(event("vm.updated", json!({"type": "vm.updated"})), json!({"event": "vm.updated", "data": {"type": "vm.updated"}}));
        assert_eq!(progress_event(&json!("7"), json!({"type": "vm.import"}))["data"]["id"], "7");
    }

    #[test]
    fn decode_names_the_bad_field() {
        let e = decode::<StopParams>(&json!({"force": "yes"})).unwrap_err();
        assert_eq!(e.code, Code::InvalidParams);
        let e = decode::<NameParams>(&json!([1])).unwrap_err();
        assert_eq!(e.details["field"], "params");
        assert_eq!(decode::<NameParams>(&Value::Null).unwrap().name, None);
    }

    #[test]
    fn the_contract_method_list_is_covered() {
        for m in [
            "status",
            "create",
            "configure",
            "start",
            "stop",
            "pause",
            "resume",
            "suspend",
            "reset",
            "delete",
            "snapshot",
            "snapshot_delete",
            "restore",
            "share_add",
            "share_remove",
            "copy_in",
            "copy_out",
            "display",
            "export_image",
            "restore_image",
            "watch",
            "agent_status",
            "install_psyche",
            "grant_permissions",
            "service_info",
        ] {
            assert!(METHODS.contains(&m), "{m}");
        }
    }
}
