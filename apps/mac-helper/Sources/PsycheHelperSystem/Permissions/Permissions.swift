import AppKit
import ApplicationServices
import AVFoundation
import Contacts
import CoreGraphics
import EventKit
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Speech
import UserNotifications

/// Permission state from per-API preflight calls only (security §12: never `TCC.db`).
public struct LivePreflight: PermissionPreflight {
    public enum State: String, Sendable { case granted, denied, notDetermined, restricted, unknown }

    public init() {}

    public func isGranted(_ permission: TCCPermission) -> Bool {
        switch permission {
        // Per target / async: checked by the capabilities themselves.
        case .automation, .notifications: return true
        default: return state(permission) == .granted
        }
    }

    public func state(_ permission: TCCPermission) -> State {
        switch permission {
        case .accessibility:
            return AXIsProcessTrusted() ? .granted : .notDetermined
        case .screenRecording:
            return CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
        case .inputMonitoring:
            return CGPreflightListenEventAccess() ? .granted : .notDetermined
        case .microphone:
            return Self.map(AVCaptureDevice.authorizationStatus(for: .audio))
        case .speechRecognition:
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: return .granted
            case .denied: return .denied
            case .restricted: return .restricted
            case .notDetermined: return .notDetermined
            @unknown default: return .unknown
            }
        case .calendars:
            return Self.map(EKEventStore.authorizationStatus(for: .event))
        case .reminders:
            return Self.map(EKEventStore.authorizationStatus(for: .reminder))
        case .contacts:
            switch CNContactStore.authorizationStatus(for: .contacts) {
            case .authorized, .limited: return .granted
            case .denied: return .denied
            case .restricted: return .restricted
            case .notDetermined: return .notDetermined
            @unknown default: return .unknown
            }
        case .fullDiskAccess:
            // A read probe of a file only Full Disk Access unlocks. It never prompts.
            let path = NSHomeDirectory() + "/Library/Messages/chat.db"
            guard FileManager.default.fileExists(atPath: path) else { return .unknown }
            let fd = Darwin.open(path, O_RDONLY)
            if fd >= 0 {
                Darwin.close(fd)
                return .granted
            }
            return .notDetermined
        case .automation, .notifications:
            return .unknown
        }
    }

    static func map(_ s: AVAuthorizationStatus) -> State {
        switch s {
        case .authorized: .granted
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .unknown
        }
    }

    static func map(_ s: EKAuthorizationStatus) -> State {
        switch s {
        case .fullAccess: .granted
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined, .writeOnly: .notDetermined
        @unknown default: .unknown
        }
    }
}

/// `permissions.*` (feature A9).
public enum PermissionsCapabilities {
    public static func make(preflight: LivePreflight = LivePreflight()) -> [any CapabilityHandler] {
        [status(preflight), request(preflight), openSettings()]
    }

    static func entryJSON(_ p: TCCPermission, state: String) -> JSONValue {
        let e = PermissionCatalog.entry(p)
        return [
            "permission": .string(p.rawValue), "status": .string(state), "title": .string(e.title),
            "explanation": .string(e.explanation), "whenRequested": .string(e.whenRequested),
            "settingsURL": .string(e.settingsURL), "requestStyle": .string(e.style.rawValue),
        ]
    }

