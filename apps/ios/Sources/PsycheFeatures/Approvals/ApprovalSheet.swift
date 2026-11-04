import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The approval sheet (docs/design/ios-app-2026.md §4.3): full arguments, never truncated, the amber
/// hairline, and one ink fill (Allow). Away from home the buttons are off and say why.
struct ApprovalSheet: View {
    let item: NeedsYouItem
    let detail: ApprovalDetail
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var armed = false
    @State private var answered = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                StatusDot(.needsYou, "Needs your OK · \(detail.kindLabel)", font: .footnote.weight(.semibold))
                Text(detail.title).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                Text(detail.summary).font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
            ApprovalCard(fields: detail.fields.map { .init(key: $0.key, value: $0.value) })
            VStack(alignment: .leading, spacing: 6) {
                EvidenceLine("Because", detail.evidence)
                EvidenceLine("Also sent to", [detail.alsoSentTo])
            }
            Spacer(minLength: 12)
            if let note = detail.presenceNote {
                Label(note, systemImage: "faceid")
                    .font(.footnote)
                    .foregroundStyle(PsycheColor.muted)
            }
            if !session.state.canAnswer {
                Text("Reconnect to answer").font(.footnote).foregroundStyle(PsycheColor.muted)
            }
            HStack(spacing: 10) {
                Button("Deny") { finish() }
                    .buttonStyle(.psycheOutline)
                Button(detail.allowLabel) { finish() }
                    .buttonStyle(.psycheInk)
                    .layoutPriority(1)
                    // The Gateway enforces a 400 ms arming delay on Allow; the button shows it too.
                    .disabled(!armed)
            }
            .disabled(!session.state.canAnswer)
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.top, 28)
        .padding(.bottom, 16)
        .psycheScreen()
        .sensoryFeedback(.success, trigger: answered)
        .task {
            try? await Task.sleep(for: .milliseconds(400))
            armed = true
        }
        .presentationDragIndicator(.visible)
    }

    private func finish() {
        answered += 1
        dismiss()
    }
}
