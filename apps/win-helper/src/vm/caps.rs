//! The `vm.*` capabilities: the mac helper's names, schemas, side effects, permissions and receipt
//! kinds, each served by the sandbox PC service over its control pipe with parameters and results
//! forwarded unchanged. The helper adds only what must run as the owner: folder checks
//! (`policy`), the read-write-share approval, and receipts.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use super::client::{Endpoint, Start};
use super::policy;
use super::service::ServiceState;
use crate::node::capability::{
    CapResult, CapabilityError, CapabilityOutput, CapabilitySpec, InvocationContext, ReceiptDraft,
    SideEffect, TargetKind,
};
use crate::node::paths::Env;
use crate::node::registry::Runtime;
use crate::node::roots::{FinderRoots, canonical, is_absolute};
use crate::node::{CapabilityRegistry, schema};

const LONG: Duration = Duration::from_secs(15 * 60);

fn name_schema() -> Value {
    schema::string_max(Some("Guest name (default \"sandbox\")"), 32)
}

fn params(props: Vec<(&str, Value)>, required: &[&str]) -> Value {
    let mut all = vec![("name", name_schema())];
    all.extend(props);
    schema::object(all, required)
}

/// One capability's static description. `method` is the control-pipe method (the name without
/// `vm.`).
#[derive(Clone)]
struct Def {
    name: &'static str,
    description: &'static str,
    side_effect: SideEffect,
    target: Option<TargetKind>,
    input: Value,
    streaming: bool,
    receipt: Option<&'static str>,
    timeout: Option<Duration>,
}

impl Def {
    fn method(&self) -> &'static str {
        &self.name["vm.".len()..]
    }

    fn spec(&self) -> CapabilitySpec {
        let mut s =
            CapabilitySpec::new(self.name, self.description, self.side_effect).input(self.input.clone());
        if let Some(t) = self.target {
            s = s.target(t);
        }
        if self.streaming {
            s = s.streaming();
        }
        if let Some(r) = self.receipt {
            s = s.receipt(r);
        }
        if let Some(t) = self.timeout {
            s = s.timeout(t);
        }
        s
    }
}

