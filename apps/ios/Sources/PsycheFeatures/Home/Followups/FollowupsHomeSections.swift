import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Home's "Follow-ups" (quiet email threads) and "Suggestions" (batch proposals) sections. Each is drawn only when it
/// has something to show. Approve is one plain tap; Undo sits on an approved suggestion for 30 seconds.
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
        VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
            if !model.followups.isEmpty { followUps(model.followups) }
            if !model.suggestions.isEmpty || !model.undoable.isEmpty { suggestions }
            if let error = model.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(PsycheColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
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
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Follow-ups", bundle: .module), count: items.count)
            PaperCard {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HairlineDivider() }
                    followUpRow(item)
                }
            }
        }
    }

    private func followUpRow(_ item: MailFollowup) -> some View {
        let who = item.who.isEmpty ? String(localized: "Someone", bundle: .module) : item.who
        let days = item.daysQuiet
        let line: String = switch item.kind {
        case .noReply: String(localized: "\(who) hasn’t replied in \(days) days", bundle: .module)
        case .unansweredQuestion: String(localized: "\(who) asked you something \(days) days ago", bundle: .module)
        }
        let waiting = model.busy.contains(item.id)
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(line).font(.psycheRow).foregroundStyle(PsycheColor.text)
                Text(item.subject)
                    .font(.subheadline)
                    .foregroundStyle(PsycheColor.muted)
                    .lineLimit(1)
            }
            HStack(spacing: 20) {
                Button(String(localized: "Snooze", bundle: .module)) {
                    Task { await model.act(on: item, .snooze) }
                }
                Button(String(localized: "Dismiss", bundle: .module)) {
                    Task { await model.act(on: item, .dismiss) }
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(PsycheColor.muted)
            .buttonStyle(.plain)
            .disabled(waiting || !session.state.canAnswer)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    // MARK: Suggestions

    private var suggestions: some View {
        let now = Date.now
        return VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Suggestions", bundle: .module), count: model.suggestions.count)
            PaperCard {
                ForEach(Array(model.openUndo(at: now).enumerated()), id: \.element.id) { index, window in
                    if index > 0 { HairlineDivider() }
                    doneRow(window)
                }
                ForEach(Array(model.suggestions.enumerated()), id: \.element.id) { index, suggestion in
                    if index > 0 || !model.openUndo(at: now).isEmpty { HairlineDivider() }
                    suggestionRow(suggestion)
                }
            }
        }
    }

    private func suggestionRow(_ suggestion: Suggestion) -> some View {
        let waiting = model.busy.contains(suggestion.id)
        return VStack(alignment: .leading, spacing: 10) {
            Button { open = suggestion } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(suggestion.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    EvidenceLine([why(suggestion)])
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            HStack(spacing: 20) {
                // Approve opens the sheet, where every call is on screen before the one tap.
                Button(String(localized: "Approve", bundle: .module)) { open = suggestion }
                    .foregroundStyle(PsycheColor.inkText)
                Button(String(localized: "Dismiss", bundle: .module)) {
                    Task { await model.dismiss(suggestion) }
                }
                .foregroundStyle(PsycheColor.muted)
            }
            .font(.subheadline.weight(.medium))
            .buttonStyle(.plain)
            .disabled(waiting || !session.state.canAnswer)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// An approved suggestion, with Undo while its window is open.
    private func doneRow(_ window: FollowupsModel.UndoWindow) -> some View {
        let waiting = model.busy.contains(window.id)
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(window.suggestion.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                EvidenceLine([String(localized: "Done", bundle: .module)])
            }
            Spacer(minLength: 0)
            if window.suggestion.canUndo {
                Button(String(localized: "Undo", bundle: .module)) {
                    Task { await model.undo(window) }
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(PsycheColor.muted)
                .buttonStyle(.plain)
                .disabled(waiting || !session.state.canAnswer)
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
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
