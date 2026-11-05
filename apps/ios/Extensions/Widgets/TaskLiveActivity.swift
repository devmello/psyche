import ActivityKit
import PsycheDesign
import PsycheShared
import SwiftUI
import WidgetKit

// The Lock Screen and Dynamic Island views for a running task (docs/design/ios-app-2026.md §9, mockup
// LockScreen.dc.html). The Lock Screen card and the Island are always dark, so the colors here are fixed
// instead of following the app's asset colors. Amber appears only for "Needs approval". No gradients.
//
// The owner's pick from the design options (2026-11-04): the ring from B for the compact and minimal island,
// A's expanded layout and Lock Screen card, and E's inline Deny and Approve for approvals that may be answered
// from the island. Presence-gated approvals keep "Review…".

private enum LA {
    static let card = Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x16 / 255)
    static let text = Color(red: 0xEF / 255, green: 0xEE / 255, blue: 0xEC / 255)
    static let muted = Color(red: 0xB6 / 255, green: 0xB4 / 255, blue: 0xB1 / 255)
    static let track = Color.white.opacity(0.2)
    static let amber = Color(red: 1, green: 0xC5 / 255, blue: 0x3D / 255)
    static let green = Color(red: 0x71 / 255, green: 0xD0 / 255, blue: 0x83 / 255)
    static let red = Color(red: 0xFF / 255, green: 0x91 / 255, blue: 0x7B / 255)
    static let wings = Color(red: 0x9A / 255, green: 0xB9 / 255, blue: 0xE9 / 255)
    static let lowerWings = Color(red: 0x6F / 255, green: 0x93 / 255, blue: 0xCC / 255)
    /// Ink lifted for a dark surface: the Approve button.
    static let ink = Color(red: 0x37 / 255, green: 0x66 / 255, blue: 0xAD / 255)
    static let graphite = Color(red: 0x2A / 255, green: 0x2A / 255, blue: 0x2D / 255)

    static func moth(_ size: CGFloat) -> some View {
        MothMark(size: size, wings: wings, lowerWings: lowerWings, body: text)
    }

    static func dot(for status: TaskActivityStatus) -> Color? {
        switch status {
        case .running: nil
        case .needsApproval: amber
        case .done: green
        case .failed: red
        }
    }
}

struct TaskLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PsycheTaskAttributes.self) { context in
            TaskLockScreenView(content: context.state)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .activityBackgroundTint(LA.card)
                .activitySystemActionForegroundColor(LA.text)
                .widgetURL(TaskActivityContent.url(forTask: context.attributes.taskID))
        } dynamicIsland: { context in
            let content = context.state
            let url = TaskActivityContent.url(forTask: context.attributes.taskID)
            return DynamicIsland {
                // Expanded (long-press, unlocked only): what the task is, what it's doing now, and how far along.
                // Top row beside the camera: the moth and the elapsed time. Everything that needs width (the
                // title, what it's doing, the bar) goes in the full-width bottom region.
                DynamicIslandExpandedRegion(.leading) {
                    LA.moth(24).padding(.leading, 8)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ElapsedText(content: content, size: 14).padding(.trailing, 8)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 10) {
                        IslandHeadline(content: content)
                        IslandFooter(content: content, url: url)
                    }
                    .padding(.horizontal, 8)
                }
            } compactLeading: {
                ProgressRing(content: content, diameter: 24, lineWidth: 2.5, moth: 12)
                    .padding(.leading, 4)
            } compactTrailing: {
                // Inset from the pill's rounded end so the timer doesn't crowd the edge.
                CompactTrailing(content: content)
                    .padding(.trailing, 6)
            } minimal: {
                ProgressRing(content: content, diameter: 22, lineWidth: 2, moth: 12)
            }
            .keylineTint(content.status == .needsApproval ? LA.amber : LA.muted)
            .widgetURL(TaskActivityContent.url(forTask: context.attributes.taskID))
        }
    }
}

// MARK: - Lock Screen

struct TaskLockScreenView: View {
    let content: TaskActivityContent

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                LA.moth(24)
                Text(content.title ?? "Psyche is working")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(LA.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                ElapsedText(content: content, size: 14)
            }
            if content.hasStepCount {
                SegmentBar(content: content)
            }
            StatusLine(content: content)
        }
    }
}

/// "Step 3 of 7 · running", "Running", "Needs approval". A dot for the states that have a color; amber is
/// for needs-approval only.
struct StatusLine: View {
    let content: TaskActivityContent

    var body: some View {
        HStack(spacing: 6) {
            if let dot = LA.dot(for: content.status) {
                Circle().fill(dot).frame(width: 7, height: 7)
            }
            Text(content.statusLine)
                .font(.system(size: 13))
                .foregroundStyle(content.status == .needsApproval ? LA.amber : LA.muted)
        }
    }
}

/// Graphite segments: finished ones bright-gray, the current one white (amber when it needs approval), the
/// rest a dim track.
struct SegmentBar: View {
    let content: TaskActivityContent

