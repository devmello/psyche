import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError

// The phone as a node for one capability, `location.current` (docs/design/mobile-companion-2026.md §4, M3).
//
// What it is, and what it is not:
// - Off until the owner switches "Share location with Psyche" on in Settings. Only then does iOS ask for
//   When-In-Use permission, and only then does the phone tell the Gateway it offers the capability
//   (`phone.capabilities.set`). Switching it off withdraws the capability at once.
// - Foreground only. There is no "Always" permission, no background location mode, no significant-change
//   monitoring and no stream: one fix per request, and only while Psyche is open. When it is not, the answer is
//   a plain error the agent can relay ("The phone isn't sharing location right now").
// - Nothing is stored here: no trail, no cache of the last fix.
// - The place name comes from Apple's own geocoder on this phone. The location goes to the Gateway the phone is
//   paired with, over the connection it already has, and nowhere else.

/// Where iOS stands on location for this app. Never "always": this app only ever asks for When-In-Use.
public enum LocationAuthorization: Sendable, Equatable {
    case notDetermined
    case denied
    case authorized
}

/// One reading of the phone's position.
public struct LocationFix: Sendable, Equatable {
    public var latitude: Double
    public var longitude: Double
    /// Horizontal accuracy in metres; a negative value means the system could not say.
    public var accuracyMeters: Double
    public var timestamp: Date

    public init(latitude: Double, longitude: Double, accuracyMeters: Double, timestamp: Date) {
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
        self.timestamp = timestamp
    }
}

public enum LocationFailure: Error, Sendable, Equatable {
    /// The system could not produce a fix (no signal, the request failed).
    case unavailable
    case timedOut
}

/// CoreLocation behind a seam, so tests drive a fake and never touch the real permission or a real fix.
public protocol LocationProviding: Sendable {
    /// What iOS says now. Reading it never prompts.
    func authorization() async -> LocationAuthorization
    /// Shows the iOS When-In-Use prompt, and only when the answer is still undetermined. Returns the outcome.
    func requestWhenInUseAuthorization() async -> LocationAuthorization
    /// One fix. Honours cancellation.
    func currentFix() async throws -> LocationFix
    /// A short place name for the fix (Apple's geocoder on this phone), or nil when there is none or it is slow.
    func placeName(for fix: LocationFix) async -> String?
}

/// Whether Psyche is on screen, written by the scene-phase handler and read when the Gateway asks for a fix.
public final class ForegroundState: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    public init() {}
    public var isActive: Bool { lock.withLock { value } }
    public func set(_ active: Bool) { lock.withLock { value = active } }
}

