import ApplicationServices
import Carbon.HIToolbox
import Foundation
import PsycheAXRead
import PsycheHelperCore

/// The live accessibility tree of one window, read through `PsycheAXRead` only (docs/design/
/// psyche-points-2026.md §3.1). It sets nothing, performs nothing and posts nothing.
///
/// `AXValue` is read in exactly two places: `fieldValue`, which the digest builder calls for a field
/// that passed the sensitive judge, and static text (page text, not a field). Every other read goes
/// through `attributes`, which never asks for `AXValue` of a field.
final class LivePointsSource: PointsAXSource, @unchecked Sendable {
    typealias Node = AXKey

    let window: AXUIElement
    let appElement: AXUIElement

    private static let attributeNames = [
        "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXPlaceholderValue", "AXHelp", "AXIdentifier", "AXEnabled", "AXRequired",
        "AXInvalid", "AXFocused", "AXURL", "AXPosition", "AXSize", "AXTitleUIElement", "AXLinkedUIElements",
    ]

    init(window: AXUIElement, pid: pid_t) {
        self.window = window
        appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 0.5)
        AXUIElementSetMessagingTimeout(window, 0.5)
    }

    func windowRoot() -> AXKey? { AXKey(element: window) }

    func attributes(_ node: AXKey) -> PointsAXAttributes {
        let e = node.element
        let a = AX.attrs(e, Self.attributeNames)
        let role = AX.string(a["AXRole"]) ?? "AXUnknown"
        var text: String?
        if role == "AXStaticText" {
            // The only content a static text has is its value; it is page text, not a field.
            text = AX.string(AX.attr(e, "AXValue")) ?? AX.string(a["AXTitle"])
        } else if role == "AXHeading" {
            text = AX.string(a["AXTitle"]) ?? AX.string(a["AXDescription"])
        }
        var frame: CGRect?
        if let p = AX.point(a["AXPosition"]), let s = AX.size(a["AXSize"]) { frame = CGRect(origin: p, size: s) }
        return PointsAXAttributes(
            role: role, subrole: AX.string(a["AXSubrole"]), title: AX.string(a["AXTitle"]), description: AX.string(a["AXDescription"]),
            placeholder: AX.string(a["AXPlaceholderValue"]), help: AX.string(a["AXHelp"]), identifier: AX.string(a["AXIdentifier"]),
            titleElementText: AX.element(a["AXTitleUIElement"]).flatMap(labelText),
            linkedTexts: AX.elements(a["AXLinkedUIElements"]).prefix(4).compactMap(labelText),
            url: AX.string(a["AXURL"]), text: text, required: AX.bool(a["AXRequired"]), invalid: Self.invalid(a["AXInvalid"]),
            enabled: AX.bool(a["AXEnabled"]), focused: AX.bool(a["AXFocused"]), frame: frame)
    }

    /// The text of a label element: its title, or its value only when it is static text.
    private func labelText(_ e: AXUIElement) -> String? {
        if let t = AX.string(AX.attr(e, "AXTitle")), !t.isEmpty { return t }
        if AX.string(AX.attr(e, "AXRole")) == "AXStaticText" { return AX.string(AX.attr(e, "AXValue")) }
        return AX.string(AX.attr(e, "AXDescription"))
    }

    /// `AXInvalid` is a Boolean in some apps and the strings "true"/"false" (or a token) in web areas.
    private static func invalid(_ v: CFTypeRef?) -> Bool? {
        if let b = AX.bool(v) { return b }
        guard let s = AX.string(v)?.lowercased() else { return nil }
        return s != "false" && s != "0" && !s.isEmpty
    }

    func children(of node: AXKey) -> [AXKey] {
        AX.elements(AX.attr(node.element, "AXChildren")).map { AXKey(element: $0) }
    }

    func options(of node: AXKey, limit: Int) -> [String] {
        var out: [String] = []
        for menu in AX.elements(AX.attr(node.element, "AXChildren")) {
            for item in AX.elements(AX.attr(menu, "AXChildren")) {
                if let t = AX.string(AX.attr(item, "AXTitle")), !t.isEmpty { out.append(String(t.prefix(120))) }
                if out.count >= limit { return out }
            }
        }
        return out
    }

    func focusedElement() -> AXKey? {
        AX.element(AX.attr(appElement, "AXFocusedUIElement")).map { AXKey(element: $0) }
    }

    func secureEventInput() -> Bool { IsSecureEventInputEnabled() }

    func fieldValue(of node: AXKey) -> String? { AX.string(AX.attr(node.element, "AXValue")) }

    func characterCount(of node: AXKey) -> Int? {
        guard let v = AX.attr(node.element, "AXNumberOfCharacters"), CFGetTypeID(v) == CFNumberGetTypeID() else { return nil }
        return (v as? NSNumber)?.intValue
    }
}