    var body: some View {
        let (total, finished) = content.segments
        HStack(spacing: 4) {
            ForEach(0..<total, id: \.self) { index in
                RoundedRectangle(cornerRadius: 2.5)
                    .fill(color(for: index, finished: finished))
                    .frame(height: 5)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(content.statusLine)
    }

    private func color(for index: Int, finished: Int) -> Color {
        if index < finished { return LA.muted }
        if index == finished && content.status != .done && content.status != .failed {
            return content.status == .needsApproval ? LA.amber : LA.text
        }
        return LA.track
    }
}

/// Elapsed time in mono, counting up from `startedAt` until the task ends.
struct ElapsedText: View {
    let content: TaskActivityContent
    let size: CGFloat

    var body: some View {
        Group {
            if let ended = content.endedAt {
                Text(timerInterval: content.startedAt...max(ended, content.startedAt), pauseTime: ended, countsDown: false)
            } else {
                Text(timerInterval: content.startedAt...content.startedAt.addingTimeInterval(8 * 3600), countsDown: false)
            }
        }
        .font(.system(size: size, weight: .medium, design: .monospaced))
        .monospacedDigit()
        .foregroundStyle(LA.muted)
        .multilineTextAlignment(.trailing)
        .frame(minWidth: size * 4, alignment: .trailing)
    }
}

// MARK: - Dynamic Island

/// The expanded island's headline: the task's title, and a line under it — what it's asking
/// for (amber) when it needs you, otherwise what the current step is doing.
private struct IslandHeadline: View {
    let content: TaskActivityContent

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(content.islandTitle ?? content.title ?? "Psyche is working")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(LA.text)
                .lineLimit(content.answersInline ? 1 : 2)
                .fixedSize(horizontal: false, vertical: true)
            if let line = content.asking ?? content.detail {
                Text(line)
                    .font(.system(size: 13))
                    .foregroundStyle(content.asking != nil ? LA.amber : LA.muted)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The expanded island's bottom: the segmented bar, then "Step 3 of 7" and the status (or Review).
private struct IslandFooter: View {
    let content: TaskActivityContent
    let url: URL?

    var body: some View {
        VStack(spacing: 9) {
            if content.hasStepCount { SegmentBar(content: content) }
            if content.answersInline, let id = content.inlineApprovalID {
                // The island is only so tall: the buttons take the step row's place. The amber question above
                // and the amber segment already say it needs you.
                InlineAnswerButtons(approvalID: id)
            } else {
                stepRow
            }
        }
    }

    private var stepRow: some View {
        HStack(spacing: 8) {
            if let step = content.stepLabel {
                Text(step)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(LA.muted)
            }
            Spacer(minLength: 8)
            if content.status == .needsApproval, let url {
                Link(destination: url) {
                    Text("Review…")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(LA.card)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(LA.amber, in: Capsule())
                }
                .accessibilityLabel("Review the approval in Psyche")
            } else {
                HStack(spacing: 5) {
                    if let dot = LA.dot(for: content.status) {
                        Circle().fill(dot).frame(width: 6, height: 6)
                    }
                    Text(content.statusWord)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(LA.muted)
                }
            }
        }
    }
}

/// E: Deny and Approve right in the expanded island, for a plain write approval only. The app answers in the
/// background over the live connection (never queued) and re-checks the id first; Face ID-gated approvals never
/// get here.
private struct InlineAnswerButtons: View {
    let approvalID: String

    var body: some View {
        HStack(spacing: 10) {
            Button(intent: AnswerApprovalIntent(approvalID: approvalID, approve: false)) {
                Text("Deny")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(LA.text)
                    .frame(maxWidth: .infinity, minHeight: 34)
                    .background(LA.graphite, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Deny")
            Button(intent: AnswerApprovalIntent(approvalID: approvalID, approve: true)) {
                Text("Approve")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 34)
                    .background(LA.ink, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Approve")
        }
    }
}

private struct CompactTrailing: View {
    let content: TaskActivityContent

    var body: some View {
        switch content.status {
        case .needsApproval:
            HStack(spacing: 4) {
                Circle().fill(LA.amber).frame(width: 7, height: 7)
                Text("OK?").font(.system(size: 13, weight: .semibold)).foregroundStyle(LA.amber)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Needs your OK")
        case .done:
            Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(LA.green)
                .accessibilityLabel("Done")
        case .failed:
            Image(systemName: "exclamationmark").font(.system(size: 12, weight: .bold)).foregroundStyle(LA.red)
                .accessibilityLabel("Failed")
        case .running:
            // The ring on the left already says how far; the right says how long.
            ElapsedText(content: content, size: 13).frame(width: 44)
        }
    }
}

/// B: the moth inside a thin progress ring, for the compact pill and the minimal view (when another app's
/// activity shares the island). Ink-blue while running, amber when it needs you, green or red once it ends.
/// With no step count the ring is a full track, closed in amber when it needs you.
private struct ProgressRing: View {
    let content: TaskActivityContent
    let diameter: CGFloat
    let lineWidth: CGFloat
    let moth: CGFloat

    private var tint: Color {
        switch content.status {
        case .running: LA.wings
        case .needsApproval: LA.amber
        case .done: LA.green
        case .failed: LA.red
        }
    }

    private var trim: Double {
        switch content.status {
        case .done, .failed: 1
        case .needsApproval: content.fraction.map { max($0, 0.04) } ?? 1
        case .running: content.fraction.map { max($0, 0.04) } ?? 0
        }
    }

    var body: some View {
        ZStack {
            Circle().stroke(LA.track, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: trim)
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            LA.moth(moth)
        }
        .padding(lineWidth / 2)
        .frame(width: diameter, height: diameter)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(content.stepLabel.map { "\($0), \(content.statusWord)" } ?? content.statusWord)
    }
}
