import AppKit
import PsycheHelperCore
import PsycheProtocol

/// The thread-safe face of the overlay for the session controller, which runs on its own observer
/// thread: every call hops to the main queue, in order, and nothing here blocks.
final class PointsOverlayHost: @unchecked Sendable {
    /// Touched on the main queue only.
    nonisolated(unsafe) private var overlay: PointsOverlay?
    private let strings: PointsCardStrings
    private let appName: String
    private let pid: pid_t
    private let lock = NSLock()
    /// Set by close(): a begin() that arrives after it does nothing (no menu-bar item, no Esc monitor).
    private var closed = false
    private var onAction: (@Sendable (PointsCardAction) -> Void)?
    private var onStop: (@Sendable () -> Void)?

    init(strings: PointsCardStrings, appName: String, pid: pid_t) {
        self.strings = strings
        self.appName = appName
        self.pid = pid
    }

    /// The card's buttons and the stop paths (menu bar, Esc, card) call these.
    func bind(onAction: @escaping @Sendable (PointsCardAction) -> Void, onStop: @escaping @Sendable () -> Void) {
        lock.withLock {
            self.onAction = onAction
            self.onStop = onStop
        }
    }

    private func onMain(_ body: @escaping @MainActor @Sendable (PointsOverlay) -> Void) {
        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated {
                if let o = overlay { body(o) }
            }
        }
    }

    func begin() {
        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated {
                guard overlay == nil, !lock.withLock({ closed }) else { return }
                let o = PointsOverlay(strings: strings, appName: appName, pid: pid)
                o.onAction = { [weak self] a in
                    let f = self?.lock.withLock { self?.onAction }
                    f?(a)
                }
                o.onStop = { [weak self] in
                    let f = self?.lock.withLock { self?.onStop }
                    f?()
                }
                overlay = o
                o.begin()
            }
        }
    }

    func close() {
        lock.withLock { closed = true }
        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated {
                overlay?.close()
                overlay = nil
            }
        }
    }

    /// Main queue only (tests read it after draining the queue).
    var hasOverlay: Bool { overlay != nil }

    func show(_ step: PointsShownStep) { onMain { $0.show(step) } }
    func frames(_ frames: [String: CGRect], window: CGRect?) { onMain { $0.update(frames: frames, window: window) } }
    func setEngineVisible(_ v: Bool) { onMain { $0.setEngineVisible(v) } }
    func typing() { onMain { $0.typing() } }
}
