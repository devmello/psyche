/// Hands a non-`Sendable` value to another thread when the code guarantees it is used safely there
/// (e.g. a `CFMachPort` event tap handed to the run-loop thread that owns it from then on).
/// Older Swift toolchains reject the bare capture under strict concurrency.
public struct UncheckedSendable<Value>: @unchecked Sendable {
    public let value: Value
    public init(_ value: Value) { self.value = value }
}
