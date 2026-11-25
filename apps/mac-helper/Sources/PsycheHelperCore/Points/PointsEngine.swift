import CoreGraphics
import Foundation
import PsycheProtocol

/// What the live observer tells the engine (the table of docs/design/psyche-points-2026.md §3.2).
public enum PointsNotification<Node: Hashable> {
    /// `kAXFocusedUIElementChangedNotification`: the app's focus moved (nil: nothing is focused).
    case focusChanged(Node?)
    /// `kAXValueChangedNotification` on the focused field.
    case valueChanged(Node)
    /// `AXLoadComplete`, a title change or `kAXLayoutChangedNotification`.
    case layoutChanged
    /// `kAXUIElementDestroyedNotification`.
    case destroyed(Node?)
    /// The window itself went away.
    case windowDestroyed
    /// `kAXMovedNotification`, `kAXResizedNotification` or a scroll.
    case geometryChanged
    case windowMiniaturized(Bool)
    case appActive(Bool)
    case appHidden(Bool)
    case appTerminated
}

/// The perception half of Points over an abstract source: it turns notifications into the wire
/// events of `points.session` and decides what may be read (docs/design/psyche-points-2026.md §3.2,
/// §5.1). Single-threaded: the live controller calls it from one run-loop thread.
///
/// - **No value is read for a sensitive field.** `fieldValue` is called for a plain field only.
///   A sensitive field gets one `characterCount` read, when focus leaves it.
/// - **A value is sent only on commit**: when focus leaves a plain field, and then once, never
///   while the owner types (typing only sends filled or empty, after 300 ms of quiet).
/// - **A value of a secret shape is dropped** and its field turns sensitive for the rest of the session.
public final class PointsEngine<S: PointsAXSource>: @unchecked Sendable {
    public typealias Node = S.Node
    public static var valueMax: Int { 500 }

    private let source: S
    private let target: PointsTarget
    private let emit: (PointsSessionEvent) -> Void
    /// Frames of the watched fields, after a scroll or a move (for the overlay, W4).
    public var onFrames: (([String: CGRect]) -> Void)?

    private var ids = PointsFieldIds<Node>()
    private var records: [String: PointsFieldRecord<Node>] = [:]
    private var valueShape = Set<Node>()
    private var sensitiveFill: [Node: PointsFieldFill] = [:]
    private var lastCommitted: [String: String] = [:]
    private var lastFingerprint: String?
    private var lastSummary: Data?
    private var focusedId: String?
    private var pendingFocus: Node?
    private var watched: [String] = []
    private var coalescer = PointsCoalescer()
    private var windowMinimized = false
    private var appActive = true
    private var appHidden = false
    private var lastVisible = true
    public private(set) var ended = false

    public init(source: S, target: PointsTarget, emit: @escaping (PointsSessionEvent) -> Void) {
        self.source = source
        self.target = target
        self.emit = emit
    }

    public var nextDeadline: Double? { ended ? nil : coalescer.nextDeadline }

    /// The fields the overlay watches: their frames are re-read after a scroll or a move.
    public func setWatched(_ fieldIds: [String]) { watched = Array(fieldIds.prefix(8)) }

    public var currentFieldCount: Int { records.count }

    // MARK: Start and end

    /// The first read. Emits the digest; false when the window cannot be read at all.
    @discardableResult
    public func begin(at now: Double) -> Bool {
        guard let read = PointsDigestBuilder.read(source: source, target: target, ids: &ids) else {
            finish(.windowClosed)
            return false
        }
        apply(read)
        lastFingerprint = read.digest.fingerprint
        lastSummary = summary(of: read.digest)
        emit(PointsSessionEvent(digest: read.digest, type: .digest))
        return true
    }

    private func finish(_ reason: PointsEndReason) {
        guard !ended else { return }
        ended = true
        emit(PointsSessionEvent(reason: reason, type: .ended))
    }

    /// Ends the session with `reason` (the owner pressed Stop, the Gateway ended it, the app changed).
    public func end(_ reason: PointsEndReason) { finish(reason) }

    // MARK: Notifications

    public func notify(_ n: PointsNotification<Node>, at now: Double) {
        guard !ended else { return }
        switch n {
        case .focusChanged(let node): focusChanged(node, at: now)
        case .valueChanged(let node):
            if let id = ids.existingId(for: node), records[id] != nil { coalescer.valueChanged(fieldId: id, at: now) }
        case .layoutChanged: coalescer.layoutChanged(at: now)
        case .destroyed(let node):
            if let node, ids.existingId(for: node) == nil { return }  // some other element of the app
            coalescer.layoutChanged(at: now)
        case .windowDestroyed: finish(.windowClosed)
        case .geometryChanged: coalescer.scrolled(at: now)
        case .windowMiniaturized(let v): windowMinimized = v; visibility()
        case .appActive(let v): appActive = v; visibility()
        case .appHidden(let v): appHidden = v; visibility()
        case .appTerminated: finish(.appQuit)
        }
    }

    private func visibility() {
        let visible = !windowMinimized && appActive && !appHidden
        guard visible != lastVisible else { return }
        lastVisible = visible
        emit(PointsSessionEvent(type: .visible, visible: visible))
    }