#[allow(clippy::too_many_lines)]
fn defs() -> Vec<Def> {
    use SideEffect::{Destructive, Read, Write};
    let d = |name, description, side_effect, input| Def {
        name,
        description,
        side_effect,
        target: None,
        input,
        streaming: false,
        receipt: if side_effect == Read { None } else { Some("vm") },
        timeout: if side_effect == Read { None } else { Some(LONG) },
    };
    vec![
        d(
            "vm.status",
            "The sandbox PC(s): phase, resources, guest Linux, shares, vsock port, whether the service is installed and running.",
            Read,
            schema::empty(),
        ),
        d(
            "vm.restore_image",
            "The guest image this PC would use (version, download size) from the published manifest, and whether it is already downloaded.",
            Read,
            schema::empty(),
        ),
        Def {
            streaming: true,
            ..d(
                "vm.create",
                "Create the sandbox PC from a downloaded, verified guest image (download: true confirms using the published image). Streams vm.download / vm.install progress. One guest per user.",
                Write,
                params(
                    vec![
                        ("cpus", schema::integer(None, Some(2), Some(32))),
                        ("memoryGB", schema::integer(None, Some(4), Some(256))),
                        ("diskGB", schema::integer(None, Some(40), Some(2048))),
                        ("ipsw", schema::string(Some("Not used on Windows"))),
                        ("download", schema::boolean(Some("Confirm using the published guest image"))),
                        ("username", schema::string_max(None, 32)),
                        (
                            "image",
                            schema::string(Some(
                                "Absolute path to a prebuilt guest image directory instead of the published one",
                            )),
                        ),
                        (
                            "imageSha256",
                            schema::string_max(
                                Some("Expected SHA-256 of the image's manifest.json, from the publisher"),
                                64,
                            ),
                        ),
                    ],
                    &[],
                ),
            )
        },
        Def {
            streaming: true,
            ..d(
                "vm.start",
                "Boot the sandbox PC headless. The guest's psyche-node reaches the Gateway over hvsocket (host CID 2) and pairs like any node.",
                Write,
                params(vec![], &[]),
            )
        },
        d(
            "vm.stop",
            "Shut the sandbox PC down through the guest; force: true stops it hard if the guest does not respond.",
            Write,
            params(vec![("force", schema::boolean(None))], &[]),
        ),
        d(
            "vm.delete",
            "Delete a stopped sandbox PC and its disk. Cannot be undone.",
            Destructive,
            params(vec![], &[]),
        ),
        Def {
            target: Some(TargetKind::Path),
            streaming: true,
            ..d(
                "vm.export_image",
                "Export the stopped, provisioned sandbox PC as a prebuilt guest image in outDir/<id>/ (disks and a SHA-256 manifest). Never its machine identity.",
                Write,
                params(
                    vec![
                        ("outDir", schema::string(Some("Absolute host folder"))),
                        ("id", schema::string_max(None, 64)),
                    ],
                    &["outDir"],
                ),
            )
        },
        Def {
            streaming: true,
            ..d(
                "vm.snapshot",
                "Snapshot the stopped or saved sandbox PC (differencing disks: instant, copy-on-write). kind base makes it the \"fresh PC\" vm.reset returns to; task snapshots are pruned to the newest 3; at most 10 manual.",
                Write,
                params(
                    vec![
                        ("label", schema::string_max(None, 120)),
                        ("kind", schema::string_enum(None, &["base", "manual", "task"])),
                        ("taskId", schema::string_max(None, 128)),
                    ],
                    &[],
                ),
            )
        },
        Def {
            streaming: true,
            ..d(
                "vm.restore",
                "Restore the stopped sandbox PC to a snapshot. Discards the current disk (the snapshot is kept).",
                Destructive,
                params(vec![("snapshot", schema::string_max(None, 64))], &["snapshot"]),
            )
        },
        Def {
            streaming: true,
            ..d(
                "vm.reset",
                "Reset the stopped sandbox PC to its base snapshot (\"fresh PC\"). Discards the current disk.",
                Destructive,
                params(vec![], &[]),
            )
        },
        d(
            "vm.snapshot_delete",
            "Delete one snapshot of the sandbox PC. Deleting the base leaves no reset point.",
            Destructive,
            params(vec![("snapshot", schema::string_max(None, 64))], &["snapshot"]),
        ),
        Def {
            target: Some(TargetKind::Path),
            receipt: Some("vm_share"),
            ..d(
                "vm.share_add",
                "Share one host folder with the guest at /mnt/psyche/<share> (Plan9). Read-only by default; read-write needs an approval. Never a drive root, your user folder, AppData, Windows, Program Files or Psyche's data. Applied live to a running guest.",
                Write,
                params(
                    vec![
                        ("share", schema::string_max(Some("Share name"), 64)),
                        ("path", schema::string(Some("Absolute host folder"))),
                        ("readOnly", schema::boolean(Some("Default true"))),
                    ],
                    &["share", "path"],
                ),
            )
        },
        Def {
            target: Some(TargetKind::Path),
            receipt: Some("vm_share"),
            ..d(
                "vm.share_remove",
                "Stop sharing a folder (applied live to a running guest).",
                Write,
                params(vec![("share", schema::string_max(None, 64))], &["share"]),
            )
        },
        d("vm.pause", "Pause a running sandbox PC in memory.", Write, params(vec![], &[])),
        d("vm.resume", "Resume a paused sandbox PC.", Write, params(vec![], &[])),
        d(
            "vm.suspend",
            "Save the machine state and stop (warm start on the next vm.start).",
            Write,
            params(vec![], &[]),
        ),
        d(
            "vm.configure",
            "Change resources (cpus, memoryGB) and display size while stopped; clipboard (off, paste-only, bidirectional), credential placement (host, guest) and network (none, nat) any time the service allows.",
            Write,
            params(
                vec![
                    ("cpus", schema::integer(None, Some(2), Some(32))),
                    ("memoryGB", schema::integer(None, Some(4), Some(256))),
                    ("displayWidth", schema::integer(None, Some(640), Some(3840))),
                    ("displayHeight", schema::integer(None, Some(480), Some(2400))),
                    (
                        "clipboard",
                        schema::string_enum(None, &["off", "paste-only", "bidirectional"]),
                    ),
                    ("vault", schema::string_enum(None, &["host", "guest"])),
                    ("network", schema::string_enum(None, &["none", "nat"])),
                ],
                &[],
            ),
        ),
        d(
            "vm.display",
            "Show or hide the guest's display window on the host (Take control).",
            Write,
            params(vec![("visible", schema::boolean(None))], &["visible"]),
        ),
        d(
            "vm.agent_status",
            "Ping the guest agent: version and what it can do in the guest.",
            Read,
            params(vec![], &[]),
        ),
        Def {
            target: Some(TargetKind::Path),
            receipt: Some("vm_transfer"),
            ..d(
                "vm.copy_in",
                "Copy a host file or folder into the guest (read-only at /mnt/psyche-in/<id>/). Sensitive folders are refused.",
                Write,
                params(vec![("hostPath", schema::string(None))], &["hostPath"]),
            )
        },
        Def {
            target: Some(TargetKind::Path),
            receipt: Some("vm_transfer"),
            ..d(
                "vm.copy_out",
                "Copy one guest file to a host folder inside the granted folders (never overwrites). The guest stages it in the _psyche-out share.",
                Write,
                params(
                    vec![("guestPath", schema::string(None)), ("hostDir", schema::string(None))],
                    &["guestPath", "hostDir"],
                ),
            )
        },
        Def {
            streaming: true,
            ..d(
                "vm.install_psyche",
                "Install Psyche in the running guest from a release or checkout (shared read-only): psyche-node (hvsocket 2:7980).",
                Write,
                params(
                    vec![("payload", schema::string(Some("Absolute host path of a Psyche release or checkout")))],
                    &["payload"],
                ),
            )
        },
        Def {
            streaming: true,
            ..d(
                "vm.grant_permissions",
                "Windows guests need no pre-granted permissions: the service answers unsupported with a reason (kept for the shared vm.* surface).",
                Write,
                params(
                    vec![("payload", schema::string(Some("The payload whose helper was installed")))],
                    &["payload"],
                ),
            )
        },
        d(
            "vm.service_info",
            "The sandbox PC service: version, whether Hyper-V's Host Compute Service is available, and the guest images on disk.",
            Read,
            schema::empty(),
        ),
        Def {
            streaming: true,
            receipt: None,
            timeout: None,
            ..d(
                "vm.watch",
                "Long-lived stream of {type: vm.updated, guest, at} and {type: vm.deleted, name} events, for the Gateway's vm.updated broadcast.",
                Read,
                schema::empty(),
            )
        },
    ]
}

