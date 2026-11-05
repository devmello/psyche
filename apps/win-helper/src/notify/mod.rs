//! `notify.*` (architecture §6, feature O10) on Windows toasts: `notify.show`, `notify.withdraw`,
//! `notify.authorization_status`, `notify.request_authorization`, `notify.subscribe`.
//!
//! Responses (button clicks, text replies, clicks on the toast, dismissals) are delivered as
//! `notify.response` events on the long-lived `notify.subscribe` invocation, exactly like the mac
//! helper. Approve on an approval card that `requireBiometry` runs Windows Hello and signs the
//! card's `presenceChallenge` with the presence key before the answer is forwarded.
//!
//! Windows differences, same shapes: there is no "not determined" state (toasts are allowed
//! until the user turns them off), so `authorization_status.status` is `authorized` or `denied`,
//! and `request_authorization` never prompts; `alert`/`sound` follow the per-app toggle,
//! `badge` is `notSupported`, `timeSensitive` is `unknown` (Do not disturb is not readable).

pub mod hub;
pub mod plan;
pub mod toast;

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use windows::UI::Notifications::NotificationSetting;
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::node::capability::{
    CapabilityError, CapabilityOutput, CapabilitySpec, ReceiptDraft, SideEffect,
};
use crate::node::schema;
use crate::node::{CapabilityRegistry, Runtime};
use plan::{
    ID_PATTERN, MAX_ACTION_LABEL, MAX_ACTIONS, MAX_BODY, MAX_ID_LENGTH, MAX_SUBTITLE, MAX_TITLE,
    NotificationKind, NotificationPlan, NotifyShowParams, is_valid_id,
};
use toast::{ToastCenter, current_setting, setting_name};

/// The shared toast center (one per process).
pub fn center(rt: &Runtime) -> Arc<ToastCenter> {
    rt.service(|| ToastCenter::new(rt.log.clone()))
        .as_ref()
        .clone()
}

fn local_minute_of_day() -> u32 {
    // SAFETY: plain query.
    let t = unsafe { GetLocalTime() };
    t.wHour as u32 * 60 + t.wMinute as u32
}

fn id_schema(description: &str) -> Value {
    schema::string_pattern(description, ID_PATTERN, MAX_ID_LENGTH as u64)
}

fn show_schema() -> Value {
    schema::object(
        vec![
            (
                "id",
                id_schema("Gateway notification id; reusing it replaces the shown notification"),
            ),
            (
                "kind",
                schema::string_enum(Some("NotificationKind"), &NotificationKind::NAMES),
            ),
            (
                "title",
                schema::string(Some(&format!("Truncated to {MAX_TITLE} characters"))),
            ),
            (
                "body",
                schema::string(Some(&format!("Truncated to {MAX_BODY} characters"))),
            ),
            (
                "subtitle",
                schema::string(Some(&format!("Truncated to {MAX_SUBTITLE} characters"))),
            ),
            (
                "actions",
                schema::array(
                    schema::object(
                        vec![
                            (
                                "id",
                                id_schema(
                                    "Action id returned as actionId (not default, dismiss or reply)",
                                ),
                            ),
                            ("label", schema::string_max(None, MAX_ACTION_LABEL as u64)),
                            ("destructive", schema::boolean(None)),
                            (
                                "requiresAuth",
                                schema::boolean(Some("Device must be unlocked")),
                            ),
                        ],
                        &["id", "label"],
                    ),
                    Some("Replaces the kind's default buttons"),
                    Some(MAX_ACTIONS as u64),
                ),
            ),
            (
                "reply",
                schema::object_with(
                    vec![
                        ("label", schema::string_max(None, MAX_ACTION_LABEL as u64)),
                        ("placeholder", schema::string(None)),
                    ],
                    &["label"],
                    Some("Inline text reply (input_needed has one by default)"),
                    false,
                ),
            ),
            (
                "threadId",
                id_schema("Groups notifications in the notification center"),
            ),
            (
                "route",
                schema::string(Some(
                    "Deep link inside the app (not stored in the OS notification)",
                )),
            ),
            (
                "interruption",
                schema::string_enum(
                    Some("Overrides the kind's default level"),
                    &["passive", "active", "timeSensitive"],
                ),
            ),
            (
                "approvalId",
                id_schema("Approval answered by this notification"),
            ),
            (
                "requireBiometry",
                schema::boolean(Some(
                    "Run Windows Hello before forwarding a non-destructive action",
                )),
            ),
            (
                "presenceChallenge",
                schema::string_max(
                    Some("Hex SHA-256 the Windows Hello presence key signs (with requireBiometry)"),
                    64,
                ),
            ),
            (
                "quietHours",
                schema::object_with(
                    vec![
                        ("start", schema::string(Some("HH:mm"))),
                        ("end", schema::string(Some("HH:mm"))),
                    ],
                    &["end", "start"],
                    Some("Local-time window during which the notification is passive and silent"),
                    false,
                ),
            ),
            (
                "sound",
                schema::boolean(Some("Defaults to true unless the level is passive")),
            ),
        ],
        &["body", "id", "kind", "title"],
    )
}

