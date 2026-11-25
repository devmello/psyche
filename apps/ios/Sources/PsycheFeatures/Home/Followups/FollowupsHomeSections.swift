import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Home's "Follow-ups" (quiet email threads) and "Suggestions" (batch proposals), a page behind More. Each section is
/// drawn only when it has something to show. Approve is one plain tap; Undo sits on an approved suggestion for 30 seconds.
struct FollowupsHomeSections: View {
    @State private var model: FollowupsModel
    @State private var open: Suggestion?
    @Environment(Session.self) private var session
    @Environment(Router.self) private var router
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
        _model = State(initialValue: FollowupsModel(store: store))
    }

    var body: some View {
        List {
            if model.followups.isEmpty && model.suggestions.isEmpty && model.undoable.isEmpty {
                ContentUnavailableView {
                    Label(String(localized: "No follow-ups", bundle: .module), systemImage: "arrowshape.turn.up.left")
                } description: {
                    Text("Quiet email threads and Psyche's suggestions show up here.", bundle: .module)
                }
                .listRowBackground(Color.clear)
            }
            if !model.followups.isEmpty { followUps(model.followups) }
            if !model.suggestions.isEmpty || !model.undoable.isEmpty { suggestions }
            if let error = model.error {
                Section { Text(error).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .homeListStyle()
        .navigationTitle(String(localized: "Follow-ups", bundle: .module))
        .psycheInlineTitle()
        .refreshable { await model.load() }
        .task {
            await model.load()
            await model.observe()
        }
        .sheet(item: $open, onDismiss: { router.runDeferredOpen() }) { suggestion in
            SuggestionSheet(suggestion: suggestion, model: model, canAnswer: session.state.canAnswer, store: store)
                .presentationDetents([.medium, .large])
        }
    }

    // MARK: Follow-ups

    private func followUps(_ items: [MailFollowup]) -> some View {
        Section {
            ForEach(items) { item in followUpRow(item) }
        } header: {
            Text("Follow-ups", bundle: .module)
        }
    }

    private func followUpRow(_ item: MailFollowup) -> some View {
        let who = item.who.isEmpty ? String(localized: "Someone", bundle: .module) : item.who
        let days = item.daysQuiet
        let line: String = switch item.kind {
        case .noReply: String(localized: "\(who) hasn’t replied in \(days) days", bundle: .module)
        case .unansweredQuestion: String(localized: "\(who) asked you something \(days) days ago", bundle: .module)
        }
        let enabled = !model.busy.contains(item.id) && session.state.canAnswer
        return VStack(alignment: .leading, spacing: 3) {
            Text(line).font(.body)
            Text(item.subject).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { Task { await model.act(on: item, .dismiss) } } label: {
                Label(String(localized: "Dismiss", bundle: .module), systemImage: "xmark")
            }
            .disabled(!enabled)
            Button { Task { await model.act(on: item, .snooze) } } label: {
                Label(String(localized: "Snooze", bundle: .module), systemImage: "moon.zzz")
            }
            .tint(.indigo)
            .disabled(!enabled)
        }
        .contextMenu {
            Button { Task { await model.act(on: item, .snooze) } } label: {
                Label(String(localized: "Snooze", bundle: .module), systemImage: "moon.zzz")
            }
            Button(role: .destructive) { Task { await model.act(on: item, .dismiss) } } label: {
                Label(String(localized: "Dismiss", bundle: .module), systemImage: "xmark")
            }
        }
        .disabled(!enabled)
        .accessibilityElement(children: .contain)
    }

    // MARK: Suggestions

    private var suggestions: some View {
        let now = Date.now
        return Section {
            ForEach(model.openUndo(at: now)) { window in doneRow(window) }
            ForEach(model.suggestions) { suggestion in suggestionRow(suggestion) }
        } header: {
            Text("Suggestions", bundle: .module)
        }
    }

    private func suggestionRow(_ suggestion: Suggestion) -> some View {
        let enabled = !model.busy.contains(suggestion.id) && session.state.canAnswer
        return Button { open = suggestion } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(suggestion.title).font(.body).multilineTextAlignment(.leading)
                Text(why(suggestion)).font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Approve opens the sheet, where every call is on screen before the one tap.
        .swipeActions(edge: .leading) {
            Button { open = suggestion } label: {
                Label(String(localized: "Approve", bundle: .module), systemImage: "checkmark")
            }
            .tint(.accentColor)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { Task { await model.dismiss(suggestion) } } label: {
                Label(String(localized: "Dismiss", bundle: .module), systemImage: "xmark")
            }
        }
        .contextMenu {
            Button { open = suggestion } label: {
                Label(String(localized: "Approve", bundle: .module), systemImage: "checkmark")
            }
            Button(role: .destructive) { Task { await model.dismiss(suggestion) } } label: {
                Label(String(localized: "Dismiss", bundle: .module), systemImage: "xmark")
            }
        }
        .disabled(!enabled)
    }

    /// An approved suggestion, with Undo while its window is open.
    private func doneRow(_ window: FollowupsModel.UndoWindow) -> some View {
        let waiting = model.busy.contains(window.id)
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(window.suggestion.title).font(.body)
                Text("Done", bundle: .module).font(.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if window.suggestion.canUndo {
                Button(String(localized: "Undo", bundle: .module)) {
                    Task { await model.undo(window) }
                }
                .buttonStyle(.borderless)
                .disabled(waiting || !session.state.canAnswer)
            }
        }
    }

    private func why(_ suggestion: Suggestion) -> String {
        suggestion.fromOutsideContent
            ? String(localized: "From your mail", bundle: .module)
            : String(localized: "From what Psyche noticed", bundle: .module)
    }
}

/// A suggestion's full list of calls, read before Approve. It reloads the suggestion so its status is the Gateway's.
private struct SuggestionSheet: View {
    let suggestion: Suggestion
    let model: FollowupsModel
    let canAnswer: Bool
    let store: any PsycheBackend
    @State private var current: Suggestion?
    @Environment(\.dismiss) private var dismiss
    @Environment(Router.self) private var router

    var body: some View {
        let shown = current ?? suggestion
        let open = shown.status == .pending || shown.status == .awaitingApproval
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(shown.title).font(.psycheRow.weight(.semibold)).foregroundStyle(PsycheColor.text)
                EvidenceLine([shown.fromOutsideContent
                    ? String(localized: "From your mail", bundle: .module)
                    : String(localized: "From what Psyche noticed", bundle: .module)])
                SectionHeader(String(localized: "Actions in this batch", bundle: .module), count: shown.callSummaries.count)
                PaperCard {
                    ForEach(Array(shown.callSummaries.enumerated()), id: \.offset) { index, summary in
                        if index > 0 { HairlineDivider() }
                        Text(summary)
                            .font(.psycheRow)
                            .foregroundStyle(PsycheColor.text)
                            .padding(PsycheMetrics.rowPadding)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if open {
                    HStack(spacing: 20) {
                        Button(String(localized: "Approve", bundle: .module)) {
                            Task {
                                // A payment the phone must not answer goes to the approval sheet, with its Touch ID rules.
                                let handoff = await model.approve(shown)
                                // The suggestion sheet's onDismiss opens the approval once this sheet is gone.
                                if let handoff { router.deferOpen(handoff) }
                                dismiss()
                            }
                        }
                        .foregroundStyle(PsycheColor.inkText)
                        Button(String(localized: "Dismiss", bundle: .module)) {
                            Task {
                                await model.dismiss(shown)
                                dismiss()
                            }
                        }
                        .foregroundStyle(PsycheColor.muted)
                    }
                    .font(.subheadline.weight(.medium))
                    .buttonStyle(.plain)
                    .disabled(!canAnswer)
                }
            }
            .padding(PsycheMetrics.pagePadding)
        }
        .task { current = try? await store.suggestion(id: suggestion.id) }
    }
}