    static func status(_ preflight: LivePreflight) -> Capability {
        Capability(CapabilitySpec(
            name: "permissions.status",
            description: "Status of every macOS permission the helper uses (preflight APIs only), with explanations, System Settings links and the next one to ask for.",
            sideEffect: .read,
            inputSchema: Schema.object([
                "automationTargets": Schema.array(Schema.string(), description: "Bundle ids to report Automation status for", maxItems: 20),
                "wanted": Schema.array(Schema.string(enum: TCCPermission.allCases.map(\.rawValue)), description: "Features the user turned on"),
            ])
        )) { ctx in
            struct P: Decodable {
                var automationTargets: [String]?
                var wanted: [TCCPermission]?
            }
            let p = try ctx.decode(P.self)
            var granted: Set<TCCPermission> = []
            var rows: [JSONValue] = []
            for perm in PermissionCatalog.order {
                var state = preflight.state(perm).rawValue
                if perm == .notifications { state = await NotificationAuthorization.state() }
                if perm == .automation { state = "perTarget" }
                if state == "granted" { granted.insert(perm) }
                rows.append(entryJSON(perm, state: state))
            }
            let targets = (p.automationTargets ?? []).prefix(20)
            var automation: [String: JSONValue] = [:]
            for t in targets { automation[t] = .string(AutomationPermission.state(bundleId: t, ask: false).rawValue) }
            let wanted = Set(p.wanted ?? [.accessibility, .notifications])
            let next = PermissionCatalog.next(granted: granted.union([.automation]), wanted: wanted)
            return CapabilityOutput([
                "permissions": .array(rows), "automation": .object(automation),
                "next": next.map { .string($0.rawValue) } ?? .null,
                "bundled": .bool(Bundle.main.bundleIdentifier == "com.psyche.helper"),
                "bundle": BundleIdentity.json(),
                "attribution": HostAttribution.current()?.json() ?? .null,
                "disclaimSupported": .bool(DisclaimedProcess.isSupported),
            ])
        }
    }

    struct RequestParams: Decodable {
        var permission: TCCPermission
        var purpose: String?
        var target: String?
    }

    static func request(_ preflight: LivePreflight) -> Capability {
        Capability(CapabilitySpec(
            name: "permissions.request",
            description: "Ask macOS for one permission (shows the system prompt or opens System Settings). Screen Recording needs purpose \"vision_fallback\"; Automation launches a target that is not running (hidden) and asks for it (granted, denied, notDetermined, unknown); Full Disk Access can only be granted in System Settings.",
            sideEffect: .write,
            inputSchema: Schema.object([
                "permission": Schema.string(enum: TCCPermission.allCases.map(\.rawValue)),
                "purpose": Schema.string("vision_fallback (Screen Recording only)"),
                "target": Schema.string("Bundle id (Automation only)"),
            ], required: ["permission"]),
            receiptKind: "permission_request"
        )) { ctx in
            let p = try ctx.decode(RequestParams.self)
            // Nested in Psyche.app, tccd asks on that app's behalf: refuse with the reason rather
            // than let macOS deny silently (#570).
            try HostAttribution.check(p.permission)
            let state: String
            var openedSettings = false
            var launched = false
            switch p.permission {
            case .accessibility:
                let opts = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
                state = AXIsProcessTrustedWithOptions(opts) ? "granted" : "prompted"
            case .screenRecording:
                // Requested only for the vision fallback, never up front (security §12).
                guard p.purpose == "vision_fallback" else {
                    throw CapabilityError.invalidParams("Screen Recording is requested only with purpose \"vision_fallback\"", field: "purpose")
                }
                state = CGRequestScreenCaptureAccess() ? "granted" : "prompted"
            case .inputMonitoring:
                state = CGRequestListenEventAccess() ? "granted" : "prompted"
            case .automation:
                guard let t = p.target, !t.isEmpty, t.count <= 255, !t.contains("/") else {
                    throw CapabilityError.invalidParams("target (a bundle id) is required for Automation", field: "target")
                }
                let r = try await AutomationRequest.run(target: t)
                state = r.state.rawValue
                launched = r.launched
            case .fullDiskAccess:
                openedSettings = await open(PermissionCatalog.entry(.fullDiskAccess).settingsURL)
                state = preflight.state(.fullDiskAccess).rawValue
            case .microphone:
                state = await AVCaptureDevice.requestAccess(for: .audio) ? "granted" : "denied"
            case .speechRecognition:
                state = await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
                    SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0 == .authorized ? "granted" : "denied") }
                }
            case .calendars:
                state = try await EventKitRequest.run(.event)
            case .reminders:
                state = try await EventKitRequest.run(.reminder)
            case .contacts:
                state = try await CNContactStore().requestAccess(for: .contacts) ? "granted" : "denied"
            case .notifications:
                throw CapabilityError.invalidParams("Use notify.request_authorization (provisional first)", field: "permission")
            }
            return CapabilityOutput(
                ["permission": .string(p.permission.rawValue), "status": .string(state), "openedSettings": .bool(openedSettings), "launched": .bool(launched)],
                receipt: ReceiptDraft(outcome: .ok, summary: "Requested \(p.permission.rawValue): \(state)")
            )
        }
    }

    static func openSettings() -> Capability {
        Capability(CapabilitySpec(
            name: "permissions.open_settings", description: "Open System Settings at the pane for one permission.",
            sideEffect: .none,
            inputSchema: Schema.object(["permission": Schema.string(enum: TCCPermission.allCases.map(\.rawValue))], required: ["permission"])
        )) { ctx in
            struct P: Decodable { var permission: TCCPermission }
            let p = try ctx.decode(P.self)
            let ok = await open(PermissionCatalog.entry(p.permission).settingsURL)
            return CapabilityOutput(["opened": .bool(ok)])
        }
    }

    @MainActor
    static func open(_ url: String) -> Bool {
        guard let u = URL(string: url) else { return false }
        return NSWorkspace.shared.open(u)
    }
}

