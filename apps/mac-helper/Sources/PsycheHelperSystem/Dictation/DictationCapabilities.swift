import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// The `dictation.*` capability group (features J9, Q2). The Gateway forwards its `dictation.*`
/// methods here for desktop callers only; `nodes.invoke` and agent tools cannot reach them, because
/// inserted text is the owner's keystrokes, not an agent action.
public enum DictationCapabilities {
    public static func make(backend: any DictationBackend = LiveDictationBackend(), watcher: DictationKeyWatcher = DictationKeyWatcher()) -> [any CapabilityHandler] {
        [
            Capability(CapabilitySpec(
                name: "dictation.target",
                description: "Desktop dictation only: the focused app and element and whether dictated text can go there (never the field's contents).",
                sideEffect: .read,
                permissions: [.accessibility]
            )) { _ in
                let target = try await DictationQueue.run {
                    DictationPolicy.target(backend.focus(), secureInput: backend.secureInputActive())
                }
                return CapabilityOutput(["target": target?.wire ?? .null])
            },

            Capability(CapabilitySpec(
                name: "dictation.insert",
                description: "Desktop dictation only: insert text into the focused element via AX (selected text, then value), else unicode CGEvent typing. Refuses secure fields and Psyche's windows; control characters become spaces, so it never presses Return.",
                sideEffect: .write,
                inputSchema: Schema.object([
                    "text": Schema.string("Dictated text", maxLength: DictationPolicy.maxChars),
                    "expectPid": Schema.integer("Refuse with focus_changed unless this process still has focus", min: 0, max: Int(Int32.max)),
                ], required: ["text"]),
                permissions: [.accessibility],
                receiptKind: "dictation"
            )) { ctx in
                let p = try ctx.decode(DictationInsertParams.self)
                let outcome = try await DictationQueue.run {
                    try DictationInserter.insert(p.text, expectPid: p.expectPID, backend: backend)
                }
                // The receipt names the app and the length, never the text.
                let receipt = ReceiptDraft(
                    outcome: .ok, summary: "Dictated \(outcome.chars) characters into \(outcome.target.appName)",
                    externalRefs: outcome.target.bundleID.map { ["bundleId": .string($0)] } ?? [:])
                return CapabilityOutput([
                    "method": .string(outcome.method.rawValue),
                    "chars": .int(outcome.chars),
                    "target": outcome.target.wire,
                ], receipt: receipt)
            },

            Capability(CapabilitySpec(
                name: "dictation.watch",
                description: "Desktop dictation only: stream {key, down, at} while a hold-to-talk modifier (fn, Right Option, Right Command) goes down and up. Listen-only; a newer watch or key: null ends this one.",
                sideEffect: .read,
                inputSchema: Schema.object([
                    "key": Schema.string("Modifier to watch; null stops", enum: ["fn", "rightOption", "rightCommand"]),
                ]),
                streaming: true,
                permissions: [.accessibility]
            )) { ctx in
                let p = try ctx.decode(DictationWatchParams.self)
                guard let key = p.key else {
                    watcher.stop()
                    return CapabilityOutput(["watching": false])
                }
                let changes = try watcher.start(key)
                // The first event is the key's state once the tap is installed: the Gateway answers
                // `watching: true` on it.
                await ctx.emit(try JSONValue(encoding: DictationKeyPayload(at: DictationCapabilities.timestamp(), down: false, key: key)))
                for await down in changes {
                    let payload = DictationKeyPayload(at: Self.timestamp(), down: down, key: key)
                    await ctx.emit(try JSONValue(encoding: payload))
                }
                return CapabilityOutput(["watching": false])
            },
        ]
    }
}

extension DictationCapabilities {
    static func timestamp() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date())
    }
}

/// AX and typing block for up to a few seconds; keep them off the cooperative pool.
enum DictationQueue {
    private static let queue = DispatchQueue(label: "com.psyche.helper.dictation", qos: .userInteractive)

    static func run<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { cont in
            queue.async { cont.resume(with: Result { try body() }) }
        }
    }
}

/// Live AX / CGEvent side of dictation.
public struct LiveDictationBackend: DictationBackend {
    static let messagingTimeout: Float = 0.25

    public init() {}

