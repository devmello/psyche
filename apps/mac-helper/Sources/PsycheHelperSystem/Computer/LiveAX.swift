import AppKit
import ApplicationServices
import Foundation
import PsycheHelperCore

/// `AXUIElement` keyed by identity (`CFEqual` / `CFHash`), so the same element keeps its ref.
struct AXKey: Hashable, @unchecked Sendable {
    let element: AXUIElement

    func hash(into h: inout Hasher) { h.combine(CFHash(element)) }
    static func == (a: AXKey, b: AXKey) -> Bool { CFEqual(a.element, b.element) }
}

/// Thin, typed wrappers over the AX C API.
enum AX {
    static let nodeAttributes = [
        "AXRole", "AXSubrole", "AXTitle", "AXValue", "AXDescription", "AXPlaceholderValue", "AXIdentifier", "AXEnabled",
        "AXSelected", "AXPosition", "AXSize", "AXURL", "AXTitleUIElement",
    ]

    static func copy(_ e: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
        var v: CFTypeRef?
        let r = AXUIElementCopyAttributeValue(e, name as CFString, &v)
        return (r, r == .success ? v : nil)
    }

    static func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? { copy(e, name).1 }

    static func attrs(_ e: AXUIElement, _ names: [String]) -> [String: CFTypeRef] {
        var out: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(e, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
              let arr = out as? [AnyObject]
        else { return [:] }
        var d: [String: CFTypeRef] = [:]
        for (i, n) in names.enumerated() where i < arr.count {
            let v = arr[i] as CFTypeRef
            if !isError(v) { d[n] = v }
        }
        return d
    }

    static func isError(_ v: CFTypeRef?) -> Bool {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return false }
        return AXValueGetType(v as! AXValue) == .axError  // swiftlint:disable:this force_cast
    }

    static func string(_ v: CFTypeRef?) -> String? {
        guard let v else { return nil }
        let t = CFGetTypeID(v)
        if t == CFStringGetTypeID() { return v as? String }
        if t == CFAttributedStringGetTypeID() { return (v as? NSAttributedString)?.string }
        if t == CFNumberGetTypeID() { return (v as? NSNumber)?.stringValue }
        if t == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) ? "1" : "0" }  // swiftlint:disable:this force_cast
        if t == CFURLGetTypeID() { return (v as? URL)?.absoluteString }
        return nil
    }

    static func bool(_ v: CFTypeRef?) -> Bool? {
        guard let v, !isError(v) else { return nil }
        if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }  // swiftlint:disable:this force_cast
        if CFGetTypeID(v) == CFNumberGetTypeID() { return (v as? NSNumber)?.boolValue }
        return nil
    }

    static func point(_ v: CFTypeRef?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil  // swiftlint:disable:this force_cast
    }

    static func size(_ v: CFTypeRef?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil  // swiftlint:disable:this force_cast
    }

    static func element(_ v: CFTypeRef?) -> AXUIElement? {
        guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)  // swiftlint:disable:this force_cast
    }

    static func elements(_ v: CFTypeRef?) -> [AXUIElement] {
        guard let v, CFGetTypeID(v) == CFArrayGetTypeID(), let arr = v as? [AnyObject] else { return [] }
        return arr.compactMap { element($0 as CFTypeRef) }
    }

    static func frame(_ e: AXUIElement) -> CGRect? {
        let a = attrs(e, ["AXPosition", "AXSize"])
        guard let p = point(a["AXPosition"]), let s = size(a["AXSize"]) else { return nil }
        return CGRect(origin: p, size: s)
    }

    static func actionNames(_ e: AXUIElement) -> [String] {
        var a: CFArray?
        guard AXUIElementCopyActionNames(e, &a) == .success, let arr = a as? [String] else { return [] }
        return arr
    }

    static func isSettable(_ e: AXUIElement, _ name: String) -> Bool {
        var b: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(e, name as CFString, &b) == .success && b.boolValue
    }

    static func pid(_ e: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(e, &pid) == .success ? pid : nil
    }
}

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
