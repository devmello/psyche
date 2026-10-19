import CoreGraphics
import Foundation
import PsycheProtocol

// Accessibility-tree snapshots (feature J1; spike 04 "Recommended snapshot schema"). The builder is
// generic over `AXTreeSource` so pruning, refs and rendering are unit-tested against fake trees; the
// live source over `AXUIElement` lives in PsycheHelperSystem.

/// Attributes of one element, fetched in one `AXUIElementCopyMultipleAttributeValues` call live.
public struct AXElementInfo: Sendable, Equatable {
    public var role: String
    public var subrole: String?
    public var title: String?
    public var description: String?
    public var value: String?
    public var placeholder: String?
    public var identifier: String?
    public var url: String?
    public var enabled: Bool?
    public var selected: Bool?
    public var frame: CGRect?
    /// Value of `AXTitleUIElement` (the label element of a form field), when present.
    public var titleElementValue: String?

    public init(
        role: String, subrole: String? = nil, title: String? = nil, description: String? = nil, value: String? = nil,
        placeholder: String? = nil, identifier: String? = nil, url: String? = nil, enabled: Bool? = nil,
        selected: Bool? = nil, frame: CGRect? = nil, titleElementValue: String? = nil
    ) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.value = value
        self.placeholder = placeholder
        self.identifier = identifier
        self.url = url
        self.enabled = enabled
        self.selected = selected
        self.frame = frame
        self.titleElementValue = titleElementValue
    }

    public var isSecure: Bool { subrole == "AXSecureTextField" }
}

/// Read access to an accessibility tree. `Element` must hash and compare by element identity
/// (`CFHash` / `CFEqual` live).
public protocol AXTreeSource: AnyObject {
    associatedtype Element: Hashable
    /// `nil` when the element is gone (`kAXErrorInvalidUIElement`).
    func info(_ element: Element) -> AXElementInfo?
    func children(_ element: Element) -> [Element]
    /// `AXVisibleRows` of a table / outline (empty when unsupported).
    func visibleRows(_ element: Element) -> [Element]
    func header(_ element: Element) -> Element?
    /// Raw action names (`AXPress`, custom `"Name:pin\nTarget:0x0\nSelector:(null)"`).
    func actions(_ element: Element) -> [String]
    func isValueSettable(_ element: Element) -> Bool
}

public struct AXSnapshotOptions: Sendable, Equatable {
    public var maxVisit = 6000
    public var maxEmit = 400
    /// Raw AX depth safety cap. Spike 04: depth ≤ 8 loses Electron web content and Reminders rows.
    public var maxDepth = 40
    public var textMax = 80
    public var valueMax = 160
    public var clip = true
    public var prune = true
    public init() {}
}

public struct AXSnapshotNode: Codable, Sendable, Equatable {
    public var ref: String
    public var role: String
    public var label: String?
    public var value: String?
    public var placeholder: String?
    public var url: String?
    public var id: String?
    public var actions: [String]
    public var flags: [String]
    public var frame: [Int]?
    public var depth: Int
    public var parent: String?

    public init(
        ref: String, role: String, label: String? = nil, value: String? = nil, placeholder: String? = nil, url: String? = nil,
        id: String? = nil, actions: [String] = [], flags: [String] = [], frame: [Int]? = nil, depth: Int = 0, parent: String? = nil
    ) {
        self.ref = ref
        self.role = role
        self.label = label
        self.value = value
        self.placeholder = placeholder
        self.url = url
        self.id = id
        self.actions = actions
        self.flags = flags
        self.frame = frame
        self.depth = depth
        self.parent = parent
    }
}

public struct AXSnapshotHeader: Codable, Sendable, Equatable {
    public var app: String
    public var pid: Int32
    public var bundleId: String?
    public var electron: Bool
    public var window: String?
    public var windowFrame: [Int]?
    public var focused: String?
    public var snapGen: Int
    public var visited: Int
    public var emitted: Int
    public var truncated: String?
    public var newRefs: Int
    public var reusedRefs: Int
}

public struct AXSnapshot: Codable, Sendable, Equatable {
    public var header: AXSnapshotHeader
    public var nodes: [AXSnapshotNode]

