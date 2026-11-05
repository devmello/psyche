//! Live adapter over Windows toast notifications for an unpackaged Win32 process.
//!
//! Identity: AppUserModelID `com.psyche.helper`, registered per user (no admin) under
//! `HKCU\Software\Classes\AppUserModelId\com.psyche.helper` (`DisplayName`, `CustomActivator`) and
//! a Start-menu shortcut `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Psyche Helper.lnk` with
//! `System.AppUserModel.ID` and `System.AppUserModel.ToastActivatorCLSID` set (created only when
//! missing; the installer normally creates it).
//!
//! Activation: toast buttons use `activationType="background"`, so Windows calls the COM class
//! `TOAST_ACTIVATOR_CLSID` (`INotificationActivationCallback`). While the helper runs it serves
//! that class itself (`CoRegisterClassObject`); when it does not, COM starts
//! `HKCU\Software\Classes\CLSID\{…}\LocalServer32` (`"psyche-helper.exe" -ToastActivated`), which
//! registers the class, receives the click and buffers the response until the Gateway's
//! `notify.subscribe` picks it up. Dismissals come from the toast's `Dismissed` event.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{
    NotificationSetting, ToastDismissalReason, ToastDismissedEventArgs, ToastNotification, ToastNotificationManager,
    ToastNotificationPriority,
};
use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_POINTER};
use windows::Win32::System::Com::{CLSCTX_LOCAL_SERVER, CoRegisterClassObject, IClassFactory, IClassFactory_Impl, REGCLS_MULTIPLEUSE};
use windows::Win32::UI::Notifications::{INotificationActivationCallback, INotificationActivationCallback_Impl, NOTIFICATION_USER_INPUT_DATA};
use windows::Win32::UI::Shell::{FOLDERID_Programs, SetCurrentProcessExplicitAppUserModelID};
use windows::core::{BOOL, GUID, HSTRING, IUnknown, Interface, PCWSTR, Ref, implement};

use super::hub::ResponseHub;
use super::plan::{
    DEFAULT_ACTION_ID, DISMISS_ACTION_ID, Interruption, NotificationPlan, NotificationResponse, REPLY_ACTION_ID, decode_args,
    log_action_class, tag_for, toast_xml,
};
use crate::node::cancel::CancelToken;
use crate::node::capability::{CapabilityError, ErrorCode, OsPermission};
use crate::node::log::HelperLog;
use crate::win::{registry, shell};

pub const AUMID: &str = "com.psyche.helper";
pub const DISPLAY_NAME: &str = "Psyche";
pub const TOAST_GROUP: &str = "psyche";
pub const SHORTCUT_NAME: &str = "Psyche Helper.lnk";
/// `{B1DFC43D-98FC-44C2-9C1B-F3C21D0871C6}`: the toast activator COM class (installer contract).
pub const TOAST_ACTIVATOR_CLSID: GUID = GUID::from_u128(0xB1DFC43D_98FC_44C2_9C1B_F3C21D0871C6);

pub fn clsid_string() -> String {
    format!("{{{:?}}}", TOAST_ACTIVATOR_CLSID).to_uppercase()
}

/// `NotificationSetting` name.
pub fn setting_name(s: NotificationSetting) -> &'static str {
    match s {
        NotificationSetting::Enabled => "Enabled",
        NotificationSetting::DisabledForApplication => "DisabledForApplication",
        NotificationSetting::DisabledForUser => "DisabledForUser",
        NotificationSetting::DisabledByGroupPolicy => "DisabledByGroupPolicy",
        NotificationSetting::DisabledByManifest => "DisabledByManifest",
        _ => "Unknown",
    }
}

/// The toast setting for the helper's AUMID (never prompts).
pub fn current_setting() -> Option<NotificationSetting> {
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID)).and_then(|n| n.Setting()).ok()
}

/// `notifications` permission state: `granted` | `denied` | `restricted` | `unknown`.
pub fn permission_state() -> &'static str {
    match current_setting() {
        Some(NotificationSetting::Enabled) => "granted",
        Some(NotificationSetting::DisabledByGroupPolicy | NotificationSetting::DisabledByManifest) => "restricted",
        Some(_) => "denied",
        None => "unknown",
    }
}

