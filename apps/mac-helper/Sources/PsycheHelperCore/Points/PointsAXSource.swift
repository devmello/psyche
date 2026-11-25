import CoreGraphics
import Foundation

/// What one accessibility element says about itself, minus its contents. A field's value is NOT
/// here: it is read through `PointsAXSource.fieldValue`, which the digest builder calls only for a
/// field that passed the sensitive judge (docs/design/psyche-points-2026.md §5.1). Static text and
/// headings carry their text in `text` (that is their only content, and it is page text, not a
/// field's value).
public struct PointsAXAttributes: Sendable, Equatable {
    public var role: String
    public var subrole: String?
    public var title: String?
    public var description: String?
    public var placeholder: String?
    public var help: String?
    public var identifier: String?
    /// The text of `AXTitleUIElement` (the label drawn next to the field).
    public var titleElementText: String?
    /// The texts of `AXLinkedUIElements`.
    public var linkedTexts: [String]
    /// `AXURL`, set on a web area (and a document).
    public var url: String?
    /// Static text and heading content only; nil for every other role.
    public var text: String?
    public var required: Bool?
    public var invalid: Bool?
    public var enabled: Bool?
    public var focused: Bool?
    public var frame: CGRect?

    public init(
        role: String, subrole: String? = nil, title: String? = nil, description: String? = nil, placeholder: String? = nil,
        help: String? = nil, identifier: String? = nil, titleElementText: String? = nil, linkedTexts: [String] = [], url: String? = nil,
        text: String? = nil, required: Bool? = nil, invalid: Bool? = nil, enabled: Bool? = nil, focused: Bool? = nil, frame: CGRect? = nil
    ) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.placeholder = placeholder
        self.help = help
        self.identifier = identifier
        self.titleElementText = titleElementText
        self.linkedTexts = linkedTexts
        self.url = url
        self.text = text
        self.required = required
        self.invalid = invalid
        self.enabled = enabled
        self.focused = focused
        self.frame = frame
    }
}

/// The accessibility tree of one window, abstracted so the digest builder is pure and tested with
/// a fake that counts every value read. The live adapter is in `PsycheHelperPoints` and reads only
/// through `PsycheAXRead`.
public protocol PointsAXSource: AnyObject {
    associatedtype Node: Hashable

    /// The target window.
    func windowRoot() -> Node?
    func attributes(_ node: Node) -> PointsAXAttributes
    func children(of node: Node) -> [Node]
    /// The titles of a popup's menu items, when the app exposes them (at most `limit`).
    func options(of node: Node, limit: Int) -> [String]
    /// `AXFocusedUIElement` of the target app, if it is in the window.
    func focusedElement() -> Node?
    /// Secure Event Input is on (a password field somewhere has focus).
    func secureEventInput() -> Bool

    /// **`AXValue` of a field.** Called only for a field that passed the sensitive judge, and only
    /// when the digest or a commit needs it. A test source counts every call.
    func fieldValue(of node: Node) -> String?
    /// `AXNumberOfCharacters`, where the app offers it: the one thing read from a sensitive field,
    /// once, when focus leaves it.
    func characterCount(of node: Node) -> Int?
}

/// The app and window a session is bound to.
public struct PointsTarget: Sendable, Equatable {
    public var bundleId: String
    public var appName: String
    public var pid: Int32
    public var windowTitle: String

    public init(bundleId: String, appName: String, pid: Int32, windowTitle: String) {
        self.bundleId = bundleId
        self.appName = appName
        self.pid = pid
        self.windowTitle = windowTitle
    }
}

/// Stable field ids (`f12`): a helper-held handle keyed by element identity, never reassigned
/// during a session (§3.1). An element that goes away and comes back gets its old id.
public struct PointsFieldIds<Node: Hashable> {
    private var ids: [Node: String] = [:]
    private var nodes: [String: Node] = [:]
    private var next = 1
    /// A session never holds more than this many handles; a page that churns past it ends the read.
    public static var capacity: Int { 20_000 }

    public init() {}

    public mutating func id(for node: Node) -> String? {
        if let id = ids[node] { return id }
        guard next <= Self.capacity else { return nil }
        let id = "f\(next)"
        next += 1
        ids[node] = id
        nodes[id] = node
        return id
    }

    public func node(for id: String) -> Node? { nodes[id] }
    public func existingId(for node: Node) -> String? { ids[node] }
}
