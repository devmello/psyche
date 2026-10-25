import AppKit
import EventKit
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `psyche-helper --probe-permission <reminders|calendars|automation:<bundle id>> <out.json> [--ask]`
/// (#570): runs inside the normal accessory app (NSApplication, main run loop), as when launched
/// with `open -g -j PsycheHelper.app --args …`, and writes what the helper sees: its bundle and
/// signature, the authorization status before, and with `--ask` the request's result, thread and
/// duration. For diagnosing prompts that never appear; launch it through LaunchServices, never from
/// a shell (a shell child is attributed to the terminal).
public enum PermissionProbe {
    @MainActor public static func run(kind: String, out: String, ask: Bool, log: HelperLog) {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        _Concurrency.Task { @MainActor in
            var o: [String: JSONValue] = [
                "kind": .string(kind), "bundle": BundleIdentity.json(), "pid": .int(Int(getpid())),
                "parentPid": .int(Int(getppid())), "activationPolicy": .int(app.activationPolicy().rawValue),
                "isActive": .bool(app.isActive), "at": .string(AppleDates.string(Date())),
            ]
            o["before"] = .string(status(kind))
            o["attribution"] = HostAttribution.current()?.json() ?? .null
            if ask {
                let started = Date()
                do {
                    o["result"] = .string(try await request(kind))
                } catch let e as CapabilityError {
                    o["error"] = ["reason": .string(e.reason), "message": .string(e.message), "details": .object(e.details)]
                } catch {
                    let ns = error as NSError
                    o["error"] = ["domain": .string(ns.domain), "code": .int(ns.code), "description": .string(ns.localizedDescription)]
                }
                o["elapsedMs"] = .int(Int(Date().timeIntervalSince(started) * 1000))
                o["after"] = .string(status(kind))
            }
            let data = Data(JSONValue.object(o).jsonString(pretty: true).utf8)
            FileManager.default.createFile(atPath: out, contents: data, attributes: [.posixPermissions: 0o600])
            log.info("permission probe kind=\(kind) before=\(o["before"]?.stringValue ?? "?") result=\(o["result"]?.stringValue ?? "-")")
            exit(0)
        }
        app.run()
    }

    static func status(_ kind: String) -> String {
        switch kind {
        case "reminders": EventKitStatus.name(EKEventStore.authorizationStatus(for: .reminder))
        case "calendars": EventKitStatus.name(EKEventStore.authorizationStatus(for: .event))
        default:
            if kind.hasPrefix("automation:") { AutomationPermission.state(bundleId: String(kind.dropFirst(11)), ask: false).rawValue } else { "unknown_kind" }
        }
    }

    /// The same path as `permissions.request`: the attribution check, then the request.
    @MainActor static func request(_ kind: String) async throws -> String {
        switch kind {
        case "reminders":
            try HostAttribution.check(.reminders)
            return try await EventKitRequest.run(.reminder)
        case "calendars":
            try HostAttribution.check(.calendars)
            return try await EventKitRequest.run(.event)
        default:
            guard kind.hasPrefix("automation:") else { return "unknown_kind" }
            try HostAttribution.check(.automation)
            return try await AutomationRequest.run(target: String(kind.dropFirst(11))).state.rawValue
        }
    }
}

/// `EKAuthorizationStatus` names as the helper reports them.
enum EventKitStatus {
    static func name(_ s: EKAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: "notDetermined"
        case .restricted: "restricted"
        case .denied: "denied"
        case .fullAccess: "fullAccess"
        case .writeOnly: "writeOnly"
        @unknown default: "unknown(\(s.rawValue))"
        }
    }
}