pub struct ShowOutcome {
    pub interruption: Interruption,
    pub authorization: &'static str,
}

type ActivationFn = Arc<dyn Fn(String, Vec<(String, String)>) + Send + Sync>;

#[implement(INotificationActivationCallback)]
struct Activator {
    on_activate: ActivationFn,
}

impl INotificationActivationCallback_Impl for Activator_Impl {
    fn Activate(&self, _aumid: &PCWSTR, invoked_args: &PCWSTR, data: *const NOTIFICATION_USER_INPUT_DATA, count: u32) -> windows::core::Result<()> {
        // SAFETY: COM hands us `count` entries and NUL-terminated strings valid for this call.
        let (args, inputs) = unsafe {
            let args = if invoked_args.is_null() { String::new() } else { invoked_args.to_string().unwrap_or_default() };
            let mut inputs = Vec::new();
            if !data.is_null() {
                for e in std::slice::from_raw_parts(data, count as usize) {
                    let k = if e.Key.is_null() { String::new() } else { e.Key.to_string().unwrap_or_default() };
                    let v = if e.Value.is_null() { String::new() } else { e.Value.to_string().unwrap_or_default() };
                    inputs.push((k, v));
                }
            }
            (args, inputs)
        };
        // Return at once: authentication (if any) runs on its own thread.
        (self.on_activate)(args, inputs);
        Ok(())
    }
}

#[implement(IClassFactory)]
struct ActivatorFactory {
    on_activate: ActivationFn,
}

impl IClassFactory_Impl for ActivatorFactory_Impl {
    fn CreateInstance(&self, outer: Ref<IUnknown>, riid: *const GUID, object: *mut *mut core::ffi::c_void) -> windows::core::Result<()> {
        if object.is_null() {
            return Err(E_POINTER.into());
        }
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let unknown: IUnknown = Activator { on_activate: self.on_activate.clone() }.into();
        // SAFETY: riid/object come from COM and are valid for the call.
        unsafe { unknown.query(riid, object).ok() }
    }

    fn LockServer(&self, _lock: BOOL) -> windows::core::Result<()> {
        Ok(())
    }
}

#[derive(Default)]
struct State {
    registered: Option<Result<(), String>>,
    class_cookie: Option<u32>,
    toasts: HashMap<String, ToastNotification>,
}

/// Owns the toast identity, the COM activator and the shown toasts.
pub struct ToastCenter {
    pub hub: Arc<ResponseHub>,
    log: HelperLog,
    state: Mutex<State>,
}

