import PsycheDesign
import PsycheStore
import SwiftUI

/// "Add goal": a title and a category, as the Mac's dialog takes them. Save stays off until the title has a
/// word in it. A refusal stays on the sheet in the Gateway's words, so the owner can change the title or cancel.
struct AddGoalSheet: View {
    let save: (GoalDraft) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft = GoalDraft()
    @State private var saving = false
    @State private var failure: String?

    private var canSave: Bool { !saving && draft.isValid }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "What's the goal?", bundle: .module), text: $draft.title, axis: .vertical)
                        .lineLimit(1...4)
                        .accessibilityIdentifier("addGoalTitle")
                    Picker(String(localized: "Category", bundle: .module), selection: $draft.category) {
                        ForEach(GoalCategoryChoice.allCases) { category in
                            Text(ProactiveText.goalCategory(category)).tag(category)
                        }
                    }
                } footer: {
                    if let failure {
                        Text(failure).foregroundStyle(PsycheColor.red)
                    }
                }
            }
            .navigationTitle(String(localized: "Add goal", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save", bundle: .module)) { Task { await submit() } }
                        .disabled(!canSave)
                }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private func submit() async {
        guard canSave else { return }
        saving = true
        failure = nil
        defer { saving = false }
        do {
            try await save(draft)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}
