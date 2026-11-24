import PsycheDesign
import PsycheStore
import SwiftUI

/// "Edit" on a specialist job's page: its token, cost and time limits, and its deadline. Save sends only what
/// changed, and stays off until something did and every field is valid. A refusal from the Gateway stays on this
/// sheet in its own words. The Gateway keeps each limit within what Settings allow for the role.
struct TaskEditSheet: View {
    let save: (TaskChanges) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TaskEditDraft
    @State private var saving = false
    @State private var failure: String?

    init(limits: TaskLimits, save: @escaping (TaskChanges) async throws -> Void) {
        self.save = save
        _draft = State(initialValue: TaskEditDraft(limits: limits))
    }

    private var canSave: Bool { !saving && draft.canSave }

    /// A deadline is offered when the job has none yet. A job that has one keeps it: `tasks.update` cannot clear it.
    private var hasDeadline: Binding<Bool> {
        Binding(
            get: { draft.deadline != nil },
            set: { draft.deadline = $0 ? (draft.deadline ?? Date.now.addingTimeInterval(3600)) : nil })
    }

    private var deadline: Binding<Date> {
        Binding(get: { draft.deadline ?? Date.now }, set: { draft.deadline = $0 })
    }

    private var budgetInvalid: Bool { draft.tokensInvalid || draft.costInvalid || draft.minutesInvalid }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Tokens", bundle: .module), text: $draft.tokensText)
                        .accessibilityIdentifier("taskTokensField")
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                    TextField(String(localized: "Cost", bundle: .module), text: $draft.costText)
                        .accessibilityIdentifier("taskCostField")
                        #if os(iOS)
                        .keyboardType(.decimalPad)
                        #endif
                    TextField(String(localized: "Time (minutes)", bundle: .module), text: $draft.minutesText)
                        .accessibilityIdentifier("taskMinutesField")
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                } header: {
                    Text("Budget", bundle: .module)
                } footer: {
                    if budgetInvalid {
                        Text("Tokens and minutes need a whole number above zero. Cost can't be negative.", bundle: .module)
                    } else {
                        Text("Psyche keeps each limit within what Settings allow for this role.", bundle: .module)
                    }
                }

                Section {
                    if draft.original.deadline == nil {
                        Toggle(String(localized: "Set a deadline", bundle: .module), isOn: hasDeadline)
                    }
                    if draft.deadline != nil {
                        DatePicker(
                            String(localized: "Deadline", bundle: .module), selection: deadline,
                            displayedComponents: [.date, .hourAndMinute])
                    }
                } footer: {
                    if draft.deadlineInvalid {
                        Text("A deadline has to be later than now.", bundle: .module)
                    }
                }

                if let failure {
                    Section {
                        Text(failure).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
            .navigationTitle(String(localized: "Edit task", bundle: .module))
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
        guard let changes = draft.changes, draft.canSave else { return }
        saving = true
        failure = nil
        defer { saving = false }
        do {
            try await save(changes)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}
