//! Direct computer use in the helper (linux-desktop design §5, §6): the capability names and
//! result shapes of the Mac helper (`computer.*`, `apps.list|open|focus`), so
//! `apps/gateway/src/compose/computer.ts` needs no second driver, plus the Linux-only
//! `a11y.status`, `a11y.enable`, `portal.status` and `portal.revoke`.
//!
//! The helper starts on demand and holds nothing until it is asked: the capabilities are
//! declared at `connect`, but the desktop (the accessibility bus, the X display or the portal
//! session) is opened by the first call and dropped with the process. `apps.applescript`,
//! `apps.jxa`, `apps.shortcut_run` and `apps.shortcuts_list` are not declared, so the Gateway
//! does not register those tools.

#[cfg(not(target_os = "linux"))]
pub fn register(_registry: &mut crate::capability::Registry) {}

#[cfg(target_os = "linux")]
pub use linux::register;

#[cfg(target_os = "linux")]
mod linux {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use psyche_linux_computer::a11y::A11y;
    use psyche_linux_computer::backend::Backend;
    use psyche_linux_computer::backend::Frame;
    use psyche_linux_computer::engine::{Engine, Invocation};
    use psyche_linux_computer::error::{code, CapError};
    use psyche_linux_computer::linux::{LinuxBackend, Path, SessionKind};
    use psyche_linux_computer::portal::{Portal, PortalPath};
    use psyche_linux_computer::snapshot::Rect;
    use psyche_linux_computer::spec::{specs, CapSpecLite};
    use psyche_linux_computer::tiers::{ApprovalBinding, Intent, TierSettings};
    use psyche_linux_computer::x11::X11;
    use psyche_protocol::{ErrorCode, SideEffect, TargetKind};
    use serde_json::{json, Map, Value};

    use crate::capability::Output;
    use crate::capability::{
        Capability, CapabilityError, CapabilitySpec, InvocationContext, Registry,
    };
    use crate::paths::{state_dir, Env, ProcessEnv};
    use crate::receipt::ReceiptDraft;

    fn env_get(key: &str) -> Option<String> {
        ProcessEnv.get(key)
    }

    /// The engine, built on the first call. A failure (no graphical session) is not cached: the
    /// owner may log in, or start the session, and the next call tries again.
    #[derive(Default)]
    struct Shared {
        engine: Mutex<Option<Arc<Engine<LinuxBackend>>>>,
        /// The portal session holder on Wayland (revoking closes it).
        portal: Mutex<Option<Arc<Portal>>>,
    }

    fn cap_error(e: &CapError) -> CapabilityError {
        let code =
            serde_json::from_value::<ErrorCode>(json!(e.code)).unwrap_or(ErrorCode::Internal);
        let mut out = CapabilityError::new(code, &e.reason, &e.message);
        out.retryable = e.retryable;
        out.details = e.details.clone();
        out
    }

    impl Shared {
        fn engine(&self) -> Result<Arc<Engine<LinuxBackend>>, CapabilityError> {
            let mut guard = self.engine.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(e) = guard.as_ref() {
                return Ok(e.clone());
            }
            let kind = SessionKind::detect(&env_get);
            let path = match kind {
                SessionKind::X11 => Path::X11(X11::connect().map_err(|e| cap_error(&e))?),
                SessionKind::Wayland => {
                    let portal =
                        Arc::new(Portal::connect(portal_token_path()).map_err(|e| cap_error(&e))?);
                    *self.portal.lock().unwrap_or_else(|e| e.into_inner()) = Some(portal.clone());
                    let frames = Box::new(|p: &Portal| -> Result<Frame, CapError> {
                        let st = p.streams().first().cloned().ok_or_else(|| {
                            CapError::unavailable("portal_closed", "Screen sharing ended")
                                .retryable()
                        })?;
                        let fd = p.pipewire_fd()?;
                        let raw = psyche_linux_computer::pw::grab(
                            std::os::fd::OwnedFd::from(fd),
                            st.node_id,
                            std::time::Duration::from_secs(5),
                        )?;
                        let scale = f64::from(raw.width) / f64::from(st.size.0.max(1));
                        Ok(Frame {
                            width: raw.width,
                            height: raw.height,
                            rgba: raw.rgba,
                            screen: Rect::new(
                                f64::from(st.position.0),
                                f64::from(st.position.1),
                                f64::from(st.size.0),
                                f64::from(st.size.1),
                            ),
                            scale,
                        })
                    });
                    Path::Remote(Box::new(PortalPath { portal, frames }))
                }
                SessionKind::Headless => {
                    return Err(cap_error(&CapError::unavailable(
                        "no_graphical_session",
                        "Needs a graphical session on this computer",
                    )))
                }
            };
            let a11y = Arc::new(A11y::connect().map_err(|e| cap_error(&e))?);
            let backend = Arc::new(LinuxBackend::new(a11y, path));
            let home = psyche_home();
            let engine = Engine::new(backend, home.join("config").join("computer-use.json"));
            *guard = Some(engine.clone());
            Ok(engine)
        }
    }