    private func focusedElement() -> AXUIElement? {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, Self.messagingTimeout)
        return AX.element(AX.attr(sys, "AXFocusedUIElement"))
    }

    public func focus() -> DictationFocus? {
        if let f = focusedElement(), let pid = AX.pid(f) {
            AXUIElementSetMessagingTimeout(f, Self.messagingTimeout)
            let app = NSRunningApplication(processIdentifier: pid)
            let a = AX.attrs(f, ["AXRole", "AXSubrole"])
            let role = AX.string(a["AXRole"])
            let secure = AX.string(a["AXSubrole"]) == "AXSecureTextField" || role == "AXSecureTextField"
            let info = DictationElementInfo(
                selectedTextSettable: AX.isSettable(f, "AXSelectedText"),
                valueSettable: AX.isSettable(f, "AXValue"),
                hasSelectedRange: AX.attr(f, "AXSelectedTextRange") != nil,
                isWebArea: role == "AXWebArea")
            return DictationFocus(
                pid: pid, bundleId: app?.bundleIdentifier, appName: app?.localizedName ?? "pid \(pid)", role: role,
                secure: secure, element: info)
        }
        // No AX focus (an Electron app without its tree): the frontmost app gets the keystrokes.
        guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
        return DictationFocus(pid: front.processIdentifier, bundleId: front.bundleIdentifier, appName: front.localizedName ?? "pid \(front.processIdentifier)")
    }

    public func secureInputActive() -> Bool { IsSecureEventInputEnabled() }

    public func setSelectedText(_ text: String) -> Bool {
        guard let f = focusedElement() else { return false }
        let before = AX.string(AX.attr(f, "AXValue"))
        guard AXUIElementSetAttributeValue(f, "AXSelectedText" as CFString, text as CFString) == .success else { return false }
        // Chromium answers success and ignores the write; an unchanged value means "type it".
        let after = AX.string(AX.attr(f, "AXValue"))
        return before == nil || after == nil || before != after
    }

    public func replaceSelectedRange(_ text: String) -> Bool {
        guard let f = focusedElement(), let value = AX.string(AX.attr(f, "AXValue")),
              let rangeRef = AX.attr(f, "AXSelectedTextRange"), CFGetTypeID(rangeRef) == AXValueGetTypeID()
        else { return false }
        var range = CFRange()
        guard AXValueGetValue(rangeRef as! AXValue, .cfRange, &range) else { return false }  // swiftlint:disable:this force_cast
        let ns = value as NSString
        guard range.location >= 0, range.length >= 0, range.location + range.length <= ns.length else { return false }
        let updated = ns.replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
        guard AXUIElementSetAttributeValue(f, "AXValue" as CFString, updated as CFString) == .success else { return false }
        var caret = CFRange(location: range.location + (text as NSString).length, length: 0)
        if let caretValue = AXValueCreate(.cfRange, &caret) {
            _ = AXUIElementSetAttributeValue(f, "AXSelectedTextRange" as CFString, caretValue)
        }
        return true
    }

    public func type(_ text: String, guardChunk: @escaping () throws -> Void) throws {
        try Input.type(text, stop: StopSignal(), guardChunk: guardChunk)
    }
}

/// One listen-only event tap for the hold-to-talk modifier. Starting a new watch ends the old one.
public final class DictationKeyWatcher: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Watch?

    public init() {}

    /// Starts watching `key`; the stream yields true / false on each hold and finishes when the
    /// watch is replaced or stopped. Throws `permission_missing` without Accessibility.
    public func start(_ key: DictationKey) throws -> AsyncStream<Bool> {
        guard AXIsProcessTrusted() else { throw CapabilityError.permissionMissing(.accessibility) }
        let (stream, continuation) = AsyncStream<Bool>.makeStream()
        let watch = Watch(tracker: DictationKeyTracker(key: key), continuation: continuation)
        guard watch.install() else { throw CapabilityError.permissionMissing(.accessibility) }
        lock.withLock {
            current?.finish()
            current = watch
        }
        continuation.onTermination = { [weak self, weak watch] _ in
            watch?.finish()
            self?.lock.withLock { if self?.current === watch { self?.current = nil } }
        }
        return stream
    }

    public func stop() {
        lock.withLock {
            current?.finish()
            current = nil
        }
    }

    final class Watch: @unchecked Sendable {
        private var tracker: DictationKeyTracker
        private let continuation: AsyncStream<Bool>.Continuation
        private var tap: CFMachPort?
        private var runLoop: CFRunLoop?
        private let lock = NSLock()

        init(tracker: DictationKeyTracker, continuation: AsyncStream<Bool>.Continuation) {
            self.tracker = tracker
            self.continuation = continuation
        }

        func install() -> Bool {
            let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue) | CGEventMask(1 << CGEventType.keyDown.rawValue)
            let refcon = Unmanaged.passUnretained(self).toOpaque()
            guard let port = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask,
                callback: { _, type, event, refcon in
                    if let refcon { Unmanaged<Watch>.fromOpaque(refcon).takeUnretainedValue().handle(type, event) }
                    return Unmanaged.passUnretained(event)
                }, userInfo: refcon
            ) else { return false }
            tap = port
            let retained = Unmanaged.passRetained(self)  // released when the run loop exits
            let t = Thread { [port] in
                defer { retained.release() }
                guard CFMachPortIsValid(port), let src = CFMachPortCreateRunLoopSource(nil, port, 0) else { return }
                let rl = CFRunLoopGetCurrent()
                retained.takeUnretainedValue().lock.withLock { retained.takeUnretainedValue().runLoop = rl }
                CFRunLoopAddSource(rl, src, .commonModes)
                CGEvent.tapEnable(tap: port, enable: true)
                CFRunLoopRun()
            }
            t.name = "com.psyche.helper.dictation-key"
            t.qualityOfService = .userInteractive
            t.start()
            return true
        }

        private func handle(_ type: CGEventType, _ event: CGEvent) {
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
                return
            }
            if event.getIntegerValueField(.eventSourceUserData) == Input.marker { return }
            let change: Bool? = lock.withLock {
                switch type {
                case .flagsChanged:
                    tracker.flagsChanged(keyCode: event.getIntegerValueField(.keyboardEventKeycode), flags: event.flags.rawValue)
                case .keyDown: tracker.keyDown()
                default: nil
                }
            }
            if let change { continuation.yield(change) }
        }

        func finish() {
            let (port, rl): (CFMachPort?, CFRunLoop?) = lock.withLock {
                defer { tap = nil; runLoop = nil }
                return (tap, runLoop)
            }
            if let port { CGEvent.tapEnable(tap: port, enable: false); CFMachPortInvalidate(port) }
            if let rl { CFRunLoopStop(rl) }
            continuation.finish()
        }
    }
}
