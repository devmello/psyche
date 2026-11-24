import PsycheDesign
import PsycheStore
import SwiftUI

// The Memory tab's learning screens: "What Psyche learned" (lessons, with detail, Edit, Confirm and Forget),
// "To confirm" (claims Psyche is unsure of), "Recent changes" (automatic changes, with Undo) and the quick
// "Remember this" note. Every destructive action asks first, with an explicit Cancel. Approvals are plain taps.

/// Confidence in words, the Mac's wording (memoryReview.confidence).
private func confidenceLabel(_ value: Double) -> String {
    if value >= 0.75 { return String(localized: "Confident", bundle: .module) }
    if value >= 0.4 { return String(localized: "Fairly sure", bundle: .module) }
    return String(localized: "Unsure", bundle: .module)
}

// MARK: - What Psyche learned

/// The lessons list. Each row pushes its detail (a `LessonItem` value on this stack).
struct LessonsView: View {
    @State private var model: LearningModel

    init(store: any PsycheBackend) {
        _model = State(initialValue: LearningModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("What Psyche learned", bundle: .module).psycheTitle().padding(.bottom, 4)
                Text("Lessons from your corrections. Keep one, change its wording, or forget it.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted).padding(.bottom, 16)
                content
            }
            .padding(PsycheMetrics.pagePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .task { await model.loadLessons() }
        .navigationDestination(for: LessonItem.self) { lesson in
            LessonDetailView(id: lesson.id, fallback: lesson, model: model)
        }
        .alert(String(localized: "Couldn't update that", bundle: .module), isPresented: noticeBinding) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
    }

    private var noticeBinding: Binding<Bool> {
        Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
    }

    @ViewBuilder
    private var content: some View {
        switch model.lessons {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
        case .failed(let message):
            LearningRetry(message: message) { Task { await model.loadLessons() } }
        case .loaded(let lessons) where lessons.isEmpty:
            Text("Nothing has been learned yet.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        case .loaded(let lessons):
            ForEach(Array(lessons.enumerated()), id: \.element.id) { index, lesson in
                NavigationLink(value: lesson) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: lesson.statement).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                .multilineTextAlignment(.leading)
                            Text(verbatim: lesson.confirmed
                                ? String(localized: "Kept", bundle: .module)
                                : confidenceLabel(lesson.confidence))
                                .font(.caption).foregroundStyle(PsycheColor.muted)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                    }
                    .padding(PsycheMetrics.rowPadding)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .cardRow(CardPosition(index: index, count: lessons.count))
            }
        }
    }
}

/// One lesson: the line Psyche wrote, what it replaced, and the owner's actions. Forget asks first.
struct LessonDetailView: View {
    let id: String
    let fallback: LessonItem
    let model: LearningModel
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var confirmingForget = false

    /// The lesson as the list has it now; the one it was opened with once it is gone from the list.
    private var lesson: LessonItem { model.lesson(id: id) ?? fallback }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(verbatim: lesson.statement).font(.title3.weight(.semibold)).foregroundStyle(PsycheColor.text)
                    .textSelection(.enabled)
                VStack(alignment: .leading, spacing: 4) {
                    Text("The change", bundle: .module).font(.caption.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                    if let previous = lesson.previous {
                        Text(verbatim: previous).font(.body).foregroundStyle(PsycheColor.muted).strikethrough()
                    }
                    Text(verbatim: lesson.value).font(.body).foregroundStyle(PsycheColor.text).textSelection(.enabled)
                }
                Text(verbatim: lesson.confirmed
                    ? String(localized: "Kept. Psyche is sure of this now.", bundle: .module)
                    : confidenceLabel(lesson.confidence))
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
                HStack(spacing: 10) {
                    if !lesson.confirmed {
                        Button(String(localized: "Keep", bundle: .module)) { Task { await model.confirm(lesson) } }
                            .buttonStyle(.psycheOutline)
                    }
                    Button(String(localized: "Forget", bundle: .module), role: .destructive) { confirmingForget = true }
                        .buttonStyle(.psycheOutline)
                }
            }
            .padding(PsycheMetrics.pagePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(String(localized: "Edit", bundle: .module)) { editing = true }
            }
        }
        .sheet(isPresented: $editing) {
            LessonEditSheet(lesson: lesson) { value in try await model.edit(lesson, value: value) }
        }
        .confirmationDialog(
            String(localized: "Forget this lesson?", bundle: .module), isPresented: $confirmingForget,
            titleVisibility: .visible
        ) {
            Button(String(localized: "Forget", bundle: .module), role: .destructive) {
                Task {
                    await model.forget(lesson)
                    dismiss()
                }
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text("The line goes back to what it was before.", bundle: .module)
        }
    }
}

/// The owner's own wording for a lesson. A refusal stays on the sheet in the Gateway's words.
struct LessonEditSheet: View {
    let lesson: LessonItem
    let save: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var saving = false
    @State private var failure: String?

