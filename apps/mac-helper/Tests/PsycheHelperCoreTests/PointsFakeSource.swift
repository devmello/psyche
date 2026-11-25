import CoreGraphics
import Foundation

@testable import PsycheHelperCore

/// An in-memory AX tree for the Points tests. It counts every `AXValue` read, so a test can say
/// "no value was read for any sensitive row".
final class FakePointsSource: PointsAXSource {
    typealias Node = Int

    var attrs: [Int: PointsAXAttributes] = [:]
    var kids: [Int: [Int]] = [:]
    var values: [Int: String] = [:]
    var counts: [Int: Int] = [:]
    var focused: Int?
    var secureInput = false
    var root: Int? = 0
    /// Every node `fieldValue` was called for.
    private(set) var valueReads: [Int] = []
    private(set) var countReads: [Int] = []
    private var next = 1

    init(windowTitle: String = "Form", url: String? = "https://example.org/form") {
        attrs[0] = PointsAXAttributes(role: "AXWindow", title: windowTitle)
        if let url {
            let web = add(role: "AXWebArea", to: 0)
            attrs[web]?.url = url
            webArea = web
        }
    }

    private(set) var webArea = 0

    /// The container new fields go into.
    var container: Int { webArea }

    @discardableResult
    func add(
        role: String, to parent: Int? = nil, subrole: String? = nil, title: String? = nil, description: String? = nil,
        placeholder: String? = nil, help: String? = nil, identifier: String? = nil, text: String? = nil, value: String? = nil,
        count: Int? = nil, invalid: Bool? = nil, frame: CGRect? = nil
    ) -> Int {
        let id = next
        next += 1
        attrs[id] = PointsAXAttributes(
            role: role, subrole: subrole, title: title, description: description, placeholder: placeholder, help: help,
            identifier: identifier, text: text, invalid: invalid, enabled: true, frame: frame)
        if let value { values[id] = value }
        if let count { counts[id] = count }
        kids[parent ?? container, default: []].append(id)
        return id
    }

    func windowRoot() -> Int? { root }
    func attributes(_ node: Int) -> PointsAXAttributes { attrs[node] ?? PointsAXAttributes(role: "AXUnknown") }
    func children(of node: Int) -> [Int] { kids[node] ?? [] }
    func options(of node: Int, limit: Int) -> [String] { [] }
    func focusedElement() -> Int? { focused }
    func secureEventInput() -> Bool { secureInput }

    func fieldValue(of node: Int) -> String? {
        valueReads.append(node)
        return values[node]
    }

    func characterCount(of node: Int) -> Int? {
        countReads.append(node)
        return counts[node]
    }

    func resetReads() {
        valueReads = []
        countReads = []
    }
}

extension PointsTarget {
    static let fake = PointsTarget(bundleId: "com.apple.Safari", appName: "Safari", pid: 4242, windowTitle: "Form")
}
