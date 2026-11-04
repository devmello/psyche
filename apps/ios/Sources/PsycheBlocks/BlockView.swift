import PsycheDesign
import PsycheStore
import SwiftUI

/// One thread item, drawn natively (docs/design/ios-app-2026.md §5). The `ui` (generative UI) block
/// goes through the WebView host in I8; everything else is here.
public struct BlockView: View {
    private let item: ChatItem
    private let context: BlockContext

    public init(item: ChatItem, context: BlockContext) {
        self.item = item
        self.context = context
    }

    public var body: some View {
        switch item {
        case .user(let id, let text):
            UserBubble(text: text, delivery: context.delivery[id]) { context.retry(id) }
        case .assistant(_, let text, let streaming):
            MarkdownView(text, streaming: streaming)
        case .toolCall(_, let symbol, let summary):
            ToolCallRow(symbol: symbol, summary: summary, arguments: [], result: nil)
        case .toolRun(_, let symbol, let summary, let arguments, let result):
            ToolCallRow(symbol: symbol, summary: summary, arguments: arguments, result: result)
        case .question(let id, let title, let options):
            QuestionCard(
                title: title, options: options, chosen: context.chosen[id], canAnswer: context.canAnswer
            ) { context.choose(id, $0) }
        case .evidence(_, let label, let parts):
            EvidenceLine(label, parts)
        case .progress(_, let kind, let title, let steps):
            ProgressBlock(kind: kind, title: title, steps: steps)
        case .file(_, let title, let fileType, let detail, let libraryID, let isArtifact):
            FileRow(title: title, fileType: fileType, detail: detail, isArtifact: isArtifact, canOpen: libraryID != nil) {
                if let libraryID { context.openFile(libraryID) }
            }
        case .appLink(_, let title, let detail, let route):
            LinkRow(symbol: "arrow.up.forward.app", title: title, detail: detail) { context.openRoute(route) }
        case .relatedThreads(_, let threads):
            RelatedThreadsBlock(threads: threads) { context.openThread($0) }
        case .note(_, let kind, let title, let detail):
            NoteRow(kind: kind, title: title, detail: detail)
        case .approval(_, let item, let resolution):
            ApprovalBlock(item: item, resolution: resolution) { context.openApproval(item) }
        case .unknown(_, let type):
            UnknownBlockRow(type: type)
        }
    }
}

// MARK: - The user's message

struct UserBubble: View {
    let text: String
    let delivery: MessageDelivery?
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(text)
                .font(.callout)
                .foregroundStyle(PsycheColor.text)
                .textSelection(.enabled)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(
                    PsycheColor.fill,
                    in: UnevenRoundedRectangle(
                        topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18,
                        style: .continuous)
                )
                .frame(maxWidth: 290, alignment: .trailing)
            switch delivery {
            case .queued:
                Text("Queued · sends when your Mac is back")
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
            case .failed(let reason):
                HStack(spacing: 6) {
                    StatusDot(.failed, "Didn't send", textColor: PsycheColor.muted)
                    Button("Retry", action: retry)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(PsycheColor.inkText)
                }
                .accessibilityHint(reason)
            case nil:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

// MARK: - Questions

struct QuestionCard: View {
    let title: String
    let options: [ChatOption]
    let chosen: String?
    let canAnswer: Bool
    let choose: (String) -> Void

    var body: some View {
        PaperCard(padding: 14, radius: PsycheMetrics.approvalRadius) {
            VStack(alignment: .leading, spacing: 10) {
                StatusDot(
                    chosen == nil ? .needsYou : .neutral, chosen == nil ? "Psyche is asking" : "You answered",
                    textColor: PsycheColor.muted, font: .footnote.weight(.semibold))
                Text(title).font(.callout.weight(.semibold)).foregroundStyle(PsycheColor.text)
                ForEach(options) { option in
                    OptionButton(option: option, selected: chosen == option.id, dimmed: chosen != nil && chosen != option.id) {
                        choose(option.id)
                    }
                    .disabled(!canAnswer || chosen != nil)
                }
                if !canAnswer, chosen == nil {
                    Text("Reconnect to answer").font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
        }
    }
}

private struct OptionButton: View {
    let option: ChatOption
    let selected: Bool
    let dimmed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.title).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                    Text(option.detail).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.text)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(selected ? PsycheColor.muted : PsycheColor.rule, lineWidth: 1)
            )
            .opacity(dimmed ? 0.5 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Tool calls

/// "Searched mail · 4 results", collapsed; expands to the arguments when there are any.
struct ToolCallRow: View {
    let symbol: String
    let summary: String
    let arguments: [ToolArgument]
    let result: String?
    @State private var expanded = false

    private var expandable: Bool { !arguments.isEmpty || result != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.25)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: symbol).font(.caption).frame(width: 16)
                    Text(summary).font(.subheadline).multilineTextAlignment(.leading)
                    if expandable {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(PsycheColor.muted)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!expandable)
            .accessibilityHint(expandable ? (expanded ? "Hides the arguments" : "Shows the arguments") : "")

            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(arguments) { argument in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(argument.key).foregroundStyle(PsycheColor.muted)
                            Text(argument.value).foregroundStyle(PsycheColor.text).textSelection(.enabled)
                        }
                    }
                    if let result {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("result").foregroundStyle(PsycheColor.muted)
                            Text(result).foregroundStyle(PsycheColor.text).textSelection(.enabled)
                        }
                    }
                }
                .font(.psycheMono(.caption))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(PsycheColor.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .transition(.opacity)
            }
        }
    }
}

// MARK: - Progress (task, plan, checklist)