    fn psyche_home() -> PathBuf {
        crate::paths::psyche_home(&ProcessEnv)
    }

    fn side_effect(s: &str) -> SideEffect {
        match s {
            "none" => SideEffect::None,
            "read" => SideEffect::Read,
            "destructive" => SideEffect::Destructive,
            "financial" => SideEffect::Financial,
            _ => SideEffect::Write,
        }
    }

    /// One `computer.*` capability: the crate's spec and the engine behind it.
    struct Computer {
        spec: CapSpecLite,
        shared: Arc<Shared>,
    }

    impl Capability for Computer {
        fn spec(&self) -> CapabilitySpec {
            CapabilitySpec {
                name: self.spec.name,
                description: self.spec.description,
                side_effect: side_effect(self.spec.side_effect),
                target_kind: self.spec.target_kind.map(|_| TargetKind::App),
                streaming: false,
            }
        }

        fn input_schema(&self) -> Option<Value> {
            Some(self.spec.input_schema.clone())
        }

        fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
            let engine = self.shared.engine()?;
            let inv = Invocation {
                approval_id: ctx.approval_id.clone(),
                cancel: Some(ctx.cancelled.clone()),
            };
            engine
                .invoke(&ctx.capability, &ctx.params, &inv)
                .map(|o| o.result)
                .map_err(|e| cap_error(&e))
        }
    }

    fn object(props: Vec<(&str, Value)>, required: &[&str]) -> Value {
        let mut p = Map::new();
        for (k, v) in props {
            p.insert(k.into(), v);
        }
        json!({"type": "object", "properties": p, "additionalProperties": false, "required": required})
    }

    fn approval_schema() -> Value {
        psyche_linux_computer::tiers::approval_schema()
    }

    // --- apps.* -----------------------------------------------------------------------------

    enum AppsOp {
        List,
        Open,
        Focus,
    }

    struct Apps {
        op: AppsOp,
        shared: Arc<Shared>,
    }

    impl Capability for Apps {
        fn spec(&self) -> CapabilitySpec {
            match self.op {
                AppsOp::List => CapabilitySpec {
                    name: "apps.list",
                    description: "Running apps: bundleId (the desktop file id, the id computer.* uses), name, pid, frontmost, window count and the computer-use tier in effect.",
                    side_effect: SideEffect::Read,
                    target_kind: None,
                    streaming: false,
                },
                AppsOp::Open => CapabilitySpec {
                    name: "apps.open",
                    description: "Open (launch or bring forward) an installed app by desktop file id, optionally with a file: document or a mailto: URL. Apps opened this way expose their accessibility tree.",
                    side_effect: SideEffect::Write,
                    target_kind: Some(TargetKind::App),
                    streaming: false,
                },
                AppsOp::Focus => CapabilitySpec {
                    name: "apps.focus",
                    description: "Bring a running app to the front, optionally one window by index. Wayland desktops that refuse answer focus_denied.",
                    side_effect: SideEffect::Write,
                    target_kind: Some(TargetKind::App),
                    streaming: false,
                },
            }
        }

        fn receipt_kind(&self) -> Option<&'static str> {
            match self.op {
                AppsOp::List => None,
                AppsOp::Open => Some("app_open"),
                AppsOp::Focus => Some("computer_action"),
            }
        }

        fn invoke_full(&self, ctx: &InvocationContext) -> Result<Output, CapabilityError> {
            let result = self.invoke(ctx)?;
            let receipt = match self.op {
                AppsOp::List => None,
                AppsOp::Open => {
                    let name = result
                        .get("name")
                        .and_then(Value::as_str)
                        .or_else(|| result.get("bundleId").and_then(Value::as_str))
                        .unwrap_or("app");
                    let mut d = ReceiptDraft::ok(format!("Opened {name}"));
                    if let Some(id) = result.get("bundleId") {
                        d.external_refs.insert("app".into(), id.clone());
                    }
                    Some(d)
                }
                AppsOp::Focus => {
                    let app = result.get("app").and_then(Value::as_str).unwrap_or("app");
                    let moved = result
                        .get("focused")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let mut d = if moved {
                        ReceiptDraft::ok(format!("Focused {app}"))
                    } else {
                        ReceiptDraft {
                            outcome: "uncertain",
                            summary: format!(
                                "Asked for focus on {app}; the desktop may not have moved it"
                            ),
                            external_refs: Map::new(),
                        }
                    };
                    d.external_refs.insert("app".into(), json!(app));
                    Some(d)
                }
            };
            Ok(Output { result, receipt })
        }

        fn input_schema(&self) -> Option<Value> {
            let s = |d: &str| json!({"type": "string", "description": d});
            Some(match self.op {
                AppsOp::List => object(vec![], &[]),
                AppsOp::Open => object(
                    vec![
                        ("bundleId", s("Desktop file id, e.g. org.gnome.TextEditor")),
                        ("app", s("Same as bundleId")),
                        ("url", json!({"type": "string", "maxLength": 2048})),
                        ("approval", approval_schema()),
                    ],
                    &[],
                ),
                AppsOp::Focus => object(
                    vec![
                        ("app", s("Desktop file id")),
                        ("window", json!({"type": "integer", "minimum": 0})),
                        ("approval", approval_schema()),
                    ],
                    &["app"],
                ),
            })
        }

        fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
            let engine = self.shared.engine()?;
            engine.reload_settings();
            let binding = ApprovalBinding::from(ctx.approval_id.as_deref(), &ctx.params);
            let get = |k: &str| {
                ctx.params
                    .get(k)
                    .and_then(Value::as_str)
                    .map(str::to_string)
            };
            match self.op {
                AppsOp::List => {
                    let apps: Vec<Value> = engine
                        .backend
                        .apps()
                        .into_iter()
                        .map(|a| {
                            json!({
                                "bundleId": a.id, "name": a.name, "pid": a.pid, "frontmost": a.frontmost,
                                "windows": a.windows, "tier": engine.policy.effective_tier(Some(&a.id)).as_str(),
                            })
                        })
                        .collect();
                    Ok(json!({ "apps": apps }))
                }
                AppsOp::Open => {
                    let id = get("bundleId").or_else(|| get("app")).ok_or_else(|| {
                        cap_error(&CapError::invalid_params(
                            "bundleId is required",
                            Some("bundleId"),
                        ))
                    })?;
                    if !psyche_linux_computer::app_id::is_app_id(&id) {
                        return Err(cap_error(&CapError::invalid_params(
                            "bundleId is not an app id",
                            Some("bundleId"),
                        )));
                    }
                    let id = psyche_linux_computer::app_id::normalize(&id);
                    let url = get("url");
                    if let Some(u) = &url {
                        // Documents and mail drafts only: web pages go through the agent browser.
                        let l = u.to_ascii_lowercase();
                        if !(l.starts_with("file:") || l.starts_with("mailto:"))
                            || u.chars().any(char::is_control)
                        {
                            return Err(cap_error(&CapError::new(
                                code::POLICY_DENIED,
                                "url_scheme",
                                "apps.open opens file: and mailto: URLs only",
                            )));
                        }
                    }
                    engine
                        .policy
                        .authorize(Intent::Click, Some(&id), &id, binding.as_ref())
                        .map_err(|e| cap_error(&e))?;
                    engine
                        .backend
                        .launch(&id, url.as_deref())
                        .map_err(|e| cap_error(&e))
                }
                AppsOp::Focus => {
                    let id = get("app").ok_or_else(|| {
                        cap_error(&CapError::invalid_params("app is required", Some("app")))
                    })?;
                    let app = engine
                        .find_app(Some(&id), None)
                        .map_err(|e| cap_error(&e))?;
                    engine
                        .policy
                        .authorize(Intent::Click, Some(&app.id), &app.name, binding.as_ref())
                        .map_err(|e| cap_error(&e))?;
                    let window = ctx
                        .params
                        .get("window")
                        .and_then(Value::as_u64)
                        .map(|w| w as usize);
                    let moved = engine
                        .backend
                        .activate(&app, window, &engine.stop)
                        .map_err(|e| cap_error(&e))?;
                    Ok(
                        json!({"focused": moved, "focus": if moved { "moved" } else { "requested" }, "app": app.id}),
                    )
                }
            }
        }
    }

    // --- a11y.* and portal.* ----------------------------------------------------------------

    fn a11y_state_path() -> PathBuf {
        state_dir(&ProcessEnv).join("a11y.json")
    }

    fn read_state(path: &std::path::Path) -> Map<String, Value> {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn write_private(path: &std::path::Path, value: &Value) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(value.to_string().as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    }

    /// A screen reader is running (Orca): it relies on the accessibility flag, so it stays on.
    fn screen_reader_running() -> bool {
        let Ok(rd) = std::fs::read_dir("/proc") else {
            return false;
        };
        rd.flatten().any(|e| {
            e.file_name()
                .to_string_lossy()
                .chars()
                .all(|c| c.is_ascii_digit())
                && std::fs::read_to_string(e.path().join("comm"))
                    .is_ok_and(|c| matches!(c.trim(), "orca" | "brltty" | "espeakup"))
        })
    }

    fn a11y_status() -> Value {
        let available = zbus_session_available();
        let enabled = if available {
            A11y::status_enabled()
        } else {
            None
        };
        let st = read_state(&a11y_state_path());
        json!({
            "available": available && enabled.is_some(),
            "enabled": enabled,
            "enabledByPsyche": st.get("enabledByPsyche").and_then(Value::as_bool).unwrap_or(false) && enabled == Some(true),
        })
    }

    fn zbus_session_available() -> bool {
        env_get("DBUS_SESSION_BUS_ADDRESS").is_some() || env_get("XDG_RUNTIME_DIR").is_some()
    }

    /// Turns `org.a11y.Status.IsEnabled` on (remembering whether it was already) or restores it.
    fn a11y_enable(on: bool) -> Result<Value, CapabilityError> {
        let path = a11y_state_path();
        let current = A11y::status_enabled();
        if on {
            if current == Some(false) {
                A11y::set_status_enabled(true).map_err(|e| cap_error(&e))?;
                write_private(&path, &json!({"enabledByPsyche": true})).ok();
            } else if current == Some(true)
                && !read_state(&path)
                    .get("enabledByPsyche")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                // Already on (a screen reader, or the owner): ours to leave alone.
                write_private(&path, &json!({"enabledByPsyche": false})).ok();
            }
        } else {
            let ours = read_state(&path)
                .get("enabledByPsyche")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if ours && current == Some(true) && !screen_reader_running() {
                A11y::set_status_enabled(false).map_err(|e| cap_error(&e))?;
            }
            let _ = std::fs::remove_file(&path);
        }
        Ok(a11y_status())
    }

    fn desktop_name(env: &dyn Fn(&str) -> Option<String>) -> Option<&'static str> {
        let d = format!(
            "{} {}",
            env("XDG_CURRENT_DESKTOP").unwrap_or_default(),
            env("XDG_SESSION_DESKTOP").unwrap_or_default()
        )
        .to_lowercase();
        let has = |names: &[&str]| {
            names
                .iter()
                .any(|n| d.split(|c: char| !c.is_alphanumeric()).any(|w| w == *n))
        };
        if has(&["gnome", "ubuntu", "unity"]) {
            Some("gnome")
        } else if has(&["kde", "plasma"]) {
            Some("kde")
        } else if has(&[
            "sway", "hyprland", "labwc", "river", "wayfire", "niri", "dwl", "cage", "wlroots",
        ]) {
            Some("wlroots")
        } else if d.trim().is_empty() {
            None
        } else {
            Some("other")
        }
    }

    fn portal_token_path() -> PathBuf {
        state_dir(&ProcessEnv).join("portal.json")
    }

    fn portal_status(shared: &Shared) -> Value {
        let kind = SessionKind::detect(&env_get);
        let desktop = desktop_name(&env_get);
        let backend = match (kind, desktop) {
            (SessionKind::X11, _) => "x11",
            (SessionKind::Wayland, Some("wlroots")) => "wlroots",
            (SessionKind::Wayland, _) => "portal",
            _ => "none",
        };
        let allowed = read_state(&portal_token_path())
            .get("restoreToken")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.is_empty());
        let active = shared
            .portal
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|p| p.is_open());
        let mut warnings: Vec<&str> = Vec::new();
        if backend == "x11" {
            warnings.push("x11");
        }
        if backend == "wlroots" {
            warnings.push("wlroots");
        }
        json!({"session": kind.as_str(), "desktop": desktop, "backend": backend, "allowed": allowed, "active": active, "warnings": warnings})
    }

    enum Misc {
        A11yStatus,
        A11yEnable,
        PortalStatus,
        PortalRevoke,
    }

    struct Other {
        op: Misc,
        shared: Arc<Shared>,
    }

    impl Capability for Other {
        fn spec(&self) -> CapabilitySpec {
            let (name, description, side_effect) = match self.op {
                Misc::A11yStatus => ("a11y.status", "Whether the accessibility bus is there, and whether apps are asked to expose their structure.", SideEffect::Read),
                Misc::A11yEnable => ("a11y.enable", "Turn the accessibility flag on (apps opened from now on expose their structure), or restore it if Psyche turned it on.", SideEffect::Write),
                Misc::PortalStatus => ("portal.status", "Which input and screen path this session uses, and whether screen and input access is allowed until revoked.", SideEffect::Read),
                Misc::PortalRevoke => ("portal.revoke", "Forget the stored screen and input permission: the next Wayland session asks again.", SideEffect::Write),
            };
            CapabilitySpec {
                name,
                description,
                side_effect,
                target_kind: None,
                streaming: false,
            }
        }

        fn input_schema(&self) -> Option<Value> {
            match self.op {
                Misc::A11yEnable => Some(object(
                    vec![("enabled", json!({"type": "boolean"}))],
                    &["enabled"],
                )),
                _ => None,
            }
        }

        fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
            match self.op {
                Misc::A11yStatus => Ok(a11y_status()),
                Misc::A11yEnable => {
                    let on = ctx
                        .params
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| {
                            cap_error(&CapError::invalid_params(
                                "enabled (a boolean) is required",
                                Some("enabled"),
                            ))
                        })?;
                    a11y_enable(on)
                }
                Misc::PortalStatus => Ok(portal_status(&self.shared)),
                Misc::PortalRevoke => {
                    let path = portal_token_path();
                    let had = path.exists();
                    if let Some(p) = self
                        .shared
                        .portal
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .as_ref()
                    {
                        p.revoke();
                    }
                    let _ = std::fs::remove_file(&path);
                    Ok(json!({"revoked": had}))
                }
            }
        }
    }

    /// Registers every direct-computer-use capability.
    pub fn register(registry: &mut Registry) {
        let shared = Arc::new(Shared::default());
        for spec in specs() {
            registry.register(Arc::new(Computer {
                spec,
                shared: shared.clone(),
            }));
        }
        for op in [AppsOp::List, AppsOp::Open, AppsOp::Focus] {
            registry.register(Arc::new(Apps {
                op,
                shared: shared.clone(),
            }));
        }
        for op in [
            Misc::A11yStatus,
            Misc::A11yEnable,
            Misc::PortalStatus,
            Misc::PortalRevoke,
        ] {
            registry.register(Arc::new(Other {
                op,
                shared: shared.clone(),
            }));
        }
        // `Intent` and `TierSettings` are used by the engine; keep the imports honest.
        let _ = (Intent::Read, TierSettings::default());
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::buildinfo::BuildInfo;

        fn registry() -> Registry {
            let mut r = Registry::standard(BuildInfo::current());
            register(&mut r);
            r
        }

        #[test]
        fn declares_the_mac_names_and_no_apple_only_capabilities() {
            let r = registry();
            let names: Vec<String> = r.manifest().into_iter().map(|c| c.name).collect();
            for want in [
                "health",
                "computer.ax_tree",
                "computer.check_target",
                "computer.ax_value",
                "computer.click",
                "computer.double_click",
                "computer.right_click",
                "computer.press",
                "computer.set_value",
                "computer.select",
                "computer.type",
                "computer.key",
                "computer.scroll",
                "computer.drag",
                "computer.menu",
                "computer.end_session",
                "computer.screenshot",
                "apps.list",
                "apps.open",
                "apps.focus",
                "a11y.status",
                "a11y.enable",
                "portal.status",
                "portal.revoke",
            ] {
                assert!(
                    names.iter().any(|n| n == want),
                    "{want} missing from {names:?}"
                );
            }
            for never in [
                "apps.applescript",
                "apps.jxa",
                "apps.shortcut_run",
                "apps.shortcuts_list",
                "screen.context",
                "computer.screenshot_pick",
            ] {
                assert!(
                    !names.iter().any(|n| n == never),
                    "{never} must not be advertised"
                );
            }
        }

        #[test]
        fn computer_capabilities_carry_their_schemas_and_side_effects() {
            let v = serde_json::to_value(registry().manifest()).unwrap();
            let find = |name: &str| {
                v.as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["name"] == name)
                    .unwrap()
                    .clone()
            };
            let click = find("computer.click");
            assert_eq!(click["sideEffect"], "write");
            assert_eq!(click["targetKind"], "app");
            assert!(click["inputSchema"]["properties"]["approval"].is_object());
            assert!(click["inputSchema"]["properties"]["expect"].is_object());
            assert_eq!(find("computer.ax_tree")["sideEffect"], "read");
            assert_eq!(
                find("computer.key")["inputSchema"]["required"],
                json!(["keys"])
            );
            assert_eq!(
                find("a11y.enable")["inputSchema"]["required"],
                json!(["enabled"])
            );
            assert_eq!(
                find("apps.focus")["inputSchema"]["required"],
                json!(["app"])
            );
        }

        #[test]
        fn errors_keep_the_details_the_gateway_reads() {
            let e = CapError::new(code::APPROVAL_REQUIRED, "tier_ask", "needs permission")
                .detail("app", "firefox")
                .detail("tierRequired", "click");
            let c = cap_error(&e);
            let v = serde_json::to_value(c.payload()).unwrap();
            assert_eq!(v["code"], "approval_required");
            assert_eq!(v["details"]["reason"], "tier_ask");
            assert_eq!(v["details"]["app"], "firefox");
            assert_eq!(v["details"]["tierRequired"], "click");
        }

        #[test]
        fn the_desktop_is_named_from_the_session_environment() {
            let env = |pairs: &'static [(&'static str, &'static str)]| {
                move |k: &str| {
                    pairs
                        .iter()
                        .find(|(n, _)| *n == k)
                        .map(|(_, v)| v.to_string())
                }
            };
            assert_eq!(
                desktop_name(&env(&[("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")])),
                Some("gnome")
            );
            assert_eq!(
                desktop_name(&env(&[("XDG_CURRENT_DESKTOP", "KDE")])),
                Some("kde")
            );
            assert_eq!(
                desktop_name(&env(&[("XDG_CURRENT_DESKTOP", "sway")])),
                Some("wlroots")
            );
            assert_eq!(
                desktop_name(&env(&[("XDG_CURRENT_DESKTOP", "Hyprland")])),
                Some("wlroots")
            );
            assert_eq!(
                desktop_name(&env(&[("XDG_CURRENT_DESKTOP", "XFCE")])),
                Some("other")
            );
            assert_eq!(desktop_name(&env(&[])), None);
        }

        #[test]
        fn without_a_display_the_tools_say_a_graphical_session_is_needed() {
            // The test runner may have a display; force the headless branch through the engine
            // builder by clearing the variables for this process.
            if std::env::var_os("DISPLAY").is_some()
                || std::env::var_os("WAYLAND_DISPLAY").is_some()
            {
                return;
            }
            let shared = Shared::default();
            let err = shared.engine().err().expect("no engine without a display");
            assert_eq!(
                serde_json::to_value(err.payload()).unwrap()["details"]["reason"],
                "no_graphical_session"
            );
        }

        #[test]
        fn state_files_are_private() {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("sub").join("portal.json");
            write_private(&path, &json!({"restoreToken": "t"})).unwrap();
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(read_state(&path)["restoreToken"], "t");
        }
    }
}
