import PsycheDesign
import SwiftUI

/// "Add milestone" on a goal: a title and an optional due date. Save stays off until the title has a word in it.
/// A refusal stays on the sheet in the Gateway's words, so the owner can change the title or cancel.
struct AddMilestoneSheet: View {
    let save: (String, Date?) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var hasDueDate = false
    @State private var dueAt = Date.now
    @State private var saving = false
    @State private var failure: String?

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSave: Bool { !saving && !trimmedTitle.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "What's the milestone?", bundle: .module), text: $title, axis: .vertical)
                        .lineLimit(1...4)
                        .accessibilityIdentifier("addMilestoneTitle")
                    Toggle(String(localized: "Due date", bundle: .module), isOn: $hasDueDate)
                    if hasDueDate {
                        DatePicker(String(localized: "Due date", bundle: .module), selection: $dueAt, displayedComponents: .date)
                    }
                } footer: {
                    if let failure {
                        Text(failure).foregroundStyle(PsycheColor.red)
                    }
                }
            }
            .navigationTitle(String(localized: "Add milestone", bundle: .module))
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
            try await save(trimmedTitle, hasDueDate ? dueAt : nil)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}
