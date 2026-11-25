import Foundation
import PsycheProtocol

/// The one-shot permission to look (§5.3, `points.look`): the helper mints an `actionId` when the owner
/// presses Let Psyche look (or Next while vision mode is on) and puts it on the `action` event. A look is
/// answered only for the latest id, once: the Gateway cannot capture on its own, and a replayed or old id
/// is refused. A newer id replaces the older one; an id also lapses after `ttl` seconds.
public final class PointsActionTokens: @unchecked Sendable {
    public enum Outcome: Equatable, Sendable { case ok, unknown, used, stale }

    public static let ttl: Double = 300
    private struct Current {
        var id: String
        var issuedAt: Double
    }
    private let lock = NSLock()
    private let clock: @Sendable () -> Double
    private let makeId: @Sendable () -> String
    private var current: Current?
    private var spent: [String] = []

    public init(
        clock: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime },
        makeId: @escaping @Sendable () -> String = { "act-" + UUID().uuidString.lowercased() }
    ) {
        self.clock = clock
        self.makeId = makeId
    }

    public func issue() -> String {
        lock.withLock {
            if let c = current { remember(c.id) }
            let id = makeId()
            current = Current(id: id, issuedAt: clock())
            return id
        }
    }

    /// Spends `id`. It is gone after this call whatever becomes of the rest of the look.
    public func consume(_ id: String) -> Outcome {
        lock.withLock {
            if let c = current, c.id == id {
                current = nil
                remember(id)
                return clock() - c.issuedAt <= Self.ttl ? .ok : .stale
            }
            return spent.contains(id) ? .used : .unknown
        }
    }

    private func remember(_ id: String) {
        spent.append(id)
        if spent.count > 64 { spent.removeFirst(spent.count - 64) }
    }
}

/// The checks `points.look` makes before any pixel is taken, in this order: the id, Secure Event Input,
/// the §2.2 refusals. Inputs are injected, so tests need no real keyboard state, settings file or TCC.
public enum PointsLookGate {
    public static func check(
        actionId: String, tokens: PointsActionTokens, secureInput: () -> Bool, bundleId: String, settings: TierSettings
    ) throws {
        switch tokens.consume(actionId) {
        case .ok: break
        case .unknown:
            throw CapabilityError(.forbidden, reason: "action_unknown", "A look needs the id of the owner's latest Let Psyche look click")
        case .used:
            throw CapabilityError(.forbidden, reason: "action_used", "That look was already taken; the owner has to ask again")
        case .stale:
            throw CapabilityError(.forbidden, reason: "action_stale", "That look request is too old; the owner has to ask again")
        }
        try checkNow(secureInput: secureInput, bundleId: bundleId, settings: settings)
    }

    /// The part repeated after the capture: nothing is returned if the keyboard went secure meanwhile.
    public static func checkNow(secureInput: () -> Bool, bundleId: String, settings: TierSettings) throws {
        if secureInput() {
            throw CapabilityError(.policyDenied, reason: "secure_input", "A password field has focus; no picture is taken until it loses focus")
        }
        if let refusal = PointsPolicy.refusal(bundleId: bundleId, settings: settings) {
            throw CapabilityError(
                .forbidden, reason: "points_refused", "Psyche points does not look at this app", details: ["refusal": .string(refusal.rawValue)])
        }
    }
}
