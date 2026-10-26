import Foundation
import PsycheProtocol

// `calendar.watch` (#673 H2; docs/workflows/mail-and-meetings-2026.md §8.4): the pure loop. The
// live change stream is `EKEventStoreChanged` in PsycheHelperSystem.

public enum CalendarWatchCore {
    public static let changed = "calendar.changed"
    public static let debounce: Duration = .seconds(30)

    /// `{type: "calendar.changed", at, coalesced}` (`AppleCalendarChangedEvent`).
    public static func event(at: Date, coalesced: Int) -> JSONValue {
        ["type": .string(changed), "at": .string(AppleDates.string(at)), "coalesced": .int(max(1, coalesced))]
    }

    /// Counts changes inside the open window.
    final class Window: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        /// Records a change; true when it opened a new window.
        func note() -> Bool {
            lock.withLock {
                count += 1
                return count == 1
            }
        }

        func take() -> Int {
            lock.withLock {
                defer { count = 0 }
                return count
            }
        }
    }

    /// Emits one event per window: a change opens a window of `debounce`, every change inside it is
    /// folded in, and the event goes out when it closes. So there is at most one event per window
    /// and none is later than `debounce` after the change that opened it. Returns how many events
    /// went out when `changes` ends; cancelling the invocation ends it without a last event.
    /// `sleep` waits out a window and `folded` runs after each change was counted: tests pass a gate
    /// they open themselves and wait on `folded`, instead of real time.
    public static func run(changes: AsyncStream<Void>, debounce: Duration = debounce,
                           now: @escaping @Sendable () -> Date = Date.init,
                           sleep: @escaping @Sendable (Duration) async -> Void = { try? await _Concurrency.Task.sleep(for: $0) },
                           folded: @escaping @Sendable () -> Void = {},
                           emit: @escaping @Sendable (JSONValue) async -> Void) async -> Int {
        let window = Window()
        let sent = Counter()
        await withTaskGroup(of: Void.self) { group in
            for await _ in changes {
                let opened = window.note()
                folded()
                guard opened else { continue }
                group.addTask {
                    await sleep(debounce)
                    let n = window.take()
                    guard n > 0, !_Concurrency.Task.isCancelled else { return }
                    sent.add()
                    await emit(event(at: now(), coalesced: n))
                }
            }
        }
        return sent.value
    }

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func add() { lock.withLock { n += 1 } }
        var value: Int { lock.withLock { n } }
    }
}
