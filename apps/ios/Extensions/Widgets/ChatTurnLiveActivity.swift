import ActivityKit
import PsycheShared
import SwiftUI
import WidgetKit

// The Lock Screen and Dynamic Island views for a chat reply that runs long. Same look as the task activity
// (always dark, ink-blue moth, no gradients), same freshness rule: once the stale date passes, the views say so.
// The timer is `Text(timerInterval:)`, so it counts on its own with no pushes.

struct ChatTurnLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PsycheChatTurnAttributes.self) { context in
            ChatTurnLockScreenView(content: context.state, isStale: context.isStale)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .activityBackgroundTint(LA.card)
                .activitySystemActionForegroundColor(LA.text)
                .widgetURL(ChatTurnContent.url(forThread: context.attributes.threadID))
        } dynamicIsland: { context in
            let content = context.state
            let isStale = context.isStale
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    LA.moth(24).padding(.leading, 8)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ChatElapsedText(content: content, size: 14, isStale: isStale).padding(.trailing, 8)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ChatTurnIslandBody(content: content, isStale: isStale)
                        .padding(.horizontal, 8)
                }
            } compactLeading: {
                LA.moth(16).padding(.leading, 4)
            } compactTrailing: {
                ChatCompactTrailing(content: content, isStale: isStale).padding(.trailing, 6)
            } minimal: {
                ChatMinimal(content: content, isStale: isStale)
            }
            .keylineTint(LA.muted)
            .widgetURL(ChatTurnContent.url(forThread: context.attributes.threadID))
        }
    }
}

// MARK: - Words

extension ChatTurnPhase {
    /// The phase in the owner's language; the status line when the chat has no more specific line to show.
    var label: LocalizedStringKey {
        switch self {
        case .thinking: "Thinking"
        case .writing: "Writing a reply"
        case .working: "Working"
        case .waiting: "Waiting for you"
        case .done: "Reply ready"
        case .failed: "Reply failed"
        }
    }

    var dot: Color? {
        switch self {
        case .waiting: LA.amber
        case .done: LA.green
        case .failed: LA.red
        default: nil
        }
    }
}

// MARK: - Lock Screen

struct ChatTurnLockScreenView: View {
    let content: ChatTurnContent
    let isStale: Bool
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let (title, detail) = content.lockScreenText(locked: redaction.contains(.privacy))
        let isPrivate = content.title == nil
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 10) {
                    LA.moth(24)
                    Group {
                        if let title { Text(verbatim: title) } else { Text("Psyche is replying") }
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(LA.text)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .privacySensitive(isPrivate && title != nil)
                    Spacer(minLength: 8)
                    ChatElapsedText(content: content, size: 14, isStale: isStale)
                }
                if let detail, !isStale, !content.phase.isEnded {
                    Text(verbatim: detail)
                        .font(.system(size: 13))
                        .foregroundStyle(LA.muted)
                        .lineLimit(1)
                        .padding(.leading, 34)
                        .privacySensitive(isPrivate)
                }
            }
            ChatStatusLine(content: content, isStale: isStale)
        }
    }
}

/// "Thinking", "Writing a reply", "Waiting for you", "Reply ready": a dot for the states that have a color.
struct ChatStatusLine: View {
    let content: ChatTurnContent
    let isStale: Bool

    var body: some View {
        if ChatTurnPresentation(content: content, isStale: isStale).showsStaleNotice {
            StaleNotice(size: 13)
        } else {
            HStack(spacing: 6) {
                if let dot = content.phase.dot {
                    Circle().fill(dot).frame(width: 7, height: 7)
                }
                Text(content.phase.label)
                    .font(.system(size: 13))
                    .foregroundStyle(content.phase == .waiting ? LA.amber : LA.muted)
            }
        }
    }
}

/// Elapsed time in mono: counting from `startedAt`, and stopped at `endedAt` once the reply ends.
struct ChatElapsedText: View {
    let content: ChatTurnContent
    let size: CGFloat
    var isStale: Bool = false

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
        .opacity(isStale && content.endedAt == nil ? 0.5 : 1)
    }
}

// MARK: - Dynamic Island

private struct ChatTurnIslandBody: View {
    let content: ChatTurnContent
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let title = content.islandTitle ?? content.title { Text(verbatim: title) } else { Text("Psyche is replying") }
            }
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(LA.text)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            if ChatTurnPresentation(content: content, isStale: isStale).showsStaleNotice {
                StaleNotice(size: 13)
            } else {
                if let detail = content.detail, !content.phase.isEnded {
                    Text(verbatim: detail)
                        .font(.system(size: 13))
                        .foregroundStyle(LA.muted)
                        .lineLimit(2)
                }
                ChatStatusLine(content: content, isStale: isStale)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ChatCompactTrailing: View {
    let content: ChatTurnContent
    let isStale: Bool

    var body: some View {
        if ChatTurnPresentation(content: content, isStale: isStale).showsStaleNotice {
            Image(systemName: "exclamationmark.circle").font(.system(size: 13, weight: .medium)).foregroundStyle(LA.muted)
                .accessibilityLabel("May be out of date")
        } else {
            switch content.phase {
            case .done:
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(LA.green)
                    .accessibilityLabel(Text("Reply ready"))
            case .failed:
                Image(systemName: "exclamationmark").font(.system(size: 12, weight: .bold)).foregroundStyle(LA.red)
                    .accessibilityLabel(Text("Reply failed"))
            default:
                ChatElapsedText(content: content, size: 13).frame(width: 44)
            }
        }
    }
}

private struct ChatMinimal: View {
    let content: ChatTurnContent
    let isStale: Bool

    var body: some View {
        let ringTint: Color = {
            if isStale && !content.phase.isEnded { return LA.muted }
            return content.phase.dot ?? LA.wings
        }()
        ZStack {
            Circle().stroke(ringTint, lineWidth: 2)
            LA.moth(12)
        }
        .padding(1)
        .frame(width: 22, height: 22)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(content.phase.label))
    }
}
