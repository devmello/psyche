import Foundation

/// Where a feature model is in loading its snapshot (docs/design/ios-app-2026.md §4).
public enum LoadPhase<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case .loaded(let value) = self { value } else { nil }
    }
}
