import SwiftUI

/// Streaming text fades in by line, not by character (docs/design/ios-app-2026.md §9). A line starts
/// at zero opacity the first time it is drawn and reaches full opacity after `duration`.
final class LineClock: @unchecked Sendable {
    private let lock = NSLock()
    private var firstSeen: [Int: Date] = [:]

    func opacity(forLine index: Int, now: Date, duration: TimeInterval) -> Double {
        lock.lock()
        defer { lock.unlock() }
        let start = firstSeen[index] ?? now
        if firstSeen[index] == nil { firstSeen[index] = now }
        return min(max(now.timeIntervalSince(start) / duration, 0), 1)
    }

    /// True while any line is still fading in.
    func isFading(now: Date, duration: TimeInterval) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return firstSeen.values.contains { now.timeIntervalSince($0) < duration }
    }
}

struct FadeByLineRenderer: TextRenderer {
    let clock: LineClock
    let now: Date
    let duration: TimeInterval

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for (index, line) in layout.enumerated() {
            var lineContext = context
            lineContext.opacity = clock.opacity(forLine: index, now: now, duration: duration)
            lineContext.draw(line)
        }
    }
}

/// A streaming text element: new lines fade in as they wrap into existence. With Reduce Motion on it
/// is plain text.
struct StreamingText: View {
    let text: AttributedString
    @State private var clock = LineClock()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let duration: TimeInterval = 0.35

    var body: some View {
        if reduceMotion {
            Text(text)
        } else {
            TimelineView(.animation) { timeline in
                Text(text)
                    .textRenderer(FadeByLineRenderer(clock: clock, now: timeline.date, duration: duration))
            }
        }
    }
}

/// The still caret at the end of streaming text. Nothing blinks.
let streamingCaret = "\u{258F}"