impl ToastCenter {
    pub fn new(log: HelperLog) -> Arc<ToastCenter> {
        Arc::new(ToastCenter { hub: ResponseHub::new(super::hub::DEFAULT_CAPACITY), log, state: Mutex::new(State::default()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn is_registered(&self) -> bool {
        matches!(self.lock().registered, Some(Ok(())))
    }

    /// Registers the AUMID, the activator and (if missing) the Start-menu shortcut, then serves
    /// the activator class. Idempotent. Never touches HKLM.
    pub fn start(self: &Arc<Self>, write_registration: bool) {
        let result = self.register_identity(write_registration).and_then(|()| self.register_class());
        match &result {
            Ok(()) => self.log.info("notify: toast identity registered, activator serving"),
            Err(e) => self.log.error(format!("notify: unavailable ({e})")),
        }
        self.lock().registered = Some(result);
    }

    fn register_identity(&self, write: bool) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e.kind()))?;
        if write {
            let clsid = clsid_string();
            let command = format!("\"{}\" -ToastActivated", exe.display());
            let server_key = format!(r"Software\Classes\CLSID\{clsid}\LocalServer32");
            if registry::read_string(registry::Hive::CurrentUser, &server_key, "").as_deref() != Some(command.as_str()) {
                registry::write_user_string(&format!(r"Software\Classes\CLSID\{clsid}"), "", "Psyche Helper toast activator")
                    .and_then(|()| registry::write_user_string(&server_key, "", &command))
                    .map_err(|e| format!("activator registration 0x{:08X}", e.code().0 as u32))?;
            }
            let aumid_key = format!(r"Software\Classes\AppUserModelId\{AUMID}");
            registry::write_user_string(&aumid_key, "DisplayName", DISPLAY_NAME)
                .and_then(|()| registry::write_user_string(&aumid_key, "CustomActivator", &clsid))
                .map_err(|e| format!("AUMID registration 0x{:08X}", e.code().0 as u32))?;
            if let Some(programs) = shell::known_folder(&FOLDERID_Programs) {
                let lnk = programs.join(SHORTCUT_NAME);
                if !lnk.exists() {
                    match shell::write_shortcut(&lnk, &exe, "", "Psyche Helper", AUMID, &TOAST_ACTIVATOR_CLSID) {
                        Ok(()) => self.log.info("notify: created the Start-menu shortcut"),
                        // The registry identity is enough for toasts; the shortcut is a fallback.
                        Err(e) => self.log.error(format!("notify: shortcut not created (0x{:08X})", e.code().0 as u32)),
                    }
                }
            }
        }
        // SAFETY: plain call with a static string.
        unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID)) }
            .map_err(|e| format!("SetCurrentProcessExplicitAppUserModelID 0x{:08X}", e.code().0 as u32))
    }

    fn register_class(self: &Arc<Self>) -> Result<(), String> {
        if self.lock().class_cookie.is_some() {
            return Ok(());
        }
        let weak = Arc::downgrade(self);
        let on_activate: ActivationFn = Arc::new(move |args, inputs| {
            if let Some(center) = weak.upgrade() {
                center.on_activated(&args, inputs);
            }
        });
        let factory: IClassFactory = ActivatorFactory { on_activate }.into();
        // SAFETY: the factory stays registered (and alive in COM's table) for the process lifetime.
        let cookie = unsafe { CoRegisterClassObject(&TOAST_ACTIVATOR_CLSID, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE) }
            .map_err(|e| format!("CoRegisterClassObject 0x{:08X}", e.code().0 as u32))?;
        self.lock().class_cookie = Some(cookie);
        Ok(())
    }

    pub fn require_registered(&self) -> Result<(), CapabilityError> {
        match &self.lock().registered {
            Some(Ok(())) => Ok(()),
            _ => Err(CapabilityError::unavailable(
                "not_registered",
                "Toast notifications need Psyche Helper's notification identity (AppUserModelID com.psyche.helper), which could not be registered.",
            )),
        }
    }

    /// A click on the toast or one of its buttons (COM activator).
    fn on_activated(self: &Arc<Self>, args: &str, inputs: Vec<(String, String)>) {
        let Some((info, action)) = decode_args(args) else { return };
        let reply = inputs.into_iter().find(|(k, _)| k == REPLY_ACTION_ID).map(|(_, v)| v).filter(|_| action == REPLY_ACTION_ID);
        let base = NotificationResponse::new(&info.notification_id, &action, reply, info.approval_id.clone());
        if action != DEFAULT_ACTION_ID {
            self.lock().toasts.remove(&info.notification_id);
        }
        if !info.needs_authentication(&action) {
            self.forward(base);
            return;
        }
        let center = self.clone();
        let reason = auth_reason(&info.kind);
        let challenge = info.presence_challenge.clone();
        std::thread::spawn(move || {
            let answer = authenticate(base, challenge.as_deref(), reason);
            center.forward(answer);
        });
    }

    fn forward(&self, r: NotificationResponse) {
        self.log.info(format!(
            "notify: response action={} reply={} authenticated={} presence={}",
            log_action_class(&r.action_id),
            r.reply_text.is_some(),
            r.authenticated,
            r.presence.is_some()
        ));
        self.hub.publish(r);
    }

    /// Posts the toast. Fails `forbidden` when toasts are off for the helper.
    pub fn show(self: &Arc<Self>, plan: &NotificationPlan) -> Result<ShowOutcome, CapabilityError> {
        self.require_registered()?;
        let os = |e: windows::core::Error| CapabilityError::os("delivery_failed", "Windows refused the notification.", &e).retryable();
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID)).map_err(os)?;
        let setting = notifier.Setting().map_err(os)?;
        if setting != NotificationSetting::Enabled {
            return Err(CapabilityError::permission_missing(OsPermission::Notifications).with_detail("setting", setting_name(setting)));
        }
        let doc = XmlDocument::new().map_err(os)?;
        doc.LoadXml(&HSTRING::from(toast_xml(plan))).map_err(os)?;
        let toast = ToastNotification::CreateToastNotification(&doc).map_err(os)?;
        toast.SetTag(&HSTRING::from(plan.tag())).map_err(os)?;
        toast.SetGroup(&HSTRING::from(TOAST_GROUP)).map_err(os)?;
        match plan.interruption {
            Interruption::Passive => toast.SetSuppressPopup(true).map_err(os)?,
            Interruption::TimeSensitive => toast.SetPriority(ToastNotificationPriority::High).map_err(os)?,
            Interruption::Active => {}
        }
        let weak = Arc::downgrade(self);
        let (id, approval) = (plan.id.clone(), plan.approval_id.clone());
        toast
            .Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(move |_, args| {
                let user = args.as_ref().and_then(|a| a.Reason().ok()) == Some(ToastDismissalReason::UserCanceled);
                if user && let Some(center) = weak.upgrade() {
                    center.lock().toasts.remove(&id);
                    center.forward(NotificationResponse::new(&id, DISMISS_ACTION_ID, None, approval.clone()));
                }
                Ok(())
            }))
            .map_err(os)?;
        notifier.Show(&toast).map_err(os)?;
        self.lock().toasts.insert(plan.id.clone(), toast);
        self.log.info(format!(
            "notify: shown kind={} level={} quiet={}",
            plan.kind.as_str(),
            plan.interruption.as_str(),
            plan.quiet_hours_applied
        ));
        Ok(ShowOutcome { interruption: plan.interruption, authorization: "authorized" })
    }

    /// Removes a shown toast (from the screen and from the notification center).
    pub fn withdraw(&self, id: &str) -> Result<(), CapabilityError> {
        self.require_registered()?;
        self.lock().toasts.remove(id);
        let history = ToastNotificationManager::History().map_err(|e| CapabilityError::os("withdraw_failed", "Could not withdraw", &e))?;
        // A toast that is already gone is not an error (the mac helper ignores that too).
        let _ = history.RemoveGroupedTagWithId(&HSTRING::from(tag_for(id)), &HSTRING::from(TOAST_GROUP), &HSTRING::from(AUMID));
        Ok(())
    }
}

