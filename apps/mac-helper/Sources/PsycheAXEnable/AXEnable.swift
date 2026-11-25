import ApplicationServices

/// The only `AXUIElementSetAttributeValue` call in the Points graph (docs/design/psyche-points-2026.md
/// §4.3): a constant attribute name and a constant value, on an application element. It wakes
/// Chromium's accessibility tree and changes nothing the owner can see. The boundary check
/// (`scripts/check-points-boundary.sh`) requires this file to keep exactly one such call.
public func enableManualAccessibility(pid: pid_t) {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
}
