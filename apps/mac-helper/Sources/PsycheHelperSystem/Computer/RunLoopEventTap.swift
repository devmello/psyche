import ApplicationServices
import CoreGraphics
import Foundation
import PsycheHelperCore

/// One CGEvent tap on its own run-loop thread, removable and event driven: the thread blocks in
/// `CFRunLoopRun` and is stopped by `remove()` (no polling slices), then invalidates the port and
/// frees its context on that same thread, so no callback can be in flight when it goes away.
/// Needs Accessibility; `init` returns nil without it.
final class RunLoopEventTap: @unchecked Sendable, SessionTapHandle, KeyDownGate {
    typealias Handler = @Sendable (CGEventType, CGEvent) -> Unmanaged<CGEvent>?

    private final class Context: @unchecked Sendable {
        let handler: Handler
        let lock = NSLock()
        var port: CFMachPort?
        var wantEnabled: Bool
        init(handler: @escaping Handler, wantEnabled: Bool) {
            self.handler = handler
            self.wantEnabled = wantEnabled
        }
    }

    private let context: Context
    private let lock = NSLock()
    private var loop: CFRunLoop?
    private var removed = false

    /// Why a tap could not be installed.
    enum InstallFailure: Error, Equatable {
        case notTrusted  // no Accessibility
        case createFailed  // trusted, but the system refused to create the tap
        case timeout  // created, but the run-loop thread was not ready in time
    }

    convenience init?(
        place: CGEventTapPlacement, options: CGEventTapOptions, types: [CGEventType], qos: QualityOfService, name: String,
        startEnabled: Bool = true, handler: @escaping Handler
    ) {
        do {
            try self.init(throwing: place, options: options, types: types, qos: qos, name: name, startEnabled: startEnabled, handler: handler)
        } catch {
            return nil
        }
    }

    /// Like `init?`, with the reason a tap could not be installed.
    static func create(
        place: CGEventTapPlacement, options: CGEventTapOptions, types: [CGEventType], qos: QualityOfService, name: String,
        startEnabled: Bool = true, handler: @escaping Handler
    ) -> Result<RunLoopEventTap, InstallFailure> {
        do {
            return .success(try RunLoopEventTap(throwing: place, options: options, types: types, qos: qos, name: name, startEnabled: startEnabled, handler: handler))
        } catch {
            return .failure((error as? InstallFailure) ?? .createFailed)
        }
    }

    private init(
        throwing place: CGEventTapPlacement, options: CGEventTapOptions, types: [CGEventType], qos: QualityOfService, name: String,
        startEnabled: Bool, handler: @escaping Handler
    ) throws {
        guard AXIsProcessTrusted() else { throw InstallFailure.notTrusted }
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let context = Context(handler: handler, wantEnabled: startEnabled)
        let refcon = Unmanaged.passRetained(context)  // released by the run-loop thread when it ends
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: place, options: options, eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let ctx = Unmanaged<Context>.fromOpaque(refcon).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    ctx.lock.lock()
                    let port = ctx.wantEnabled ? ctx.port : nil
                    ctx.lock.unlock()
                    if let port { CGEvent.tapEnable(tap: port, enable: true) }
                    return Unmanaged.passUnretained(event)
                }
                return ctx.handler(type, event)
            }, userInfo: refcon.toOpaque()
        ) else {
            refcon.release()
            throw InstallFailure.createFailed
        }
        context.port = port
        self.context = context
        let box = UncheckedSendable(port)
        let ready = DispatchSemaphore(value: 0)
        let t = Thread { [self, box] in
            let port = box.value
            let rl = CFRunLoopGetCurrent()!
            let src = CFMachPortCreateRunLoopSource(nil, port, 0)
            CFRunLoopAddSource(rl, src, .commonModes)
            let skip: Bool = lock.withLock {
                loop = rl
                return removed
            }
            if !skip {
                CGEvent.tapEnable(tap: port, enable: startEnabled)
                ready.signal()
                CFRunLoopRun()
            } else {
                ready.signal()
            }
            CGEvent.tapEnable(tap: port, enable: false)
            CFRunLoopRemoveSource(rl, src, .commonModes)
            CFMachPortInvalidate(port)
            context.lock.withLock { context.port = nil }
            refcon.release()
        }
        t.name = name
        t.qualityOfService = qos
        t.start()
        if ready.wait(timeout: .now() + 5) != .success {
            remove()
            throw InstallFailure.timeout
        }
    }

    /// Stops the thread and removes the tap. Idempotent, non-blocking, safe from the tap's own callback.
    func remove() {
        let rl: CFRunLoop? = lock.withLock {
            guard !removed else { return nil }
            removed = true
            return loop
        }
        guard let rl else { return }
        CFRunLoopPerformBlock(rl, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(rl) }
        CFRunLoopWakeUp(rl)
    }

    /// Enables or disables delivery without tearing the tap down. A disabled tap sees no events.
    func setEnabled(_ on: Bool) {
        let port: CFMachPort? = context.lock.withLock {
            context.wantEnabled = on
            return context.port
        }
        if let port, !lock.withLock({ removed }) { CGEvent.tapEnable(tap: port, enable: on) }
    }
}
