import ApplicationServices
import CoreGraphics
import Foundation
import PsycheHelperCore

/// Owner input recency for pause-when-unwatched (#272): a listen-only session tap records the
/// last keyboard, mouse or trackpad event that did not come from the helper (`Input.marker`).
/// The tap exists only while a computer-use session runs (`SessionTaps`): mouse moves and scrolls
/// are the busiest events on the Mac, and the helper cannot tell its own input from the owner's in
/// the system's idle clock, so a tap during sessions is the only source that is correct. Between
/// sessions the record keeps its last value; each install re-seeds it from the idle clock when that
/// input is clearly not the helper's own. With nothing on record, sensitive apps wait (fail closed).
public final class AttentionMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private var last: Date?

    public init() {}

    public var lastOwnerInput: Date? {
        lock.lock()
        defer { lock.unlock() }
        return last
    }

    public func noteOwnerInput(at date: Date = Date()) {
        lock.lock()
        if last.map({ date > $0 }) ?? true { last = date }
        lock.unlock()
    }

    /// Installs the tap; nil without Accessibility. Remove it with the handle.
    func install() -> (any SessionTapHandle)? {
        // Input before the tap existed: the system's idle time, read before the helper posts anything.
        let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
        let now = Date()
        let seed = AttentionSeed.ownerInput(now: now, idle: idle, lastHelperPost: Input.lastPost.value)
        let tap = RunLoopEventTap(
            place: .tailAppendEventTap, options: .listenOnly,
            types: [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .leftMouseDragged, .scrollWheel],
            qos: .utility, name: "com.psyche.helper.attention-tap"
        ) { [weak self] _, event in
            if event.getIntegerValueField(.eventSourceUserData) != Input.marker { self?.noteOwnerInput() }
            return Unmanaged.passUnretained(event)
        }
        if tap != nil, let seed { noteOwnerInput(at: seed) }
        return tap
    }
}