    /// The compact text form the model sees (spike 04 "Text form").
    public func render() -> String {
        let h = header
        var s = "# app=\(h.app) pid=\(h.pid)"
        if h.electron { s += " electron" }
        if let w = h.window { s += " window=\"\(w)\"" }
        if let f = h.windowFrame { s += " @\(f[0]),\(f[1]) \(f[2])x\(f[3])" }
        if let f = h.focused { s += " focus=\(f)" }
        s += " snap=\(h.snapGen) nodes=\(h.emitted)/\(h.visited)"
        if let t = h.truncated { s += " TRUNCATED(\(t))" }
        s += "\n"
        for n in nodes {
            var l = String(repeating: "  ", count: n.depth) + "[\(n.ref)] \(n.role)"
            if let x = n.label { l += " \"\(x)\"" }
            if let x = n.value { l += " =\"\(x)\"" }
            if let x = n.placeholder { l += " ph=\"\(x)\"" }
            if let x = n.id { l += " #\(x)" }
            if let x = n.url { l += " <\(x)>" }
            if !n.actions.isEmpty { l += " {\(n.actions.joined(separator: ","))}" }
            if !n.flags.isEmpty { l += " " + n.flags.joined(separator: " ") }
            if let f = n.frame { l += " @\(f[0]),\(f[1]) \(f[2])x\(f[3])" }
            s += l + "\n"
        }
        return s
    }
}

// MARK: - Refs

/// Helper-held refs (spike 04 "Ref stability rules"): `e<N>`, monotonic, keyed by element identity,
/// never reassigned. Refs not seen for `evictAfterSnapshots` snapshots are evicted, after which they
/// behave like stale refs.
public final class AXRefTable<Element: Hashable> {
    private var refOf: [Element: String] = [:]
    private var elementOf: [String: Element] = [:]
    private var lastSeen: [String: Int] = [:]
    private var next = 1
    public private(set) var generation = 0
    public let evictAfterSnapshots: Int

    public init(evictAfterSnapshots: Int = 25) {
        self.evictAfterSnapshots = evictAfterSnapshots
    }

    public var count: Int { elementOf.count }

    /// Starts a snapshot generation and evicts refs unseen for too long.
    public func beginSnapshot() -> Int {
        generation += 1
        for (ref, seen) in lastSeen where generation - seen > evictAfterSnapshots {
            if let e = elementOf.removeValue(forKey: ref) { refOf[e] = nil }
            lastSeen[ref] = nil
        }
        return generation
    }

    /// The ref for `element`, minting one if new. `isNew` tells the caller whether it was minted.
    public func ref(for element: Element) -> (ref: String, isNew: Bool) {
        if let r = refOf[element] {
            lastSeen[r] = generation
            return (r, false)
        }
        let r = "e\(next)"
        next += 1
        refOf[element] = r
        elementOf[r] = element
        lastSeen[r] = generation
        return (r, true)
    }

    public func existingRef(for element: Element) -> String? { refOf[element] }
    public func element(for ref: String) -> Element? { elementOf[ref] }
}

// MARK: - Builder

