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
    /// Field ids in tree order, for "the next two planned fields" (the overlay keeps its card off them).
    private var order: [String] = []
    /// Every node ever judged sensitive this session, with its reason. A node in here is never read again.
    private var latched: [Node: PointsSensitiveReason] = [:]
    private var sensitiveFill: [Node: PointsFieldFill] = [:]
    private var lastCommitted: [String: String] = [:]
    private var lastNow: Double = 0
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
        lastNow = now
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
        lastNow = now
        switch n {
        case .focusChanged(let node): focusChanged(node, at: now)
        case .valueChanged(let node):
            // Judge again on every change: Secure Event Input can come on after focus (a paste or autofill
            // into a custom password field), and the settle or a quick tab-away must not read it.
            if let id = ids.existingId(for: node), records[id] != nil, stillPlain(id) { coalescer.valueChanged(fieldId: id, at: now) }
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
        lastNow = now
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

    /// Judges one element again from what it says NOW, before any value is read (a custom field can
    /// become a password field, or be relabelled "Card number", after the digest). True when it is
    /// still plain. Once a node is sensitive it stays so for the session, whatever it is relabelled.
    private func stillPlain(_ id: String) -> Bool {
        guard var r = records[id] else { return false }
        if r.sensitive != nil || latched[r.node] != nil { return false }
        let a = source.attributes(r.node)
        var f = r.facts
        func raw(_ s: String?) -> String? { PointsDigestBuilder.tidy(s, 300) }
        f.label = raw(a.title) ?? raw(a.titleElementText) ?? raw(a.description) ?? raw(a.placeholder) ?? raw(a.help)
        f.placeholder = raw(a.placeholder)
        f.help = raw(a.help)
        f.identifier = a.identifier
        f.nearbyText = r.facts.nearbyText + [a.description, a.titleElementText].compactMap { $0 }
        let focusedNow = source.focusedElement()
        f.secure = r.facts.secure || a.role == "AXSecureTextField" || a.subrole == "AXSecureTextField"
            || (source.secureEventInput() && focusedNow == r.node)
        let reason = PointsSensitiveJudge.classify(f, directionsOnly: r.directionsOnly)
        if let label = PointsDigestBuilder.tidy(a.title, 120), !r.label.isEmpty, label != r.label { coalescer.layoutChanged(at: lastNow) }
        if reason == nil, PointsRoleMap.fieldRole(role: a.role, subrole: a.subrole) != r.role { f.secure = false }
        guard let reason else {
            r.facts = f
            records[id] = r
            return true
        }
        latched[r.node] = reason
        r.sensitive = reason
        r.facts = f
        r.fill = sensitiveFill[r.node] ?? .unknown
        records[id] = r
        coalescer.layoutChanged(at: lastNow)
        return false
    }

    private func focusChanged(_ node: Node?, at now: Double) {
        if let prev = focusedId { commit(prev) }
        guard let node else { focusedId = nil; return }
        if let id = ids.existingId(for: node), records[id] != nil {
            focusedId = id
            pendingFocus = nil
            _ = stillPlain(id)  // latches a field that turned sensitive since the digest (Secure Event Input, a relabel)
            emit(PointsSessionEvent(fieldID: id, type: .focus))
        } else {
            focusedId = nil
            pendingFocus = node
            coalescer.layoutChanged(at: now)
        }
    }

    /// Focus left a field: the one moment its value may leave the helper.
    private func commit(_ id: String) {
        guard let r0 = records[id] else { return }
        coalescer.cancelValue(fieldId: id)
        if !stillPlain(id) {
            var r = records[id] ?? r0
            // Never AXValue. Filled or empty from the character count, where the app has one.
            let state: PointsFieldFill
            if let n = source.characterCount(of: r.node) { state = n > 0 ? .filled : .empty } else { state = .unknown }
            sensitiveFill[r.node] = state
            r.fill = state
            records[id] = r
            if state != .unknown { emit(PointsSessionEvent(fieldID: id, state: state, type: .field)) }
            return
        }
        var r = records[id] ?? r0
        guard r.role != .button, r.role != .link else { return }
        let value = source.fieldValue(of: r.node)
        let state = PointsDigestBuilder.fillState(role: r.role, value: value)
        r.fill = state
        let sendsValue = [.text, .multiline, .number, .date, .combobox, .popup].contains(r.role)
        var out: String?
        if sendsValue, state == .filled, let value {
            if PointsValueRules.classify(value, label: r.label) != nil {
                // A secret in a plain-looking field: it never leaves, and the field is sensitive from now on.
                latched[r.node] = .valueShape
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
        guard stillPlain(id), var r = records[id], r.role != .button, r.role != .link else { return }
        let state = PointsDigestBuilder.fillState(role: r.role, value: source.fieldValue(of: r.node))
        guard state != r.fill else { return }
        r.fill = state
        records[id] = r
        emit(PointsSessionEvent(fieldID: id, state: state, type: .field))
    }

    // MARK: Reads

    private func fullRead(at now: Double) {
        guard let read = PointsDigestBuilder.read(source: source, target: target, ids: &ids, latched: latched, sensitiveFill: sensitiveFill) else {
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
        if !watched.isEmpty { refreshFrames() }  // the overlay follows a relayout too
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
        order = read.records.map(\.id)
        for r in read.records { if let why = r.sensitive { latched[r.node] = why } }
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

    // MARK: The overlay's view of the target (W4)

    /// The ids of the `count` fields after `id` in tree order (links are not planned fields).
    public func nextFieldIds(after id: String, count: Int) -> [String] {
        guard let i = order.firstIndex(of: id) else { return [] }
        return Array(order[(i + 1)...].filter { records[$0]?.role != .link }.prefix(count))
    }

    /// Reads fresh frames (attributes only: a field's value is never read here).
    public func targetInfo(for id: String) -> PointsTargetInfo? {
        guard var r = records[id] else { return nil }
        if let f = source.attributes(r.node).frame {
            r.frame = f
            records[id] = r
        }
        let nextIds = nextFieldIds(after: id, count: 2)
        var nextFrames: [CGRect] = []
        for n in nextIds {
            guard var nr = records[n] else { continue }
            if let f = source.attributes(nr.node).frame { nr.frame = f; records[n] = nr }
            if let f = nr.frame { nextFrames.append(f) }
        }
        return PointsTargetInfo(
            fieldId: id, label: r.label, role: r.role, sensitive: r.sensitive != nil || latched[r.node] != nil, frame: r.frame,
            nextIds: nextIds, nextFrames: nextFrames, windowFrame: windowFrame())
    }

    public func windowFrame() -> CGRect? {
        guard let w = source.windowRoot() else { return nil }
        return source.attributes(w).frame
    }

    // Test and diagnostics access (no values).
    public func record(_ id: String) -> PointsFieldRecord<Node>? { records[id] }
    public func fieldId(for node: Node) -> String? { ids.existingId(for: node) }
}

/// What the overlay needs about the field it points at: frames and a label, never a value.
public struct PointsTargetInfo: Sendable, Equatable {
    public var fieldId: String
    public var label: String
    public var role: PointsFieldRole
    /// A sensitive field never gets a suggested value on the card.
    public var sensitive: Bool
    public var frame: CGRect?
    /// Frames of the next two fields after the target, in tree order.
    public var nextIds: [String]
    public var nextFrames: [CGRect]
    public var windowFrame: CGRect?

    public init(fieldId: String, label: String, role: PointsFieldRole, sensitive: Bool, frame: CGRect?, nextIds: [String], nextFrames: [CGRect], windowFrame: CGRect?) {
        self.fieldId = fieldId
        self.label = label
        self.role = role
        self.sensitive = sensitive
        self.frame = frame
        self.nextIds = nextIds
        self.nextFrames = nextFrames
        self.windowFrame = windowFrame
    }
}