/// The `location.current` node: the owner's toggle, what the phone declares, and what it answers.
public actor PhoneLocationNode {
    public static let capability = "location.current"
    /// How long one fix may take before the phone says so (a cold start can take several seconds).
    public static let fixTimeout: Duration = .seconds(15)

    public typealias Declare = @Sendable ([String]) async throws -> Void
    public typealias Deliver = @Sendable (_ invocationId: String, _ result: JSONValue) async -> Void

    private let provider: any LocationProviding
    private let foreground: ForegroundState
    private let timeout: Duration
    /// The owner's switch. Off at launch until the stored preference is restored.
    private var wanted = false
    private var restored = false
    private var declare: Declare?

    public init(provider: any LocationProviding, foreground: ForegroundState, timeout: Duration = PhoneLocationNode.fixTimeout) {
        self.provider = provider
        self.foreground = foreground
        self.timeout = timeout
    }

    // MARK: - The toggle and the declaration

    /// The stored preference, applied once (at launch or the first connect); after that the switch itself is the
    /// source of truth. Does not prompt.
    public func restore(wanted: Bool) {
        guard !restored else { return }
        restored = true
        self.wanted = wanted
    }

    /// Whether the switch is on and iOS still allows it. Reading never prompts.
    public func isSharing() async -> Bool {
        guard wanted else { return false }
        return await provider.authorization() == .authorized
    }

    /// The owner flipped the switch. Turning on asks iOS for When-In-Use permission (only if it was never asked);
    /// a refusal leaves sharing off. Either way what the Gateway has is brought in line at once.
    public func setSharing(_ on: Bool) async -> LocationSharingOutcome {
        restored = true
        if on {
            var status = await provider.authorization()
            if status == .notDetermined { status = await provider.requestWhenInUseAuthorization() }
            wanted = status == .authorized
        } else {
            wanted = false
        }
        await sync()
        if wanted { return .enabled }
        return on ? .permissionDenied : .disabled
    }

    /// A connection came up: remember how to declare on it, and declare what is on.
    public func connected(declare: @escaping Declare) async {
        self.declare = declare
        await sync()
    }

    /// The connection is gone (the Gateway drops what the phone offered when it closes).
    public func disconnected() { declare = nil }

    /// This phone was removed or re-paired: nothing stays on.
    public func reset() {
        wanted = false
        restored = false
        declare = nil
    }

    /// What the phone offers now.
    func declaredCapabilities() async -> [String] {
        await isSharing() ? [Self.capability] : []
    }

    private func sync() async {
        guard let declare else { return }
        // A failed declaration (the Gateway is gone, the phone lacks the scope) is retried at the next connect.
        try? await declare(await declaredCapabilities())
    }

    // MARK: - Answering the Gateway

    /// A `node.invoke` from the Gateway. Answers `accepted` (or an error) at once; the fix is taken in the
    /// background and handed to `deliver` as the `node.result` params.
    public func accept(params: JSONValue?, deliver: @escaping Deliver) -> Result<JSONValue, WireError> {
        guard let invocationId = params?["invocationId"]?.stringValue, !invocationId.isEmpty else {
            return .failure(WireError(code: "invalid_params", message: "node.invoke needs an invocationId"))
        }
        guard params?["capability"]?.stringValue == Self.capability else {
            return .failure(WireError(code: "not_found", message: "The phone does not offer that capability"))
        }
        Task { [self] in
            await deliver(invocationId, await answer(invocationId: invocationId))
        }
        return .success(.object(["accepted": .bool(true)]))
    }

    private static let notSharing = "The phone isn't sharing location right now"

    private func failure(_ invocationId: String, _ code: String, _ message: String) -> JSONValue {
        .object([
            "invocationId": .string(invocationId), "ok": .bool(false),
            "error": .object(["code": .string(code), "message": .string(message)]),
        ])
    }

    func answer(invocationId: String) async -> JSONValue {
        guard wanted else {
            return failure(invocationId, "forbidden", "\(Self.notSharing): location sharing is switched off in Psyche on the phone.")
        }
        guard await provider.authorization() == .authorized else {
            return failure(
                invocationId, "forbidden",
                "\(Self.notSharing): Psyche doesn't have location permission on the phone (iOS Settings, Privacy, Location Services).")
        }
        // Foreground only: the phone never takes a fix while Psyche is not on screen.
        guard foreground.isActive else {
            return failure(invocationId, "unavailable", "\(Self.notSharing): Psyche isn't open on the phone.")
        }
        let fix: LocationFix
        do {
            fix = try await takeFix()
        } catch LocationFailure.timedOut {
            return failure(invocationId, "timeout", "The phone couldn't get a location fix in time.")
        } catch {
            return failure(invocationId, "unavailable", "The phone couldn't get a location fix.")
        }
        guard fix.accuracyMeters >= 0, abs(fix.latitude) <= 90, abs(fix.longitude) <= 180 else {
            return failure(invocationId, "unavailable", "The phone couldn't get a location fix.")
        }
        let name = await provider.placeName(for: fix)
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var result: [String: JSONValue] = [
            "latitude": .number(fix.latitude), "longitude": .number(fix.longitude),
            "accuracyMeters": .number(fix.accuracyMeters), "timestamp": .string(stamp.string(from: fix.timestamp)),
        ]
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            result["placeName"] = .string(String(name.prefix(200)))
        }
        return .object(["invocationId": .string(invocationId), "ok": .bool(true), "result": .object(result)])
    }

    private func takeFix() async throws -> LocationFix {
        let provider = provider
        let timeout = timeout
        return try await withThrowingTaskGroup(of: LocationFix.self) { group in
            group.addTask { try await provider.currentFix() }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw LocationFailure.timedOut
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw LocationFailure.unavailable }
            return first
        }
    }
}
