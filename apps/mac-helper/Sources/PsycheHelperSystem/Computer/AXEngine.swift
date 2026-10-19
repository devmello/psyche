import AppKit
import ApplicationServices
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// The running app a call targets.
public struct TargetApp: Sendable, Equatable {
    public var pid: pid_t
    public var bundleId: String?
    public var name: String
    public var electron: Bool
}

/// An element resolved from a ref, re-read just now.
struct ResolvedElement: @unchecked Sendable {
    var key: AXKey
    var ref: String
    var app: TargetApp
    var info: AXElementInfo
    var roleName: String
    var label: String?
}

/// Owns the helper's AX state: one ref table for the helper's lifetime (refs are server-side
/// handles, spike 04 rule 1) and a serial queue, because AX calls are blocking IPC.
final class AXEngine: @unchecked Sendable {
    static let messagingTimeout: Float = 1.0

    private let queue = DispatchQueue(label: "com.psyche.helper.ax", qos: .userInitiated)
    private let source = LiveAXSource()
    private let refs = AXRefTable<AXKey>()
    private var options = AXSnapshotOptions()
    private var lastNodes: [AXSnapshotNode] = []
    private var electronPrimed: Set<pid_t> = []

    /// Runs `body` on the AX queue.
    func run<T: Sendable>(_ body: @escaping @Sendable (AXEngine) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { cont in
            queue.async { cont.resume(with: Result { try body(self) }) }
        }
    }

    // MARK: Apps

    static func runningApp(pid: pid_t) -> NSRunningApplication? { NSRunningApplication(processIdentifier: pid) }

