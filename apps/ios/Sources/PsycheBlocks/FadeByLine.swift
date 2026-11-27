import PsycheDesign
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
    /// The text whose last line has finished fading. While `text` equals it nothing animates, so the display-rate
    /// timeline is dropped for plain text: a stream that pauses (a tool call, a slow token) costs no frames. A new
    /// token makes them differ again in the same pass, so the timeline is back before the new line is first drawn.
    @State private var settled: AttributedString?
    private let motion = MotionContext()
    /// Opacity only: a new line never moves or scales (spec §4.6).
    private let duration: TimeInterval = PsycheMotion.Duration.medium

    var body: some View {
        if motion.reduced || settled == text {
            Text(text)
        } else {
            TimelineView(.animation) { timeline in
                Text(text)
                    .textRenderer(FadeByLineRenderer(clock: clock, now: timeline.date, duration: duration))
            }
            // Restarts on every text change; the wait covers the fade plus a frame of slack, so the last
            // frame drawn is the fully faded one.
            .task(id: text) {
                try? await Task.sleep(for: .seconds(duration + StreamingFadeRules.slack))
                guard !Task.isCancelled else { return }
                settled = text
            }
        }
    }
}

enum StreamingFadeRules {
    /// Extra time after the fade before the timeline stops.
    static let slack: TimeInterval = 0.1
}

/// The still caret at the end of streaming text. Nothing blinks.
let streamingCaret = "\u{258F}"
