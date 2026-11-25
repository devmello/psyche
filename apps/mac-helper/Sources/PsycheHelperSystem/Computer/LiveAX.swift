import AppKit
import ApplicationServices
import Foundation
import PsycheAXRead
import PsycheHelperCore

/// Live `AXTreeSource`.
final class LiveAXSource: AXTreeSource {
    func info(_ k: AXKey) -> AXElementInfo? {
        let a = AX.attrs(k.element, AX.nodeAttributes)
        guard let role = AX.string(a["AXRole"]) else { return nil }
        var frame: CGRect?
        if let p = AX.point(a["AXPosition"]), let s = AX.size(a["AXSize"]) { frame = CGRect(origin: p, size: s) }
        let titleUI = AX.element(a["AXTitleUIElement"]).flatMap { AX.string(AX.attr($0, "AXValue")) }
        return AXElementInfo(
            role: role, subrole: AX.string(a["AXSubrole"]), title: AX.string(a["AXTitle"]),
            description: AX.string(a["AXDescription"]), value: AX.string(a["AXValue"]),
            placeholder: AX.string(a["AXPlaceholderValue"]), identifier: AX.string(a["AXIdentifier"]),
            url: AX.string(a["AXURL"]), enabled: AX.bool(a["AXEnabled"]), selected: AX.bool(a["AXSelected"]), frame: frame,
            titleElementValue: titleUI
        )
    }

    func children(_ k: AXKey) -> [AXKey] { AX.elements(AX.attr(k.element, "AXChildren")).map(AXKey.init) }
    func visibleRows(_ k: AXKey) -> [AXKey] { AX.elements(AX.attr(k.element, "AXVisibleRows")).map(AXKey.init) }
    func header(_ k: AXKey) -> AXKey? { AX.element(AX.attr(k.element, "AXHeader")).map(AXKey.init) }
    func actions(_ k: AXKey) -> [String] { AX.actionNames(k.element) }
    func isValueSettable(_ k: AXKey) -> Bool { AX.isSettable(k.element, "AXValue") }
}