/// Shown in the Windows Hello dialog; generic so it never echoes notification content.
pub fn auth_reason(kind: &str) -> &'static str {
    match kind {
        "approval" => "Confirm your answer to a Psyche approval",
        "input_needed" => "Send your reply to Psyche",
        _ => "Confirm this Psyche action",
    }
}

/// Port of `NotificationCenterBridge.answer`: with a presence challenge, Hello and the signature
/// happen in one step (`authenticated` then means "signed"); without a usable key it falls back to
/// an owner check and reports `presenceError`, which the Gateway treats as no presence.
pub fn authenticate(mut answer: NotificationResponse, challenge: Option<&str>, reason: &str) -> NotificationResponse {
    let cancel = CancelToken::new();
    if let Some(c) = challenge {
        match crate::presence::sign_challenge(c, &cancel) {
            Ok(s) => {
                answer.presence = Some(super::plan::PresenceSignature { signature: s.signature, key_id: s.key_id });
                answer.authenticated = true;
                return answer;
            }
            Err(e) if e.code == ErrorCode::Cancelled || e.code == ErrorCode::Forbidden => {
                answer.authenticated = false;
                answer.auth_error = Some(e.reason);
                return answer;
            }
            Err(e) => answer.presence_error = Some(e.reason),
        }
    }
    match crate::presence::hello::verify_owner(reason, &cancel) {
        Ok(()) => {
            answer.authenticated = true;
            answer.auth_error = None;
        }
        Err(e) => {
            answer.authenticated = false;
            answer.auth_error = Some(crate::presence::hello::auth_error_reason(&e));
        }
    }
    answer
}

#[cfg(test)]
mod tests {
    #[test]
    fn clsid_is_braced_upper() {
        assert_eq!(super::clsid_string(), "{B1DFC43D-98FC-44C2-9C1B-F3C21D0871C6}");
    }
}