enum AXRoles {
    static let containers: Set = [
        "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXSplitter",
        "AXMatte", "AXRuler", "AXGrowArea", "AXColumn", "AXScrollBar", "AXValueIndicator", "AXBrowser",
        "AXGenericElement",
    ]
    static let landmarks: Set = [
        "AXWindow", "AXSheet", "AXDialog", "AXToolbar", "AXTable", "AXOutline", "AXList", "AXTabGroup", "AXWebArea",
        "AXMenuBar", "AXMenu", "AXPopover", "AXDrawer",
    ]
    static let interactive: Set = [
        "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
        "AXComboBox", "AXSlider", "AXIncrementor", "AXLink", "AXRow", "AXCell", "AXMenuItem", "AXMenuBarItem",
        "AXDisclosureTriangle", "AXColorWell", "AXDateField", "AXTimeField", "AXSegmentedControl", "AXStepper",
        "AXDockItem", "AXRadioGroup", "AXSearchField", "AXTab",
    ]
    static let text: Set = ["AXStaticText", "AXHeading", "AXImage"]
    /// Interactive leaves whose label usually lives in descendant text.
    static let collapse: Set = [
        "AXButton", "AXLink", "AXRow", "AXCell", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
        "AXMenuButton", "AXTab",
    ]
    static let textInputs: Set = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    static let menus: Set = ["AXMenu", "AXMenuItem", "AXMenuBar", "AXMenuBarItem"]
    static let noiseActions: Set = ["AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI"]
    /// VoiceOver navigation custom actions present on every toolbar item.
    static let customNoise: Set = ["Move next", "Move previous", "Remove from toolbar"]
    static let actionShort: [String: String] = [
        "AXPress": "press", "AXShowMenu": "menu", "AXConfirm": "confirm", "AXCancel": "cancel", "AXRaise": "raise",
        "AXIncrement": "inc", "AXDecrement": "dec", "AXPick": "pick", "AXOpen": "open",
    ]
    static let keptSubroles: Set = [
        "SearchField", "SecureTextField", "CloseButton", "MinimizeButton", "ZoomButton", "FullScreenButton", "Toggle",
        "Switch", "TabButton", "OutlineRow", "SortButton", "TextLink", "Dialog", "StandardWindow", "FloatingWindow",
        "SystemDialog",
    ]
}

public enum AXText {
    /// `AXRole` without `AX`, lowercased, plus an allowlisted subrole (`button:closeButton`).
    public static func roleName(_ role: String, _ subrole: String?) -> String {
        var r = role.hasPrefix("AX") ? String(role.dropFirst(2)).lowercased() : role.lowercased()
        if r == "statictext" { r = "text" }
        if let sub = subrole, !sub.isEmpty, sub != "AXUnknown" {
            let s = sub.hasPrefix("AX") ? String(sub.dropFirst(2)) : sub
            if AXRoles.keptSubroles.contains(s) { r += ":" + s.prefix(1).lowercased() + s.dropFirst() }
        }
        return r
    }

    /// Single line, trimmed, at most `n` characters with a `…(+N)` suffix.
    public static func truncate(_ s: String?, _ n: Int) -> String? {
        guard var s else { return nil }
        s = s.replacingOccurrences(of: "\n", with: "⏎").replacingOccurrences(of: "\t", with: " ")
            .trimmingCharacters(in: .whitespaces)
        if s.isEmpty { return nil }
        if s.count <= n { return s }
        return String(s.prefix(n)) + "…(+\(s.count - n))"
    }

    /// Custom actions come back as `"Name:pin\nTarget:0x0\nSelector:(null)"`; keep the name.
    public static func customActionName(_ raw: String) -> String {
        guard raw.hasPrefix("Name:") else { return raw }
        return String(raw.dropFirst(5).split(separator: "\n", maxSplits: 1).first ?? "")
    }

    /// Developer-assigned identifiers only (no AppKit `_NS`/`NS` ids, no generated ones).
    public static func cleanIdentifier(_ id: String?) -> String? {
        guard let id, !id.isEmpty, id.count <= 40, !id.hasPrefix("_NS"), !id.hasPrefix("NS"), !id.contains(","),
              !id.contains("["), !id.contains(" ") || id.count <= 24
        else { return nil }
        return id
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    static func frameInts(_ f: CGRect) -> [Int] { [Int(f.minX), Int(f.minY), Int(f.width), Int(f.height)] }

    static func isFinite(_ f: CGRect) -> Bool {
        [f.minX, f.minY, f.width, f.height].allSatisfy { $0.isFinite && abs($0) < 1e7 }
    }
}

/// Walks one root (window, app or ref) and emits pruned nodes with stable refs.
public final class AXSnapshotBuilder<Source: AXTreeSource> {
    public typealias Element = Source.Element

    let source: Source
    let refs: AXRefTable<Element>
    let options: AXSnapshotOptions
    let focused: Element?

    private(set) var nodes: [AXSnapshotNode] = []
    private(set) var visited = 0
    private(set) var truncated: String?
    private(set) var newRefs = 0
    private(set) var reusedRefs = 0
    private var seen = Set<Element>()