/// Per-process memory of the last status, so a sleeping service need not be woken to answer
/// `vm.status` every poll.
#[derive(Default)]
struct StatusCache {
    last: Mutex<Option<Value>>,
    woke: AtomicBool,
}

fn service_block(state: ServiceState) -> Value {
    let mut b = json!({ "installed": state.installed(), "state": state.as_str() });
    if state == ServiceState::NotInstalled {
        b["action"] = "turn_on_sandbox_pc".into();
    }
    b
}

/// `vm.status` before the service exists: nothing to report, and the one thing the owner can do.
pub fn not_installed_status() -> Value {
    json!({
        "guests": [],
        "active": 0,
        "maxActive": 1,
        "supportsGuestProvisioning": false,
        "service": service_block(ServiceState::NotInstalled),
    })
}

/// The last known status with every guest stopped (the service itself is not running).
fn asleep_status(last: Option<Value>, state: ServiceState) -> Value {
    let mut v = last.unwrap_or_else(|| {
        json!({"guests": [], "active": 0, "maxActive": 1, "supportsGuestProvisioning": true})
    });
    if let Some(guests) = v.get_mut("guests").and_then(Value::as_array_mut) {
        for g in guests {
            if let Some(p) = g.get("phase").and_then(Value::as_str) {
                if matches!(p, "running" | "starting" | "paused" | "stopping") {
                    g["phase"] = "stopped".into();
                }
            }
        }
    }
    v["active"] = 0.into();
    v["service"] = service_block(state);
    v
}

async fn status(ep: &Endpoint, cache: &StatusCache) -> CapResult {
    let state = ep.service().state;
    let fresh = match state {
        ServiceState::NotInstalled => return Ok(CapabilityOutput::new(not_installed_status())),
        ServiceState::AccessDenied => {
            return Ok(CapabilityOutput::new(asleep_status(None, state)));
        }
        ServiceState::Running => Some(Start::Never),
        // Asleep: wake it once per helper process (to learn what exists), never again for status.
        _ if !cache.woke.swap(true, Ordering::SeqCst) => Some(Start::IfNeeded),
        _ => None,
    };
    let Some(start) = fresh else {
        let last = cache.last.lock().ok().and_then(|g| g.clone());
        return Ok(CapabilityOutput::new(asleep_status(last, state)));
    };
    // The idle timer must not restart on a poll: `passive` tells the service so.
    let mut result = ep.call("status", json!({"passive": true}), start).await?;
    if let Ok(mut g) = cache.last.lock() {
        *g = Some(result.clone());
    }
    if result.is_object() {
        result["service"] = service_block(ep.service().state);
    }
    Ok(CapabilityOutput::new(result))
}

