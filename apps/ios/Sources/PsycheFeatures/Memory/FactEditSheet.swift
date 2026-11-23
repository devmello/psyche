import PsycheDesign
import PsycheStore
import SwiftUI

/// "Edit" on a fact: the owner's own value replaces the one Psyche has. The Gateway keeps the old value in
/// history. A refusal (a sensitive trait, a value it won't take) stays on this sheet in the Gateway's words,
/// so the owner can change the value or cancel.
struct FactEditSheet: View {
    let fact: MemoryFact
    let save: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var saving = false
    @State private var failure: String?

    init(fact: MemoryFact, save: @escaping (String) async throws -> Void) {
        self.fact = fact
        self.save = save
        _text = State(initialValue: fact.value ?? fact.text)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSave: Bool {
        !saving && !trimmed.isEmpty && trimmed != (fact.value ?? fact.text).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Value", bundle: .module), text: $text, axis: .vertical)
                        .lineLimit(1...6)
                        .accessibilityIdentifier("factEditField")
                } footer: {
                    if let failure {
                        Text(failure).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
            .navigationTitle(String(localized: "Edit fact", bundle: .module))
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
