import ApplicationServices
import Foundation

/// `AXUIElement` keyed by identity (`CFEqual` / `CFHash`), so the same element keeps its ref.
public struct AXKey: Hashable, @unchecked Sendable {
    public let element: AXUIElement

    public init(element: AXUIElement) { self.element = element }

    public func hash(into h: inout Hasher) { h.combine(CFHash(element)) }
    public static func == (a: AXKey, b: AXKey) -> Bool { CFEqual(a.element, b.element) }
}

/// Thin, typed wrappers over the AX C API. Read-only: this target links no call that sets an attribute,
/// performs an action or posts an event (docs/design/psyche-points-2026.md §4.3).
public enum AX {
    public static let nodeAttributes = [
        "AXRole", "AXSubrole", "AXTitle", "AXValue", "AXDescription", "AXPlaceholderValue", "AXIdentifier", "AXEnabled",
        "AXSelected", "AXPosition", "AXSize", "AXURL", "AXTitleUIElement",
    ]

    public static func copy(_ e: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
        var v: CFTypeRef?
        let r = AXUIElementCopyAttributeValue(e, name as CFString, &v)
        return (r, r == .success ? v : nil)
    }

    public static func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? { copy(e, name).1 }

    public static func attrs(_ e: AXUIElement, _ names: [String]) -> [String: CFTypeRef] {
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

    public static func isError(_ v: CFTypeRef?) -> Bool {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return false }
        return AXValueGetType(v as! AXValue) == .axError  // swiftlint:disable:this force_cast
    }

    public static func string(_ v: CFTypeRef?) -> String? {
        guard let v else { return nil }
        let t = CFGetTypeID(v)
        if t == CFStringGetTypeID() { return v as? String }
        if t == CFAttributedStringGetTypeID() { return (v as? NSAttributedString)?.string }
        if t == CFNumberGetTypeID() { return (v as? NSNumber)?.stringValue }
        if t == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) ? "1" : "0" }  // swiftlint:disable:this force_cast
        if t == CFURLGetTypeID() { return (v as? URL)?.absoluteString }
        return nil
    }

    public static func bool(_ v: CFTypeRef?) -> Bool? {
        guard let v, !isError(v) else { return nil }
        if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }  // swiftlint:disable:this force_cast
        if CFGetTypeID(v) == CFNumberGetTypeID() { return (v as? NSNumber)?.boolValue }
        return nil
    }

    public static func point(_ v: CFTypeRef?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil  // swiftlint:disable:this force_cast
    }

    public static func size(_ v: CFTypeRef?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil  // swiftlint:disable:this force_cast
    }

    public static func element(_ v: CFTypeRef?) -> AXUIElement? {
        guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)  // swiftlint:disable:this force_cast
    }

    public static func elements(_ v: CFTypeRef?) -> [AXUIElement] {
        guard let v, CFGetTypeID(v) == CFArrayGetTypeID(), let arr = v as? [AnyObject] else { return [] }
        return arr.compactMap { element($0 as CFTypeRef) }
    }

    public static func frame(_ e: AXUIElement) -> CGRect? {
        let a = attrs(e, ["AXPosition", "AXSize"])
        guard let p = point(a["AXPosition"]), let s = size(a["AXSize"]) else { return nil }
        return CGRect(origin: p, size: s)
    }

    public static func actionNames(_ e: AXUIElement) -> [String] {
        var a: CFArray?
        guard AXUIElementCopyActionNames(e, &a) == .success, let arr = a as? [String] else { return [] }
        return arr
    }

    public static func isSettable(_ e: AXUIElement, _ name: String) -> Bool {
        var b: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(e, name as CFString, &b) == .success && b.boolValue
    }

    public static func pid(_ e: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(e, &pid) == .success ? pid : nil
    }
}


/// Where keyboard input would go right now: the system-wide focused element's pid and whether it
/// is a secure text field.
public enum AXKeyboardFocus {
    public static func current() -> (pid: pid_t?, secure: Bool) {
        let sys = AXUIElementCreateSystemWide()
        guard let f = AX.element(AX.attr(sys, "AXFocusedUIElement")) else { return (nil, false) }
        return (AX.pid(f), AX.string(AX.attr(f, "AXSubrole")) == "AXSecureTextField")
    }
}