fn str_field<'a>(p: &'a Value, key: &str) -> Option<&'a str> {
    p.get(key).and_then(Value::as_str)
}

fn require_absolute(p: &Value, key: &str) -> Result<String, CapabilityError> {
    match str_field(p, key) {
        Some(s) if is_absolute(s) => Ok(s.to_owned()),
        Some(_) => Err(CapabilityError::invalid_params(
            format!("{key} must be an absolute path"),
            Some(key),
        )),
        None => Err(CapabilityError::invalid_params(
            format!("missing parameter {key}"),
            Some(key),
        )),
    }
}

/// Parameters for the service: the owner-side checks, then the canonical paths in place of the
/// ones the caller wrote.
fn prepare(def: &Def, ctx: &InvocationContext, env: &Env) -> Result<Value, CapabilityError> {
    let mut p = if ctx.params.is_null() {
        json!({})
    } else {
        ctx.params.clone()
    };
    match def.name {
        "vm.create" => {
            if p.get("ipsw").is_some() {
                return Err(CapabilityError::invalid_params(
                    "ipsw is a macOS restore image; the sandbox PC uses a Linux guest image",
                    Some("ipsw"),
                ));
            }
            if p.get("image").is_some() {
                let image = require_absolute(&p, "image")?;
                p["image"] = canonical(&image, env).to_string_lossy().into_owned().into();
            }
        }
        "vm.share_add" => {
            let share = str_field(&p, "share").unwrap_or_default().to_owned();
            let path = str_field(&p, "path").unwrap_or_default().to_owned();
            let read_only = p.get("readOnly").and_then(Value::as_bool).unwrap_or(true);
            let resolved =
                policy::validate_share(&share, &path, read_only, ctx.approval_id.as_deref(), env)?;
            p["path"] = resolved.to_string_lossy().into_owned().into();
            p["readOnly"] = read_only.into();
            if let (Some(id), false) = (&ctx.approval_id, read_only) {
                p["approvalId"] = id.clone().into();
            }
        }
        "vm.share_remove" => {
            let share = str_field(&p, "share").unwrap_or_default();
            if !policy::is_valid_share_name(share) {
                return Err(CapabilityError::invalid_params(
                    "share name must be letters, digits, space, . _ -",
                    Some("share"),
                ));
            }
        }
        "vm.copy_in" => {
            let host = str_field(&p, "hostPath").unwrap_or_default().to_owned();
            p["hostPath"] = policy::validate_copy_in(&host, env)?
                .to_string_lossy()
                .into_owned()
                .into();
        }
        "vm.copy_out" => {
            let dir = require_absolute(&p, "hostDir")?;
            p["hostDir"] = FinderRoots::load(env)
                .resolve(&dir, env)?
                .to_string_lossy()
                .into_owned()
                .into();
        }
        "vm.export_image" => {
            let dir = require_absolute(&p, "outDir")?;
            p["outDir"] = FinderRoots::load(env)
                .resolve(&dir, env)?
                .to_string_lossy()
                .into_owned()
                .into();
        }
        "vm.install_psyche" | "vm.grant_permissions" => {
            let payload = require_absolute(&p, "payload")?;
            let resolved = canonical(&payload, env);
            if !Path::new(&resolved).exists() {
                return Err(CapabilityError::not_found(
                    "not_found",
                    format!("{payload} does not exist"),
                ));
            }
            p["payload"] = resolved.to_string_lossy().into_owned().into();
        }
        _ => {}
    }
    Ok(p)
}

fn guest_name(p: &Value) -> &str {
    str_field(p, "name").unwrap_or("sandbox")
}

