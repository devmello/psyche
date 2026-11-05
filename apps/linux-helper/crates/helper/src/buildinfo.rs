//! What `psyche-helper --build-info` prints, and what the helper reports in `health`. The desktop
//! compares `build` with its own to decide whether a running helper is stale and must be
//! restarted (linux-desktop design §4.2), exactly as it does for the Mac helper.

use serde::Serialize;

use psyche_protocol::PROTOCOL_VERSION;

/// The `deviceFamily` the helper declares (the Gateway's `linux-helper` host-helper family).
pub const DEVICE_FAMILY: &str = "linux-helper";
/// The `platform` the helper declares.
pub const PLATFORM: &str = "linux";
/// Shown in Settings › Devices.
pub const DEVICE_NAME: &str = "Psyche (Linux Helper)";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BuildInfo {
    pub name: &'static str,
    pub version: &'static str,
    /// Opaque id, unique per built bundle: `PSYCHE_BUILD` at compile time, `"dev"` otherwise.
    pub build: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<&'static str>,
    pub platform: &'static str,
    pub arch: &'static str,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u64,
}

impl BuildInfo {
    pub fn current() -> Self {
        Self {
            name: "psyche-helper",
            version: env!("CARGO_PKG_VERSION"),
            build: match option_env!("PSYCHE_BUILD") {
                Some(build) if !build.is_empty() => build,
                _ => "dev",
            },
            commit: option_env!("PSYCHE_COMMIT").filter(|c| !c.is_empty()),
            platform: PLATFORM,
            arch: std::env::consts::ARCH,
            protocol_version: PROTOCOL_VERSION,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_fields_the_desktop_reads() {
        let v = serde_json::to_value(BuildInfo::current()).unwrap();
        assert_eq!(v["name"], "psyche-helper");
        assert_eq!(v["platform"], "linux");
        assert_eq!(v["protocolVersion"], 1);
        assert!(v["build"].as_str().is_some_and(|b| !b.is_empty()));
        assert!(v["version"].as_str().is_some_and(|b| !b.is_empty()));
    }
}