    init(lesson: LessonItem, save: @escaping (String) async throws -> Void) {
        self.lesson = lesson
        self.save = save
        _text = State(initialValue: lesson.value)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSave: Bool {
        !saving && !trimmed.isEmpty && trimmed != lesson.value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "The lesson's line", bundle: .module), text: $text, axis: .vertical)
                        .lineLimit(1...6)
                } footer: {
                    if let failure {
                        Text(verbatim: failure).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
            .navigationTitle(String(localized: "Edit lesson", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save", bundle: .module)) { Task { await submit() } }.disabled(!canSave)
                }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private func submit() async {
        saving = true
        failure = nil
        defer { saving = false }
        do {
            try await save(trimmed)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}

// MARK: - To confirm

/// Claims Psyche is not sure of. Confirm makes one the owner's (memory.claims.confirm). Not now hides it for this
/// session only; no Gateway call is made, so the claim keeps waiting. There is no reject on the phone.
struct ClaimsView: View {
    @State private var model: LearningModel

    init(store: any PsycheBackend) {
        _model = State(initialValue: LearningModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("To confirm", bundle: .module).psycheTitle().padding(.bottom, 4)
                Text("Psyche isn't sure of these. Confirm what's right, or leave the rest for now.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted).padding(.bottom, 16)
                content
            }
            .padding(PsycheMetrics.pagePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .task { await model.loadClaims() }
        .alert(String(localized: "Couldn't update that", bundle: .module), isPresented: noticeBinding) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
    }

    private var noticeBinding: Binding<Bool> {
        Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
    }

    @ViewBuilder
    private var content: some View {
        switch model.claims {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
        case .failed(let message):
            LearningRetry(message: message) { Task { await model.loadClaims() } }
        case .loaded(let all):
            let claims = model.shownClaims(all)
            if claims.isEmpty {
                Text("Nothing is waiting for you.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
            ForEach(Array(claims.enumerated()), id: \.element.id) { index, claim in
                VStack(alignment: .leading, spacing: 10) {
                    Text(verbatim: claim.text).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        .multilineTextAlignment(.leading)
                    Text(verbatim: confidenceLabel(claim.confidence)).font(.caption).foregroundStyle(PsycheColor.muted)
                    HStack(spacing: 10) {
                        Button(String(localized: "Confirm", bundle: .module)) { Task { await model.confirm(claim) } }
                            .buttonStyle(.psycheOutline)
                        Button(String(localized: "Not now", bundle: .module)) { model.hideForNow(claim) }
                            .buttonStyle(.psycheOutline)
                    }
                }
                .padding(PsycheMetrics.rowPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardRow(CardPosition(index: index, count: claims.count))
            }
        }
    }
}

// MARK: - Recent changes

/// Facts Psyche accepted on its own in the last week. Undo reverts one.
struct RecentChangesView: View {
    @State private var model: LearningModel

    init(store: any PsycheBackend) {
        _model = State(initialValue: LearningModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Recent changes", bundle: .module).psycheTitle().padding(.bottom, 4)
                Text("Changes Psyche made on its own in the last week. Undo any of them.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted).padding(.bottom, 16)
                content
            }
            .padding(PsycheMetrics.pagePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .task { await model.loadChanges() }
        .alert(String(localized: "Couldn't update that", bundle: .module), isPresented: noticeBinding) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
    }

    private var noticeBinding: Binding<Bool> {
        Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
    }

    @ViewBuilder
    private var content: some View {
        switch model.changes {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
        case .failed(let message):
            LearningRetry(message: message) { Task { await model.loadChanges() } }
        case .loaded(let changes) where changes.isEmpty:
            Text("No recent changes.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        case .loaded(let changes):
            ForEach(Array(changes.enumerated()), id: \.element.id) { index, change in
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: change.sentence).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        .multilineTextAlignment(.leading)
                    Text(verbatim: Self.label(change))
                        .font(.caption).foregroundStyle(PsycheColor.muted)
                    Button(String(localized: "Undo", bundle: .module)) { Task { await model.undo(change) } }
                        .buttonStyle(.psycheOutline)
                }
                .padding(PsycheMetrics.rowPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardRow(CardPosition(index: index, count: changes.count))
            }
        }
    }

    /// "New", "Changed (was …)" or "Disagrees with …", as the Mac words them.
    static func label(_ change: RecentChange) -> String {
        switch change.change {
        case .new:
            return String(localized: "New", bundle: .module)
        case .changed:
            return String(localized: "Changed (was \(change.previousValue ?? ""))", bundle: .module)
        case .conflict:
            return String(localized: "Disagrees with \(change.previousValue ?? "")", bundle: .module)
        }
    }
}

// MARK: - Remember this

/// A quick note for Psyche to keep in today's daily note (memory.remember).
struct RememberSheet: View {
    let learning: LearningModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var saving = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Note", bundle: .module), text: $text, axis: .vertical)
                        .lineLimit(3...8)
                        .accessibilityIdentifier("rememberField")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("It goes in today's daily note.", bundle: .module)
                        if let failure {
                            Text(verbatim: failure)
                        }
                    }
                    .foregroundStyle(PsycheColor.muted)
                }
            }
            .navigationTitle(String(localized: "Remember this", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save", bundle: .module)) { Task { await submit() } }
                        .disabled(saving || !LearningModel.canRemember(text))
                }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private func submit() async {
        saving = true
        failure = nil
        defer { saving = false }
        do {
            try await learning.remember(text)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}

/// A failed read with a retry, in the Memory tab's own words.
private struct LearningRetry: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Couldn't load this", bundle: .module).font(.headline).foregroundStyle(PsycheColor.text)
            Text(verbatim: message).font(.subheadline).foregroundStyle(PsycheColor.muted)
            Button(String(localized: "Try again", bundle: .module), action: retry)
                .buttonStyle(.psycheOutline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
