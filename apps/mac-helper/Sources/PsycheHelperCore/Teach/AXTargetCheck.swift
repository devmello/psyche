import Foundation

/// `computer.check_target` (teach by showing, replay): the accessibility twin of the browser's
/// `browser.check_target`. A replayed step names its target by the role and name it was recorded
/// with; this looks that up in a fresh snapshot by **exact role and name** (ignoring case and
/// spacing) and answers `found` (one match, with its ref), `missing` or `ambiguous`. It is
/// read-only and deterministic. Anything but `found` carries `stop`, and the skill tells the agent
/// to stop and ask the owner. A similar-looking element is not the same element.
public enum AXTargetCheck {
    public struct Query: Codable, Sendable, Equatable {
        /// A role as the recording keeps it (`button`, `textbox`, `menuitem`); `generic` or nil matches any.
        public var role: String?
        public var name: String?
        /// The element's accessibility identifier (the recording's `identifier:` fallback).
        public var identifier: String?
        /// For a menu choice: titles from the menu bar down ("File", "Export").
        public var menuPath: [String]?

        public init(role: String? = nil, name: String? = nil, identifier: String? = nil, menuPath: [String]? = nil) {
            self.role = role
            self.name = name
            self.identifier = identifier
            self.menuPath = menuPath
        }
    }

    public enum Outcome: Equatable, Sendable {
        case found(ref: String, role: String, label: String?)
        case missing
        case ambiguous([String])

        public var status: String {
            switch self {
            case .found: "found"
            case .missing: "missing"
            case .ambiguous: "ambiguous"
            }
        }
    }

    static func norm(_ s: String?) -> String {
        guard let s else { return "" }
        let base = s.range(of: "…(+").map { String(s[..<$0.lowerBound]) } ?? s
        return base.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
    }

    /// A snapshot node's role (`textfield`, `button:closeButton`, `popupbutton`) as the recording's role.
    public static func recordedRole(_ snapshotRole: String) -> String {
        let base = snapshotRole.split(separator: ":").first.map(String.init) ?? snapshotRole
        switch base {
        case "button", "menubutton", "disclosuretriangle": return "button"
        case "textfield", "textarea", "securetextfield": return "textbox"
        case "searchfield": return "searchbox"
        case "combobox", "popupbutton": return "combobox"
        case "checkbox": return snapshotRole.contains("switch") ? "switch" : "checkbox"
        case "radiobutton": return "radio"
        case "menuitem", "menubaritem": return "menuitem"
        case "link": return "link"
        case "slider": return "slider"
        case "row": return "row"
        case "cell": return "cell"
        case "tabgroup": return "tablist"
        case "table", "outline": return "table"
        case "toolbar": return "toolbar"
        case "list": return "list"
        case "image": return "img"
        default: return "generic"
        }
    }

    public static func check(_ nodes: [AXSnapshotNode], _ q: Query) -> Outcome {
        if let menu = q.menuPath, !menu.isEmpty { return checkMenu(nodes, menu) }
        let wantName = norm(q.name)
        let wantId = q.identifier.map { $0.replacingOccurrences(of: "identifier:", with: "") }
        guard !wantName.isEmpty || wantId != nil else { return .missing }
        let anyRole = q.role == nil || q.role == "generic" || q.role?.isEmpty == true
        let hits = nodes.filter { n in
            // A secure field is never a replay target: the owner types those themselves.
            if n.role.lowercased().contains("securetextfield") || n.flags.contains("secure") { return false }
            if !anyRole, recordedRole(n.role) != q.role { return false }
            if !wantName.isEmpty, norm(n.label) != wantName { return false }
            if let wantId, n.id != wantId { return false }
            return true
        }
        return outcome(hits)
    }

    /// The menu item whose chain of ancestors' titles is the path, exactly.
    static func checkMenu(_ nodes: [AXSnapshotNode], _ path: [String]) -> Outcome {
        let byRef = Dictionary(nodes.map { ($0.ref, $0) }, uniquingKeysWith: { a, _ in a })
        let want = path.map(norm)
        guard let last = want.last, !last.isEmpty else { return .missing }
        let hits = nodes.filter { n in
            guard recordedRole(n.role) == "menuitem", norm(n.label) == last else { return false }
            // Walk up through menu items / bar items; menus themselves carry no title of their own.
            var chain: [String] = [norm(n.label)]
            var cursor = n.parent.flatMap { byRef[$0] }
            while let c = cursor {
                if recordedRole(c.role) == "menuitem" { chain.insert(norm(c.label), at: 0) }
                cursor = c.parent.flatMap { byRef[$0] }
            }
            return chain == want
        }
        return outcome(hits)
    }

    private static func outcome(_ hits: [AXSnapshotNode]) -> Outcome {
        switch hits.count {
        case 0: .missing
        case 1: .found(ref: hits[0].ref, role: hits[0].role, label: hits[0].label)
        default: .ambiguous(hits.prefix(5).map(\.ref))
        }
    }
}
