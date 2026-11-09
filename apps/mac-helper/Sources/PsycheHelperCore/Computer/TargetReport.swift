import Foundation
import PsycheProtocol

/// What `computer.resolve_target` reports about the element under a ref or a screen point: its
/// role and the accessibility labels of the element and its nearest ancestors. The Gateway reads
/// them before a click by screen point, because a point carries no label it has seen, and asks the
/// owner for a payment card when the control is a money action (security §3.7). Read-only: nothing
/// is pressed, and a secure field reports its role only, never a label.
public enum TargetReport {
    static let maxLabels = 6
    static let maxLabelChars = 200

    /// Labels trimmed, capped and de-duplicated, in the order given (the element's own first).
    public static func labels(_ raw: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for label in raw {
            let t = label.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            let capped = t.count > maxLabelChars ? String(t.prefix(maxLabelChars)) : t
            if seen.insert(capped).inserted { out.append(capped) }
            if out.count == maxLabels { break }
        }
        return out
    }

    public static func result(role: String?, labels raw: [String], secure: Bool, app: String) -> JSONValue {
        var o: [String: JSONValue] = ["app": .string(app), "provenance": "untrusted"]
        if let role { o["role"] = .string(role) }
        if secure {
            o["secure"] = .bool(true)
            o["labels"] = .array([])
            return .object(o)
        }
        let labels = labels(raw)
        o["labels"] = .array(labels.map { .string($0) })
        if let first = labels.first { o["label"] = .string(first) }
        return .object(o)
    }
}