    public init(source: Source, refs: AXRefTable<Element>, options: AXSnapshotOptions, focused: Element?) {
        self.source = source
        self.refs = refs
        self.options = options
        self.focused = focused
    }

    /// Snapshot of `root`. Header identity fields (app, pid, …) come from the caller.
    public func snapshot(
        root: Element, app: String, pid: Int32, bundleId: String?, electron: Bool, extraRoots: [Element] = []
    ) -> AXSnapshot {
        let gen = refs.beginSnapshot()
        let rootInfo = source.info(root)
        let clipRect = rootInfo?.frame.flatMap { AXText.isFinite($0) ? $0 : nil } ?? .null
        walk(root, depth: 0, kept: 0, parent: nil, clip: rootInfo?.role == "AXApplication" ? .null : clipRect, inCollapsed: false)
        for extra in extraRoots {
            walk(extra, depth: 0, kept: 0, parent: nil, clip: .null, inCollapsed: false)
        }
        // The focused element is not always reachable from the window's children (Finder's rename
        // field editor, popovers): append it, marked `detached`, so the model can type into it.
        if let f = focused, !seen.contains(f) {
            let start = nodes.count
            walk(f, depth: 0, kept: 0, parent: nil, clip: .null, inCollapsed: false, depthCap: 2)
            for i in start..<nodes.count { nodes[i].flags.append("detached") }
        }
        let header = AXSnapshotHeader(
            app: app, pid: pid, bundleId: bundleId, electron: electron,
            window: rootInfo?.role == "AXApplication" ? nil : AXText.truncate(rootInfo?.title, options.textMax),
            windowFrame: clipRect.isNull ? nil : AXText.frameInts(clipRect),
            focused: focused.flatMap { refs.existingRef(for: $0) }, snapGen: gen, visited: visited, emitted: nodes.count,
            truncated: truncated, newRefs: newRefs, reusedRefs: reusedRefs
        )
        return AXSnapshot(header: header, nodes: nodes)
    }

    /// The label the snapshot would show for `element` (used for `expect` checks).
    public func label(for element: Element) -> String? {
        guard let info = source.info(element) else { return nil }
        var label = baseLabel(element, info)
        if label == nil, AXRoles.collapse.contains(info.role) {
            var parts: [String] = []
            gatherText(element, 0, &parts)
            if !parts.isEmpty { label = parts.joined(separator: " · ") }
        }
        return AXText.truncate(label, options.textMax)
    }

    private func baseLabel(_ e: Element, _ info: AXElementInfo) -> String? {
        AXText.nonEmpty(info.title) ?? AXText.nonEmpty(info.description) ?? AXText.nonEmpty(info.titleElementValue)
    }

