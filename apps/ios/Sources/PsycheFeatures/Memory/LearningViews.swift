import PsycheDesign
import PsycheStore
import SwiftUI

// The People tab's two small learning screens: "To confirm" (claims Psyche is unsure of) and the quick
// "Remember this" note. What Psyche learned, recent changes and held-back items are for the Mac.

/// Confidence in words, the Mac's wording (memoryReview.confidence).
private func confidenceLabel(_ value: Double) -> String {
    if value >= 0.75 { return String(localized: "Confident", bundle: .module) }
    if value >= 0.4 { return String(localized: "Fairly sure", bundle: .module) }
    return String(localized: "Unsure", bundle: .module)
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
        .task { await model.follow { await model.loadClaims() } }
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

