import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

struct ThreadView: View {
    @State private var model: ThreadModel
    @State private var draft = ""
    @FocusState private var composerFocused: Bool
    @Environment(Router.self) private var router
    @Environment(Session.self) private var session

    init(id: String, store: any SnapshotStore) {
        _model = State(initialValue: ThreadModel(id: id, store: store))
    }

    var body: some View {
        ScrollView {
            PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { thread in
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(thread.items + model.sent) { item in
                        ItemView(item: item, chosen: model.chosen, canAnswer: session.state.canAnswer) { question, option in
                            model.choose(option: option, for: question)
                        }
                    }
                }
                .padding(.horizontal, PsycheMetrics.pagePadding)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
        }
        .defaultScrollAnchor(.bottom)
        .psycheScreen()
        .navigationTitle(model.phase.value?.title ?? "")
        .navigationSubtitle(model.phase.value?.status ?? "")
        .psycheInlineTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) { AgentButton(needsYou: false) }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .task {
            await model.load()
            if let pending = router.pendingDraft {
                draft = pending
                router.pendingDraft = nil
                composerFocused = true
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            HStack(alignment: .bottom, spacing: 6) {
                TextField("Reply to Psyche", text: $draft, axis: .vertical)
                    .font(.callout)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .padding(.vertical, 13)
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(PsycheColor.ink, in: Circle())
                }
                .padding(.bottom, 6)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                .accessibilityLabel("Send")
            }
            .padding(.leading, 18)
            .padding(.trailing, 6)
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private func send() {
        model.send(draft)
        draft = ""
    }
}

private struct ItemView: View {
    let item: ChatItem
    let chosen: [String: String]
    let canAnswer: Bool
    let choose: (String, String) -> Void

    var body: some View {
        switch item {
        case .user(_, let text):
            Text(text)
                .font(.callout)
                .foregroundStyle(PsycheColor.text)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(
                    PsycheColor.fill,
                    in: UnevenRoundedRectangle(
                        topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18,
                        style: .continuous)
                )
                .frame(maxWidth: 290, alignment: .trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant(_, let text, let streaming):
            Group {
                if streaming {
                    // A still cursor: streaming fades in by line, and nothing blinks (Reduce Motion).
                    Text("\(text)\u{258F}")
                } else {
                    Text(text)
                }
            }
            .font(.callout)
            .lineSpacing(3)
            .foregroundStyle(PsycheColor.text)
        case .toolCall(_, let symbol, let summary):
            Label {
                Text(summary).font(.subheadline)
            } icon: {
                Image(systemName: symbol).font(.caption)
            }
            .foregroundStyle(PsycheColor.muted)
            .padding(.vertical, 2)
        case .question(let id, let title, let options):
            PaperCard(padding: 14, radius: PsycheMetrics.approvalRadius) {
                VStack(alignment: .leading, spacing: 10) {
                    StatusDot(.needsYou, "Psyche is asking", textColor: PsycheColor.muted, font: .footnote.weight(.semibold))
                    Text(title).font(.callout.weight(.semibold)).foregroundStyle(PsycheColor.text)
                    ForEach(options) { option in
                        OptionButton(
                            option: option, selected: chosen[id] == option.id,
                            dimmed: chosen[id] != nil && chosen[id] != option.id
                        ) { choose(id, option.id) }
                        .disabled(!canAnswer || chosen[id] != nil)
                    }
                    if !canAnswer {
                        Text("Reconnect to answer").font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
        case .evidence(_, let label, let parts):
            EvidenceLine(label, parts)
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
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(PsycheColor.rule, lineWidth: 1))
            .opacity(dimmed ? 0.5 : 1)
        }
        .buttonStyle(.plain)
    }
}