    private func gatherText(_ e: Element, _ depth: Int, _ out: inout [String]) {
        if depth > 4 || out.count >= 6 { return }
        for c in source.children(e) {
            if out.count >= 6 { return }
            visited += 1
            guard let i = source.info(c) else { continue }
            if i.role == "AXStaticText" || i.role == "AXTextField" || i.role == "AXHeading" {
                if let t = AXText.nonEmpty(i.value) ?? AXText.nonEmpty(i.title), !t.trimmingCharacters(in: .whitespaces).isEmpty {
                    out.append(t)
                }
            } else if i.role == "AXImage", let d = AXText.nonEmpty(i.description) {
                out.append(d)
            }
            gatherText(c, depth + 1, &out)
        }
    }

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    private func walk(
        _ e: Element, depth: Int, kept: Int, parent: String?, clip: CGRect, inCollapsed: Bool,
        parentLabel: String? = nil, parentActions: Set<String> = [], parentValue: String? = nil,
        inheritSelected: Bool = false, depthCap: Int? = nil
    ) {
        let o = options
        if visited >= o.maxVisit { truncated = truncated ?? "maxVisit"; return }
        if nodes.count >= o.maxEmit { truncated = truncated ?? "maxEmit"; return }
        // Tables expose cells through rows *and* columns.
        guard seen.insert(e).inserted else { return }
        visited += 1
        guard let a = source.info(e) else { return }
        let role = a.role
        if o.prune && (role == "AXScrollBar" || role == "AXColumn" || role == "AXGrowArea") { return }

        var frame: CGRect?
        if let f = a.frame, AXText.isFinite(f) { frame = f }  // some apps report inf/NaN
        if o.clip, let f = frame, f.width > 0, f.height > 0, !clip.isNull, !f.intersects(clip), !AXRoles.menus.contains(role) {
            return
        }
        let acts = source.actions(e).map(AXText.customActionName).filter { !AXRoles.noiseActions.contains($0) }
        let secure = a.isSecure
        var label = baseLabel(e, a)
        var value: String? = secure ? (a.value.map { _ in "•••" }) : a.value
        if role == "AXCheckBox" || role == "AXRadioButton" {
            value = value.map { $0 == "1" ? "on" : ($0 == "0" ? "off" : $0) }
        }
        let identifier = AXText.cleanIdentifier(a.identifier)
        let canSet = (AXRoles.textInputs.contains(role) || role == "AXSlider") && !secure && source.isValueSettable(e)
        let meaningful = acts.filter { $0 != "AXShowMenu" }

        var keep: Bool
        if !o.prune {
            keep = true
        } else if AXRoles.landmarks.contains(role) || AXRoles.interactive.contains(role) || canSet {
            keep = true
        } else if !meaningful.isEmpty {
            keep = true  // clickable web divs
        } else if AXRoles.text.contains(role) {
            keep = !inCollapsed && ((value?.isEmpty == false) || label != nil)
        } else if AXRoles.containers.contains(role) {
            keep = label != nil
        } else {
            keep = label != nil || identifier != nil || value?.isEmpty == false
        }
        if o.prune && role == "AXImage" && label == nil && meaningful.isEmpty { keep = false }
        if o.prune && role == "AXStaticText" && label == nil && value == nil { keep = false }
        // Zero-area, unlabelled elements are hidden chrome.
        if o.prune, let f = frame, f.width < 1 || f.height < 1, label == nil, value == nil { keep = false }

        var collapse = false
        if keep && AXRoles.collapse.contains(role) && label == nil && (value == nil || role == "AXRow" || role == "AXCell") {
            var parts: [String] = []
            gatherText(e, 0, &parts)
            if !parts.isEmpty { label = parts.joined(separator: " · ") }
            collapse = true
        }
        if keep && AXRoles.collapse.contains(role) && label != nil { collapse = true }
        // Unlabelled row/cell wrapping a single control: hoist the control.
        var passSelected = false
        if o.prune && keep && (role == "AXRow" || role == "AXCell") && label == nil && meaningful.isEmpty {
            keep = false
            collapse = false
            passSelected = inheritSelected || a.selected == true
        }
        // Text that only repeats its parent's value or label.
        if o.prune && keep && role == "AXStaticText" && label == nil && value != nil && (value == parentValue || value == parentLabel) {
            keep = false
        }
        // Echo of the parent that adds no new action.
        if o.prune && keep && label != nil && label == parentLabel && (value == nil || value == label) && !canSet
            && Set(acts).subtracting(parentActions).subtracting(["AXShowMenu"]).isEmpty
        {
            keep = false
        }

        var myRef = parent
        var myKept = kept
        if keep {
            let (r, isNew) = refs.ref(for: e)
            if isNew { newRefs += 1 } else { reusedRefs += 1 }
            var flags: [String] = []
            if a.enabled == false { flags.append("disabled") }
            // Per-element AXFocused is unreliable; compare with the app's AXFocusedUIElement.
            if let f = focused, f == e { flags.append("focused") }
            if a.selected == true || inheritSelected { flags.append("selected") }
            if secure { flags.append("secure") }
            var short = acts.filter { $0.hasPrefix("AX") }.compactMap { AXRoles.actionShort[$0] }
            let custom = acts.filter { !$0.hasPrefix("AX") && !AXRoles.customNoise.contains($0) && !parentActions.contains($0) }
            short += custom.prefix(3).map { "custom:" + (AXText.truncate($0, 24) ?? $0) }
            if custom.count > 3 { short.append("+\(custom.count - 3)custom") }
            if canSet { short.append("set") }
            let showValue = value != nil && value != label
            nodes.append(AXSnapshotNode(
                ref: r, role: AXText.roleName(role, a.subrole), label: AXText.truncate(label, o.textMax),
                value: showValue ? AXText.truncate(value, o.valueMax) : nil,
                placeholder: (value?.isEmpty ?? true) ? AXText.truncate(a.placeholder, 40) : nil,
                url: role == "AXWebArea" || role == "AXLink" ? AXText.truncate(a.url, 120) : nil,
                id: identifier, actions: short, flags: flags, frame: frame.map(AXText.frameInts), depth: kept, parent: parent
            ))
            myRef = r
            myKept = kept + 1
        }

        if depth >= (depthCap ?? o.maxDepth) {
            if depthCap == nil, !source.children(e).isEmpty { truncated = truncated ?? "maxDepth" }
            return
        }
        if secure { return }  // never descend into secure fields
        var nextClip = clip
        if role == "AXScrollArea" || role == "AXWebArea", let f = frame, f.width > 0 {
            nextClip = clip.isNull ? f : clip.intersection(f)
        }
        // Tables/outlines: walk the header and visible rows only (AXChildren holds every row).
        var kids: [Element]
        if role == "AXTable" || role == "AXOutline" {
            kids = source.visibleRows(e)
            if let hdr = source.header(e) { kids.insert(hdr, at: 0) }
            if kids.isEmpty { kids = source.children(e) }
        } else {
            kids = source.children(e)
        }
        for c in kids {
            walk(
                c, depth: depth + 1, kept: myKept, parent: myRef, clip: nextClip, inCollapsed: inCollapsed || collapse,
                parentLabel: label ?? parentLabel, parentActions: Set(acts), parentValue: value,
                inheritSelected: passSelected, depthCap: depthCap
            )
        }
    }
}

// MARK: - Expectations and selectors

/// `expect {role, label?, valuePrefix?}` copied from the snapshot the model acted on (spike 04 rule
/// 4: identity is not meaning; apps reuse views).
public struct AXExpectation: Codable, Sendable, Equatable {
    public var role: String
    public var label: String?
    public var valuePrefix: String?