/// Notification authorization without touching UNUserNotificationCenter in unbundled builds.
enum NotificationAuthorization {
    static func state() async -> String {
        guard Bundle.main.bundleIdentifier != nil else { return "unknown" }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch NotificationCenterBridge.statusName(settings.authorizationStatus) {
        case "authorized", "provisional": return "granted"
        case let other: return other
        }
    }
}

/// Automation for one target app (#549): Apple Events can only ask a running app, so a target
/// that is not running is launched hidden (as the Mail / Notes adapters do) and asked again.
enum AutomationRequest {
    static func run(
        target: String,
        ask: @escaping @Sendable (String) -> AutomationPermission.State = { AutomationPermission.state(bundleId: $0, ask: true) },
        launch: @escaping @Sendable (String) async throws -> Void = { try await ScriptHandler.ensureRunning($0) }
    ) async throws -> (state: AutomationPermission.State, launched: Bool) {
        // AEDeterminePermissionToAutomateTarget blocks while the prompt is up: off the main thread.
        func asked() async -> AutomationPermission.State {
            await withCheckedContinuation { (cont: CheckedContinuation<AutomationPermission.State, Never>) in
                DispatchQueue.global(qos: .userInitiated).async { cont.resume(returning: ask(target)) }
            }
        }
        let first = await asked()
        guard first == .notRunning else { return (first, false) }
        try await launch(target)
        return (await asked(), true)
    }
}

/// EventKit full-access requests (#570): on the main actor, with the run loop alive, and a denial
/// that comes back while the status is still `notDetermined` (macOS answered without a prompt)
/// becomes `prompt_refused_by_macos` instead of a plain "denied".
enum EventKitRequest {
    /// Faster than anyone can read and answer a prompt: tccd refused it (#570 measured milliseconds).
    static let refusedWithin: TimeInterval = 1.0

    @MainActor static func run(_ type: EKEntityType, store: EKEventStore = EKEventStore()) async throws -> String {
        let started = Date()
        let granted = type == .event ? try await store.requestFullAccessToEvents() : try await store.requestFullAccessToReminders()
        if granted { return "granted" }
        // The in-process status can lag a real answer, so only a near-instant denial counts.
        if Self.looksRefused(elapsed: Date().timeIntervalSince(started), statusAfter: EKEventStore.authorizationStatus(for: type)) {
            let p: TCCPermission = type == .event ? .calendars : .reminders
            throw CapabilityError(.forbidden, reason: "prompt_refused_by_macos",
                                  "macOS answered the \(p.rawValue) request without showing a prompt. The Console log of tccd says why (\"Refusing authorization request\").",
                                  details: ["permission": .string(p.rawValue)])
        }
        return "denied"
    }

    static func looksRefused(elapsed: TimeInterval, statusAfter: EKAuthorizationStatus) -> Bool {
        elapsed < refusedWithin && statusAfter == .notDetermined
    }
}