    static func isElectron(_ app: NSRunningApplication) -> Bool {
        guard let u = app.bundleURL else { return false }
        return FileManager.default.fileExists(atPath: u.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
    }

    static func target(_ app: NSRunningApplication) -> TargetApp {
        TargetApp(pid: app.processIdentifier, bundleId: app.bundleIdentifier, name: app.localizedName ?? app.bundleIdentifier ?? "app",
                  electron: isElectron(app))
    }

    /// `app` may be a bundle id, a localized name or a pid; nil means the frontmost app.
    static func findApp(_ query: String?, pid: Int32? = nil) throws -> NSRunningApplication {
        if let pid {
            guard let app = runningApp(pid: pid) else { throw CapabilityError(.notFound, reason: "app_not_running", "No running app with pid \(pid)") }
            return app
        }
        guard let q = query?.trimmingCharacters(in: .whitespaces), !q.isEmpty else {
            guard let front = NSWorkspace.shared.frontmostApplication else {
                throw CapabilityError(.notFound, reason: "no_frontmost_app", "No app is frontmost")
            }
            return front
        }
        let apps = NSWorkspace.shared.runningApplications
        if let a = apps.first(where: { $0.bundleIdentifier?.lowercased() == q.lowercased() }) { return a }
        let named = apps.filter { $0.localizedName?.lowercased() == q.lowercased() }
        if let a = named.first(where: { $0.activationPolicy == .regular }) ?? named.first { return a }
        throw CapabilityError(.notFound, reason: "app_not_running", "\(q) is not running. Open it with apps.open first.", details: ["app": .string(q)])
    }

    private func appElement(_ app: NSRunningApplication) -> AXUIElement {
        let ae = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ae, Self.messagingTimeout)
        if Self.isElectron(app) {
            // Wakes Chromium's AX tree. Its getter always reads false, so set it on every attach.
            _ = AXUIElementSetAttributeValue(ae, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
        return ae
    }

    // MARK: Snapshot

    struct SnapshotRequest: Sendable {
        var app: NSRunningApplication
        var window: Int?
        var root: String?  // "window" | "app" | ref
        var menubar: Bool
        var options: AXSnapshotOptions
    }

    func snapshot(_ req: SnapshotRequest) throws -> (AXSnapshot, TargetApp) {
        let target = Self.target(req.app)
        let ae = appElement(req.app)
        if target.electron, !electronPrimed.contains(target.pid) {
            // Chromium builds its tree asynchronously after AXManualAccessibility (~3 s frontmost).
            electronPrimed.insert(target.pid)
            waitForWebArea(ae, timeout: 3)
        }
        let rootElement: AXUIElement
        switch req.root {
        case nil, "window":
            guard let w = Self.window(ae, index: req.window) else {
                let (err, _) = AX.copy(ae, "AXRole")
                if err == .apiDisabled { throw CapabilityError.permissionMissing(.accessibility) }
                if err == .cannotComplete { throw Self.notResponding(target) }
                throw CapabilityError(.notFound, reason: "no_window", "\(target.name) has no open window. Use root: \"app\" for menus and popovers.")
            }
            rootElement = w
        case "app":
            rootElement = ae
        case let ref?:
            rootElement = try element(for: ref).key.element
        }
        let focused = AX.element(AX.attr(ae, "AXFocusedUIElement")).map(AXKey.init)
        var extra: [AXKey] = []
        if req.menubar, let mb = AX.element(AX.attr(ae, "AXMenuBar")) { extra.append(AXKey(element: mb)) }
        let builder = AXSnapshotBuilder(source: source, refs: refs, options: req.options, focused: focused)
        let snap = builder.snapshot(
            root: AXKey(element: rootElement), app: target.name, pid: target.pid, bundleId: target.bundleId,
            electron: target.electron, extraRoots: extra
        )
        options = req.options
        lastNodes = snap.nodes
        return (snap, target)
    }

    private func waitForWebArea(_ ae: AXUIElement, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let w = Self.window(ae, index: nil), containsWebArea(w, depth: 0) { return }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    private func containsWebArea(_ e: AXUIElement, depth: Int) -> Bool {
        if depth > 12 { return false }
        if AX.string(AX.attr(e, "AXRole")) == "AXWebArea" { return true }
        return AX.elements(AX.attr(e, "AXChildren")).prefix(8).contains { containsWebArea($0, depth: depth + 1) }
    }

    static func window(_ ae: AXUIElement, index: Int?) -> AXUIElement? {
        if let i = index {
            let ws = AX.elements(AX.attr(ae, "AXWindows"))
            return i >= 0 && i < ws.count ? ws[i] : nil
        }
        return AX.element(AX.attr(ae, "AXFocusedWindow")) ?? AX.element(AX.attr(ae, "AXMainWindow"))
            ?? AX.elements(AX.attr(ae, "AXWindows")).first
    }

    // MARK: Refs

    /// Resolves `ref` and re-reads it. Stale means error, not a guess (spike 04 rule 3).
    func element(for ref: String) throws -> ResolvedElement {
        guard let key = refs.element(for: ref) else {
            throw CapabilityError(.notFound, reason: "unknown_ref", "Unknown ref \(ref). Take a new snapshot with computer.ax_tree; refs are never reused.",
                                  details: ["ref": .string(ref)])
        }
        let (err, _) = AX.copy(key.element, "AXRole")
        guard let pid = AX.pid(key.element), let app = Self.runningApp(pid: pid) else {
            throw Self.stale(ref)
        }
        switch err {
        case .success: break
        case .invalidUIElement: throw Self.stale(ref)
        case .cannotComplete: throw Self.notResponding(Self.target(app))
        case .apiDisabled: throw CapabilityError.permissionMissing(.accessibility)
        default: throw Self.stale(ref)
        }
        guard let info = source.info(key) else { throw Self.stale(ref) }
        let builder = AXSnapshotBuilder(source: source, refs: refs, options: options, focused: nil)
        return ResolvedElement(key: key, ref: ref, app: Self.target(app), info: info,
                               roleName: AXText.roleName(info.role, info.subrole), label: builder.label(for: key))
    }

    func resolve(selector: AXSelector) throws -> String {
        switch selector.resolve(in: lastNodes) {
        case .ref(let r): return r
        case .none:
            throw CapabilityError(.notFound, reason: "selector_no_match", "No element in the last snapshot matches the selector exactly")
        case .ambiguous(let refs):
            throw CapabilityError(.conflict, reason: "selector_ambiguous", "The selector matches several elements; use a ref",
                                  details: ["candidates": .array(refs.map { .string($0) })])
        }
    }

    static func stale(_ ref: String) -> CapabilityError {
        CapabilityError(.notFound, reason: "stale_ref", "\(ref) no longer exists. Take a new snapshot.", details: ["ref": .string(ref)])
    }

    static func notResponding(_ app: TargetApp) -> CapabilityError {
        CapabilityError(.unavailable, reason: "app_not_responding", "\(app.name) is not responding", retryable: true)
    }

    // MARK: Element queries

    /// Full `AXValue` (spike 04: snapshots truncate at 160 chars).
    func fullValue(_ el: ResolvedElement, max: Int) -> String? {
        guard let v = AX.string(AX.attr(el.key.element, "AXValue")) else { return nil }
        return v.count > max ? String(v.prefix(max)) : v
    }

    func currentValue(_ el: ResolvedElement) -> String? { AX.string(AX.attr(el.key.element, "AXValue")) }

    func frame(_ el: ResolvedElement) -> CGRect? { AX.frame(el.key.element) }

    func actionNames(_ el: ResolvedElement) -> [String] { AX.actionNames(el.key.element) }

    func perform(_ el: ResolvedElement, action: String) -> AXError { AXUIElementPerformAction(el.key.element, action as CFString) }

    func isSettable(_ el: ResolvedElement, _ attribute: String) -> Bool { AX.isSettable(el.key.element, attribute) }

    func set(_ el: ResolvedElement, _ attribute: String, _ value: CFTypeRef) -> AXError {
        AXUIElementSetAttributeValue(el.key.element, attribute as CFString, value)
    }

    func isSelected(_ el: ResolvedElement) -> Bool? { AX.bool(AX.attr(el.key.element, "AXSelected")) }

    /// The app's focused element now, and whether it is a secure text field.
    func focusedIsSecure(pid: pid_t?) -> Bool {
        let root = pid.map(AXUIElementCreateApplication) ?? AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(root, Self.messagingTimeout)
        guard let f = AX.element(AX.attr(root, "AXFocusedUIElement")) else { return false }
        return AX.string(AX.attr(f, "AXSubrole")) == "AXSecureTextField"
    }

    /// The app owning the element under a screen point (top-left origin).
    func app(at point: CGPoint) -> NSRunningApplication? {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, Self.messagingTimeout)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(sys, Float(point.x), Float(point.y), &hit) == .success, let hit,
              let pid = AX.pid(hit)
        else { return nil }
        return Self.runningApp(pid: pid)
    }

    func elementAtPointIsSecure(_ point: CGPoint) -> Bool {
        let sys = AXUIElementCreateSystemWide()
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(sys, Float(point.x), Float(point.y), &hit) == .success, let hit else { return false }
        return AX.string(AX.attr(hit, "AXSubrole")) == "AXSecureTextField"
    }

    /// Presses a menu item by path (`File>Rename`) without opening the menus. Each segment must
    /// match exactly one item (case-insensitive, trailing "…" ignored).
    func pressMenu(_ app: NSRunningApplication, path: [String]) throws -> String {
        let ae = appElement(app)
        guard var current = AX.element(AX.attr(ae, "AXMenuBar")) else {
            throw CapabilityError(.notFound, reason: "no_menu_bar", "\(app.localizedName ?? "The app") has no menu bar")
        }
        func norm(_ s: String) -> String {
            s.lowercased().trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "")
        }
        var title = ""
        for (i, name) in path.enumerated() {
            var items = AX.elements(AX.attr(current, "AXChildren"))
            if i > 0, let menu = items.first, AX.string(AX.attr(menu, "AXRole")) == "AXMenu" {
                items = AX.elements(AX.attr(menu, "AXChildren"))
            }
            let hits = items.filter { norm(AX.string(AX.attr($0, "AXTitle")) ?? "") == norm(name) }
            guard hits.count == 1 else {
                let have = items.compactMap { AX.string(AX.attr($0, "AXTitle")) }.filter { !$0.isEmpty }.prefix(30)
                throw CapabilityError(
                    hits.isEmpty ? .notFound : .conflict, reason: hits.isEmpty ? "menu_item_not_found" : "menu_item_ambiguous",
                    "Menu item \"\(name)\" \(hits.isEmpty ? "not found" : "is ambiguous")",
                    details: ["available": .array(have.map { .string($0) })]
                )
            }
            current = hits[0]
            title = AX.string(AX.attr(current, "AXTitle")) ?? name
        }
        if AX.bool(AX.attr(current, "AXEnabled")) == false {
            throw CapabilityError(.conflict, reason: "menu_item_disabled", "Menu item \"\(title)\" is disabled")
        }
        let r = AXUIElementPerformAction(current, kAXPressAction as CFString)
        guard r == .success else {
            throw CapabilityError(.unavailable, reason: "ax_error", "Pressing \(title) failed (AXError \(r.rawValue))")
        }
        return title
    }
}