struct ProgressBlock: View {
    let kind: StepListKind
    let title: String
    let steps: [ProgressStep]
    @State private var showAll = false

    private var doneCount: Int { steps.filter { $0.state == .done }.count }
    private var shown: [ProgressStep] {
        guard !showAll, steps.count > 5 else { return steps }
        // Long lists collapse to the work around the current step.
        let current = steps.firstIndex { $0.state == .running || $0.state == .failed } ?? doneCount
        let start = max(0, min(current - 1, steps.count - 5))
        return Array(steps[start..<(start + 5)])
    }

    var body: some View {
        PaperCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.callout.weight(.semibold)).foregroundStyle(PsycheColor.text)
                    Spacer(minLength: 8)
                    Text("\(doneCount) of \(steps.count)")
                        .font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(shown) { step in
                        HStack(spacing: 10) {
                            StepGlyph(state: step.state)
                            Text(step.title)
                                .font(.subheadline)
                                .foregroundStyle(step.state == .pending ? PsycheColor.muted : PsycheColor.text)
                                .strikethrough(false)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(step.title), \(step.state.rawValue)")
                    }
                }
                if steps.count > 5 {
                    Button(showAll ? "Show fewer" : "Show all \(steps.count)") {
                        withAnimation(.snappy(duration: 0.25)) { showAll.toggle() }
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(PsycheColor.inkText)
                }
            }
        }
    }
}

private struct StepGlyph: View {
    let state: ProgressStep.State

    var body: some View {
        Group {
            switch state {
            case .done:
                CircleCheck(done: true)
            case .pending:
                CircleCheck(done: false)
            case .running:
                ZStack {
                    Circle().strokeBorder(PsycheColor.text, lineWidth: 1.5)
                    Circle().fill(PsycheColor.text).frame(width: 8, height: 8)
                }
                .frame(width: 22, height: 22)
            case .failed:
                ZStack {
                    Circle().fill(PsycheColor.red)
                    Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(PsycheColor.sheet)
                }
                .frame(width: 22, height: 22)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Files and links

struct FileRow: View {
    let title: String
    let fileType: String
    let detail: String
    let isArtifact: Bool
    let canOpen: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Text(fileType.isEmpty ? "FILE" : fileType.uppercased())
                    .font(.psycheMono(.caption2, weight: .semibold))
                    .foregroundStyle(PsycheColor.muted)
                    .frame(width: 40, height: 48)
                    .background(PsycheColor.paper, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(PsycheColor.rule, lineWidth: 1))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text).lineLimit(2)
                    Text(isArtifact && !detail.hasPrefix("Artifact") ? "Artifact · \(detail)" : detail)
                        .font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                }
                Spacer(minLength: 0)
                if canOpen {
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous)
                    .strokeBorder(PsycheColor.hairline, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!canOpen)
    }
}

struct LinkRow: View {
    let symbol: String
    let title: String
    let detail: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.subheadline).foregroundStyle(PsycheColor.inkText).frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.inkText)
                    if !detail.isEmpty {
                        Text(detail).font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct RelatedThreadsBlock: View {
    let threads: [RelatedThread]
    let open: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Related chats").font(.psycheSection).foregroundStyle(PsycheColor.muted)
            PaperCard {
                VStack(spacing: 0) {
                    ForEach(Array(threads.enumerated()), id: \.element.id) { index, thread in
                        if index > 0 { HairlineDivider() }
                        Button { open(thread.id) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(thread.title).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                                    Text(thread.status).font(.footnote).foregroundStyle(PsycheColor.muted)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                            }
                            .padding(PsycheMetrics.rowPadding)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

// MARK: - Simple rows

/// `learned`, `taught`, `wrap_up`, `compaction`, `specialist_result`, `automation_workflow`.
struct NoteRow: View {
    let kind: NoteKind
    let title: String
    let detail: String

    private var symbol: String {
        switch kind {
        case .learned: "lightbulb"
        case .taught: "graduationcap"
        case .wrapUp: "checkmark.seal"
        case .compaction: "archivebox"
        case .specialistResult: "person.crop.circle.badge.checkmark"
        case .automationWorkflow: "gearshape.2"
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol).font(.caption).foregroundStyle(PsycheColor.muted).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                if !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct UnknownBlockRow: View {
    let type: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "desktopcomputer").font(.caption).foregroundStyle(PsycheColor.muted).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text("Open on your Mac").font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                Text(type).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PsycheColor.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityHint("This block can't be shown on the phone yet")
    }
}

// MARK: - Approval

/// The inline approval card: amber hairline while it waits, quiet once answered. It opens the approval
/// sheet; answering happens there, never in the card.
struct ApprovalBlock: View {
    let item: NeedsYouItem
    let resolution: String?
    let open: () -> Void

    var body: some View {
        PaperCard(padding: 14, radius: PsycheMetrics.approvalRadius, border: resolution == nil ? PsycheColor.amber : PsycheColor.hairline) {
            VStack(alignment: .leading, spacing: 8) {
                if let resolution {
                    StatusDot(.done, resolution, textColor: PsycheColor.muted, font: .footnote.weight(.semibold))
                } else {
                    StatusDot(.needsYou, "Needs your OK · \(item.approval?.kindLabel ?? "Approval")", font: .footnote.weight(.semibold))
                }
                Text(item.title).font(.callout.weight(.semibold)).foregroundStyle(PsycheColor.text)
                if let summary = item.approval?.summary {
                    Text(summary).font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                if resolution == nil {
                    Button("Review", action: open)
                        .buttonStyle(.psycheOutline)
                        .padding(.top, 2)
                }
            }
        }
    }
}
