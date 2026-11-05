//! `health` (as `apps/node`'s health provider): version, platform, uptime and the state of the
//! pieces other capabilities depend on. No side effects, never prompts, content-free.

use serde_json::json;

use crate::node::capability::{CapabilityOutput, CapabilitySpec, SideEffect};
use crate::node::registry::HELPER_VERSION;
use crate::node::{CapabilityRegistry, schema};
use crate::win::registry::{Hive, read_string};

fn os_build() -> Option<String> {
    let key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let build = read_string(Hive::LocalMachine, key, "CurrentBuild")?;
    let ubr = crate::win::registry::read_dword(Hive::LocalMachine, key, "UBR");
    Some(match ubr {
        Some(u) => format!("10.0.{build}.{u}"),
        None => format!("10.0.{build}"),
    })
}

pub fn register(reg: &mut CapabilityRegistry) {
    let rt = reg.runtime().clone();
    let capabilities = reg.len();
    reg.add_blocking(
        CapabilitySpec::new("health", "Helper version, uptime, OS build and the state of notifications, Windows Hello, the keychain and Outlook.", SideEffect::None)
            .input(schema::empty()),
        move |_| {
            let toast = rt.existing_service::<std::sync::Arc<crate::notify::toast::ToastCenter>>();
            Ok(CapabilityOutput::new(json!({
                "version": HELPER_VERSION,
                "platform": "windows",
                "deviceFamily": crate::node::handshake::DEVICE_FAMILY,
                "arch": std::env::consts::ARCH,
                "os": os_build(),
                "pid": std::process::id(),
                "uptimeS": rt.started.elapsed().as_secs(),
                "capabilities": capabilities + 1,
                "providers": {
                    "notify": {
                        "registered": toast.as_ref().is_some_and(|t| t.is_registered()),
                        "pendingResponses": toast.as_ref().map_or(0, |t| t.hub.pending_count()),
                        "setting": crate::notify::toast::current_setting().map(crate::notify::toast::setting_name),
                    },
                    "presence": { "helloSupported": crate::presence::hello::is_supported() },
                    // Mail, calendar, contacts and tasks: classic Outlook, or why not.
                    "outlook": crate::outlook::status_json(&rt),
                    "elevated": crate::win::security::is_elevated(),
                },
            })))
        },
    );
}
