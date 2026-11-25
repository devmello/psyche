import Foundation
import PsycheProtocol

/// Which apps Points refuses (docs/design/psyche-points-2026.md §2.2). The Gateway refuses the same
/// ones at start; the helper checks again, because the helper is what reads the window.
public enum PointsPolicy {
    /// The refusal for a window of `bundleId`, or nil when it may be pointed at. Order: an app no
    /// setting can unlock (Psyche, security prompts, password managers, authenticators, wallets:
    /// `AppTeachPolicy.neverRecorded`), an app whose fixed cap is Off (banking, trading, crypto),
    /// a terminal or IDE, then the owner's own Off in Settings → Computer use. Browsers are allowed:
    /// a fixed cap of Read is enough, since Points only reads, and no computer-use tier is needed.
    public static func refusal(bundleId: String, settings: TierSettings) -> PointsRefusal? {
        if AppTeachPolicy.neverRecorded(bundleId) != nil { return .neverApp }
        if FixedCaps.cap(for: bundleId) == .off { return .fixedOff }
        if FixedCaps.category(of: bundleId) == .terminalOrIDE { return .terminalOrIDE }
        if settings.value(for: bundleId) == .off { return .ownerOff }
        return nil
    }
}

/// Whether a Points session runs. Computer use reads it (`ComputerUse.isPointing`) and refuses its
/// actions while it is set, so no agent can act on the form while the owner fills it (§4.3 item 4).
/// A tiny lock-guarded counter in Core: `PsycheHelperSystem` can read it without ever linking the
/// Points target, and the Points target sets it without a way to reach computer use.
public final class PointsActivity: @unchecked Sendable {
    public static let shared = PointsActivity()

    private let lock = NSLock()
    private var holder: String?

    public init() {}

    public var isActive: Bool { lock.withLock { holder != nil } }

    /// Takes the one session slot; false if another session holds it.
    public func begin(_ id: String) -> Bool {
        lock.withLock {
            guard holder == nil else { return false }
            holder = id
            return true
        }
    }

    /// Frees the slot if `id` holds it. Returns whether it did.
    @discardableResult
    public func end(_ id: String) -> Bool {
        lock.withLock {
            guard holder == id else { return false }
            holder = nil
            return true
        }
    }

    public var activeId: String? { lock.withLock { holder } }
}