fn receipt_for(def: &Def, sent: &Value, result: &Value) -> Option<ReceiptDraft> {
    let n = guest_name(sent);
    let leaf = |v: &Value| {
        v.as_str()
            .and_then(|s| Path::new(s).file_name())
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let mut r = match def.name {
        "vm.create" => ReceiptDraft::ok(format!("Created the sandbox PC {n}")),
        "vm.start" => ReceiptDraft::ok("Started the sandbox PC"),
        "vm.stop" => {
            let graceful = result.get("graceful").and_then(Value::as_bool).unwrap_or(true);
            ReceiptDraft::ok(if graceful {
                "Stopped the sandbox PC"
            } else {
                "Force-stopped the sandbox PC"
            })
        }
        "vm.delete" => ReceiptDraft::ok("Deleted the sandbox PC"),
        "vm.export_image" => ReceiptDraft::ok("Exported the sandbox PC as a guest image"),
        "vm.snapshot" => ReceiptDraft::ok("Snapshot of the sandbox PC"),
        "vm.restore" => ReceiptDraft::ok("Restored the sandbox PC to a snapshot"),
        "vm.reset" => ReceiptDraft::ok("Reset the sandbox PC to a fresh PC"),
        "vm.snapshot_delete" => ReceiptDraft::ok("Deleted a sandbox PC snapshot"),
        "vm.share_add" => {
            let share = str_field(sent, "share").unwrap_or_default();
            let ro = sent.get("readOnly").and_then(Value::as_bool).unwrap_or(true);
            ReceiptDraft::ok(format!(
                "Shared {share} {}",
                if ro { "read-only" } else { "read-write" }
            ))
            .with_ref("share", share)
        }
        "vm.share_remove" => {
            ReceiptDraft::ok(format!("Stopped sharing {}", str_field(sent, "share").unwrap_or_default()))
        }
        "vm.pause" => ReceiptDraft::ok("Paused the sandbox PC"),
        "vm.resume" => ReceiptDraft::ok("Resumed the sandbox PC"),
        "vm.suspend" => ReceiptDraft::ok("Saved and stopped the sandbox PC"),
        "vm.configure" => ReceiptDraft::ok("Changed the sandbox PC's settings"),
        "vm.display" => {
            let shown = sent.get("visible").and_then(Value::as_bool).unwrap_or(false);
            ReceiptDraft::ok(if shown { "Showed the guest display" } else { "Hid the guest display" })
        }
        "vm.copy_in" | "vm.copy_out" => {
            let t = &result["transfer"];
            let (what, dir) = if def.name == "vm.copy_in" {
                (leaf(&t["hostPath"]), "into the guest")
            } else {
                (leaf(&t["hostPath"]), "to the host")
            };
            let mut r = ReceiptDraft::ok(format!("Copied {what} {dir}"));
            if let Some(id) = t.get("id").and_then(Value::as_str) {
                r = r.with_ref("transfer", id);
            }
            if let Some(b) = t.get("bytes").and_then(Value::as_i64) {
                r = r.with_ref("bytes", b);
            }
            r
        }
        "vm.install_psyche" => ReceiptDraft::ok("Installed Psyche in the sandbox PC"),
        "vm.grant_permissions" => ReceiptDraft::ok("Checked the guest helper's permissions"),
        _ => return None,
    };
    if r.summary.is_empty() {
        r.summary = def.name.to_owned();
    }
    Some(r)
}

pub fn register(reg: &mut CapabilityRegistry) {
    let rt = reg.runtime().clone();
    let Some(endpoint) = Endpoint::resolve(&rt.env) else {
        return;
    };
    let cache = rt.service(StatusCache::default);
    if !endpoint.installed() {
        // Before "Turn on the sandbox PC": only `vm.status`, which says so and names the action.
        let def = defs().into_iter().find(|d| d.name == "vm.status").expect("vm.status");
        reg.add(def.spec(), |_| async { Ok(CapabilityOutput::new(not_installed_status())) });
        return;
    }
    for def in defs() {
        let spec = def.spec();
        let def = std::sync::Arc::new(def);
        let ep = endpoint.clone();
        let cache = cache.clone();
        let rt: std::sync::Arc<Runtime> = rt.clone();
        reg.add(spec, move |ctx| {
            let (def, ep, cache, rt) = (def.clone(), ep.clone(), cache.clone(), rt.clone());
            async move { invoke(&def, &ep, &cache, &rt.env, ctx).await }
        });
    }
}

async fn invoke(
    def: &Def,
    ep: &Endpoint,
    cache: &StatusCache,
    env: &Env,
    ctx: InvocationContext,
) -> CapResult {
    if def.name == "vm.status" {
        return status(ep, cache).await;
    }
    let sent = prepare(def, &ctx, env)?;
    let method = def.method();
    let result = match def.name {
        "vm.watch" => {
            let ctx2 = ctx.clone();
            ep.watch(move |v| ctx2.emit(v)).await?
        }
        _ if def.streaming => {
            let ctx2 = ctx.clone();
            ep.call_streaming(method, sent.clone(), move |v| ctx2.emit(v)).await?
        }
        _ => ep.call(method, sent.clone(), Start::IfNeeded).await?,
    };
    match receipt_for(def, &sent, &result) {
        Some(r) => Ok(CapabilityOutput::with_receipt(result, r)),
        None => Ok(CapabilityOutput::new(result)),
    }
}