    /// Runs what is due at `now` (the caller's one-shot timer fired, or a notification arrived).
    public func tick(at now: Double) {
        guard !ended else { return }
        for work in coalescer.due(at: now) {
            switch work {
            case .fullRead: fullRead(at: now)
            case .valueSettled(let id): valueSettled(id)
            case .frames: refreshFrames()
            }
            if ended { return }
        }
    }

    // MARK: Focus and commit

    private func focusChanged(_ node: Node?, at now: Double) {
        if let prev = focusedId { commit(prev) }
        guard let node else { focusedId = nil; return }
        if let id = ids.existingId(for: node), records[id] != nil {
            focusedId = id
            pendingFocus = nil
            emit(PointsSessionEvent(fieldID: id, type: .focus))
            // A field whose label changed under us is a different field: read the page again.
            if let r = records[id], let title = PointsDigestBuilder.tidy(source.attributes(node).title, 120), !r.label.isEmpty, title != r.label {
                coalescer.layoutChanged(at: now)
            }
        } else {
            focusedId = nil
            pendingFocus = node
            coalescer.layoutChanged(at: now)
        }
    }

    /// Focus left a field: the one moment its value may leave the helper.
    private func commit(_ id: String) {
        guard var r = records[id] else { return }
        coalescer.cancelValue(fieldId: id)
        if r.sensitive != nil {
            // Never AXValue. Filled or empty from the character count, where the app has one.
            let state: PointsFieldFill
            if let n = source.characterCount(of: r.node) { state = n > 0 ? .filled : .empty } else { state = .unknown }
            sensitiveFill[r.node] = state
            r.fill = state
            records[id] = r
            if state != .unknown { emit(PointsSessionEvent(fieldID: id, state: state, type: .field)) }
            return
        }
        guard r.role != .button, r.role != .link else { return }
        let value = source.fieldValue(of: r.node)
        let state = PointsDigestBuilder.fillState(role: r.role, value: value)
        r.fill = state
        let sendsValue = [.text, .multiline, .number, .date, .combobox, .popup].contains(r.role)
        var out: String?
        if sendsValue, state == .filled, let value {
            if AppTeachPolicy.valueReason(value, label: r.label) != nil {
                // A secret of a plain-looking field: it never leaves, and the field is sensitive from now on.
                valueShape.insert(r.node)
                r.sensitive = .valueShape
            } else {
                out = String(value.prefix(Self.valueMax))
            }
        }
        records[id] = r
        let key = out ?? (r.sensitive != nil ? "\u{0}shape" : "\u{0}\(state.rawValue)")
        if lastCommitted[id] == key { return }
        lastCommitted[id] = key
        emit(PointsSessionEvent(fieldID: id, state: state, type: .field, value: out))
    }

    /// 300 ms after the last change to the focused field: filled or empty, never the value.
    private func valueSettled(_ id: String) {
        guard var r = records[id], r.sensitive == nil, r.role != .button, r.role != .link else { return }
        let state = PointsDigestBuilder.fillState(role: r.role, value: source.fieldValue(of: r.node))
        guard state != r.fill else { return }
        r.fill = state
        records[id] = r
        emit(PointsSessionEvent(fieldID: id, state: state, type: .field))
    }

    // MARK: Reads

    private func fullRead(at now: Double) {
        guard let read = PointsDigestBuilder.read(source: source, target: target, ids: &ids, valueShape: valueShape, sensitiveFill: sensitiveFill) else {
            finish(.windowClosed)
            return
        }
        apply(read)
        let newPage = read.digest.fingerprint != lastFingerprint
        let sum = summary(of: read.digest)
        if newPage {
            lastFingerprint = read.digest.fingerprint
            lastCommitted = [:]
            emit(PointsSessionEvent(type: .page))
        }
        if newPage || sum != lastSummary {
            lastSummary = sum
            emit(PointsSessionEvent(digest: read.digest, type: .digest))
        }
        if let node = pendingFocus, let id = ids.existingId(for: node), records[id] != nil {
            pendingFocus = nil
            focusedId = id
            emit(PointsSessionEvent(fieldID: id, type: .focus))
        }
    }

    private func apply(_ read: PointsRead<Node>) {
        var next: [String: PointsFieldRecord<Node>] = [:]
        for r in read.records { next[r.id] = r }
        records = next
        if let f = read.records.first(where: { $0.focused }) { focusedId = f.id }
        // Keep the commit memory of fields still on the page.
        lastCommitted = lastCommitted.filter { next[$0.key] != nil }
    }

    private func summary(of digest: PointsDigest) -> Data? {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return try? enc.encode(digest)
    }

    private func refreshFrames() {
        var frames: [String: CGRect] = [:]
        for id in watched {
            guard var r = records[id] else { continue }
            if let f = source.attributes(r.node).frame {
                frames[id] = f
                r.frame = f
                records[id] = r
            }
        }
        if !frames.isEmpty { onFrames?(frames) }
    }

    // Test and diagnostics access (no values).
    public func record(_ id: String) -> PointsFieldRecord<Node>? { records[id] }
    public func fieldId(for node: Node) -> String? { ids.existingId(for: node) }
}