    public init(role: String, label: String? = nil, valuePrefix: String? = nil) {
        self.role = role
        self.label = label
        self.valuePrefix = valuePrefix
    }

    /// Compares against the element as it is now. Labels compare up to a truncation marker.
    public func mismatch(role actualRole: String, label actualLabel: String?, value actualValue: String?) -> String? {
        if role != actualRole { return "role is \(actualRole), expected \(role)" }
        if let label {
            let want = Self.stripTruncation(label)
            let have = actualLabel.map(Self.stripTruncation) ?? ""
            if !(have == want || (label.contains("…(+") && have.hasPrefix(want)) || (actualLabel?.contains("…(+") == true && want.hasPrefix(have))) {
                return "label is \"\(actualLabel ?? "")\", expected \"\(label)\""
            }
        }
        if let valuePrefix, !(actualValue ?? "").hasPrefix(Self.stripTruncation(valuePrefix)) {
            return "value does not start with the expected prefix"
        }
        return nil
    }

    static func stripTruncation(_ s: String) -> String {
        guard let r = s.range(of: "…(+") else { return s }
        return String(s[..<r.lowerBound])
    }
}

/// Selector over the latest snapshot: must match exactly one node (spike 04 rule 5, incident 2).
public struct AXSelector: Codable, Sendable, Equatable {
    public var role: String?
    public var label: String?
    public var id: String?

    public init(role: String? = nil, label: String? = nil, id: String? = nil) {
        self.role = role
        self.label = label
        self.id = id
    }

    public enum Resolution: Equatable {
        case ref(String)
        case none
        case ambiguous([String])
    }

    /// Exact matches on every given field (labels compare case-sensitively and whole).
    public func resolve(in nodes: [AXSnapshotNode]) -> Resolution {
        let hits = nodes.filter { n in
            (role == nil || n.role == role) && (label == nil || n.label == label) && (id == nil || n.id == id)
        }
        switch hits.count {
        case 0: return .none
        case 1: return .ref(hits[0].ref)
        default: return .ambiguous(hits.prefix(5).map(\.ref))
        }
    }
}