fn setting_json(setting: Option<NotificationSetting>, registered: bool) -> Value {
    let enabled = setting == Some(NotificationSetting::Enabled);
    let status = match setting {
        Some(NotificationSetting::Enabled) => "authorized",
        Some(_) => "denied",
        None => "notDetermined",
    };
    let on = if enabled { "enabled" } else { "disabled" };
    json!({
        "status": status,
        "alert": on,
        "sound": on,
        "badge": "notSupported",
        "timeSensitive": "unknown",
        "notificationCenter": on,
        "setting": setting.map_or("Unknown", setting_name),
        "registered": registered,
    })
}

#[derive(Deserialize)]
struct WithdrawParams {
    id: String,
}

#[derive(Deserialize)]
struct RequestParams {
    provisional: Option<bool>,
}

pub fn register(reg: &mut CapabilityRegistry) {
    let rt = reg.runtime().clone();
    let c = center(&rt);
    if rt.live {
        let write = rt.env.get("PSYCHE_HELPER_NO_REGISTER") != Some("1");
        c.start(write);
    }

    let center_show = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "notify.show",
            "Show a Windows toast notification with per-kind actions, an optional text reply, an interruption level and quiet hours.",
            SideEffect::Write,
        )
        .input(show_schema())
        .receipt("notification"),
        move |ctx| {
            let p = NotifyShowParams::from_value(&ctx.params)?;
            let plan = NotificationPlan::make(&p, local_minute_of_day())?;
            let outcome = center_show.show(&plan)?;
            Ok(CapabilityOutput::with_receipt(
                json!({
                    "delivered": true,
                    "interruptionLevel": outcome.interruption.as_str(),
                    "quietHoursApplied": plan.quiet_hours_applied,
                    "category": plan.category.identifier,
                    "authorization": outcome.authorization,
                }),
                ReceiptDraft::ok(format!("Showed a {} notification", plan.kind.as_str())).with_ref("notificationId", plan.id.clone()),
            ))
        },
    );

    let center_withdraw = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "notify.withdraw",
            "Remove a delivered or pending notification by id.",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![("id", id_schema("Gateway notification id"))],
            &["id"],
        ))
        .receipt("notification"),
        move |ctx| {
            let p: WithdrawParams = ctx.decode()?;
            if !is_valid_id(&p.id) {
                return Err(CapabilityError::invalid_params(
                    format!("id must match {ID_PATTERN}"),
                    Some("id"),
                ));
            }
            center_withdraw.withdraw(&p.id)?;
            Ok(CapabilityOutput::with_receipt(
                json!({ "withdrawn": true }),
                ReceiptDraft::ok("Withdrew a notification").with_ref("notificationId", p.id),
            ))
        },
    );

    let center_status = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "notify.authorization_status",
            "Notification authorization (authorized or denied: Windows allows toasts until the user turns them off) and alert/sound/badge/time-sensitive settings.",
            SideEffect::Read,
        ),
        move |_| {
            center_status.require_registered()?;
            Ok(CapabilityOutput::new(setting_json(current_setting(), center_status.is_registered())))
        },
    );

    let center_request = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "notify.request_authorization",
            "Request notification authorization. Windows has no prompt for toasts (they are on until the user turns them off), so this reports the current state; granted is false when they are off.",
            SideEffect::Write,
        )
        .input(schema::object(vec![("provisional", schema::boolean(Some("Default true (security §12: provisional first)")))], &[]))
        .receipt("notification"),
        move |ctx| {
            let p: RequestParams = ctx.decode()?;
            let provisional = p.provisional.unwrap_or(true);
            center_request.require_registered()?;
            let setting = current_setting();
            let mut result = setting_json(setting, center_request.is_registered());
            result["granted"] = (setting == Some(NotificationSetting::Enabled)).into();
            Ok(CapabilityOutput::with_receipt(
                result,
                ReceiptDraft::ok(if provisional {
                    "Requested provisional notification authorization"
                } else {
                    "Requested notification authorization"
                }),
            ))
        },
    );

    let center_sub = c;
    reg.add(
        CapabilitySpec::new(
            "notify.subscribe",
            "Stream notify.response events (notificationId, actionId, replyText, approvalId, authenticated) until cancelled. Responses received while no subscriber is open are buffered (up to 100).",
            SideEffect::Read,
        )
        .streaming(),
        move |ctx| {
            let center = center_sub.clone();
            async move {
                center.require_registered()?;
                let mut sub = center.hub.subscribe();
                while let Some(r) = sub.rx.recv().await {
                    ctx.emit(r.payload());
                }
                // The stream only ends when this invocation is cancelled.
                Err(CapabilityError::cancelled())
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Registers the toast identity (HKCU + Start-menu shortcut), posts a passive (silent,
    /// notification-center only) toast and withdraws it: `cargo test -- --ignored live_toast`.
    #[test]
    #[ignore]
    fn live_toast_show_and_withdraw() {
        crate::win::com::ensure_mta();
        let c = ToastCenter::new(crate::node::log::HelperLog::quiet());
        c.start(true);
        assert!(c.is_registered());
        let p = NotifyShowParams::from_value(&json!({"id": "psyche-live-test", "kind": "briefing", "title": "Psyche Helper test", "body": "Safe to ignore"})).unwrap();
        let plan = NotificationPlan::make(&p, 0).unwrap();
        match c.show(&plan) {
            Ok(o) => assert_eq!(o.interruption.as_str(), "passive"),
            // Toasts turned off for the app: reported as a missing permission, not a crash.
            Err(e) => assert_eq!(e.reason, "permission_missing", "{e:?}"),
        }
        c.withdraw("psyche-live-test").unwrap();
    }

    /// Activates the registered COM class the way Windows does after a toast click.
    #[test]
    #[ignore]
    fn live_activator_delivers_responses() {
        use windows::Win32::System::Com::{CLSCTX_LOCAL_SERVER, CoCreateInstance};
        use windows::Win32::UI::Notifications::{
            INotificationActivationCallback, NOTIFICATION_USER_INPUT_DATA,
        };
        use windows::core::{HSTRING, PCWSTR};
        crate::win::com::ensure_mta();
        let c = ToastCenter::new(crate::node::log::HelperLog::quiet());
        c.start(true);
        let info = plan::UserInfo {
            notification_id: "n-live".into(),
            kind: "input_needed".into(),
            approval_id: Some("apr_live".into()),
            require_biometry: false,
            destructive_action_ids: vec![],
            presence_challenge: None,
        };
        let args = HSTRING::from(plan::encode_args(&info, "reply"));
        let (k, v) = (HSTRING::from("reply"), HSTRING::from("typed answer"));
        let data = [NOTIFICATION_USER_INPUT_DATA {
            Key: PCWSTR(k.as_ptr()),
            Value: PCWSTR(v.as_ptr()),
        }];
        // SAFETY: COM activation of the class this process just registered.
        unsafe {
            let cb: INotificationActivationCallback =
                CoCreateInstance(&toast::TOAST_ACTIVATOR_CLSID, None, CLSCTX_LOCAL_SERVER).unwrap();
            cb.Activate(&HSTRING::from(toast::AUMID), &args, &data)
                .unwrap();
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut sub = c.hub.subscribe();
        let r = rt
            .block_on(async {
                tokio::time::timeout(std::time::Duration::from_secs(5), sub.rx.recv()).await
            })
            .unwrap()
            .unwrap();
        let p = r.payload();
        assert_eq!(p["notificationId"], "n-live");
        assert_eq!(p["actionId"], "reply");
        assert_eq!(p["replyText"], "typed answer");
        assert_eq!(p["approvalId"], "apr_live");
        assert_eq!(p["authenticated"], false);
    }
}
