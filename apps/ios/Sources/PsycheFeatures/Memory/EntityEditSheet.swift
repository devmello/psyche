import PsycheDesign
import PsycheStore
import SwiftUI

/// "Edit" on a person's or a project's card. A person gets the name and aliases; a project also gets its status
/// and due date (with "No deadline" for none). Save sends only what changed, and stays off until something did
/// and the name is not empty. A refusal from the Gateway stays on this sheet in its own words.
struct EntityEditSheet: View {
    let isProject: Bool
    let save: (EntityChanges) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: EntityEditDraft
    @State private var newAlias = ""
    @State private var saving = false
    @State private var failure: String?

    init(card: EntityCard, isProject: Bool, save: @escaping (EntityChanges) async throws -> Void) {
        self.isProject = isProject
        self.save = save
        _draft = State(initialValue: EntityEditDraft(card: card))
    }

    private var canSave: Bool { !saving && draft.canSave }

    private var statusBinding: Binding<ProjectStatus> {
        Binding(get: { draft.projectStatus ?? .active }, set: { draft.projectStatus = $0 })
    }

    private var hasDueDate: Binding<Bool> {
        Binding(get: { draft.dueAt != nil }, set: { draft.dueAt = $0 ? (draft.dueAt ?? Date.now) : nil })
    }

    private var dueDate: Binding<Date> {
        Binding(get: { draft.dueAt ?? Date.now }, set: { draft.dueAt = $0 })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Name", bundle: .module), text: $draft.name)
                        .accessibilityIdentifier("entityNameField")
                } header: {
                    Text("Name", bundle: .module)
                }

                Section {
                    ForEach(Array(draft.aliases.enumerated()), id: \.offset) { index, alias in
                        HStack {
                            Text(alias)
                            Spacer(minLength: 0)
                            Button(role: .destructive) { draft.removeAlias(at: index) } label: {
                                Image(systemName: "minus.circle")
                                    .foregroundStyle(PsycheColor.muted)
                                    .frame(width: 36, height: 36)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(String(localized: "Remove alias", bundle: .module))
                        }
                    }
                    if draft.canAddAlias {
                        HStack {
                            TextField(String(localized: "Add alias", bundle: .module), text: $newAlias)
                                .onSubmit(addAlias)
                            Button(String(localized: "Add", bundle: .module), action: addAlias)
                                .disabled(newAlias.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                } header: {
                    Text("Aliases", bundle: .module)
                }

                if isProject {
                    Section {
                        Picker(String(localized: "Status", bundle: .module), selection: statusBinding) {
                            Text("Active", bundle: .module).tag(ProjectStatus.active)
                            Text("Paused", bundle: .module).tag(ProjectStatus.paused)
                            Text("Done", bundle: .module).tag(ProjectStatus.done)
                        }
                    } header: {
                        Text("Status", bundle: .module)
                    }

                    Section {
                        Toggle(String(localized: "Due date", bundle: .module), isOn: hasDueDate)
                        if draft.dueAt != nil {
                            DatePicker(String(localized: "Due date", bundle: .module), selection: dueDate, displayedComponents: .date)
                        }
                    } header: {
                        Text("Due date", bundle: .module)
                    } footer: {
                        if draft.dueAt == nil {
                            Text("No deadline", bundle: .module)
                        }
                    }
                }

                if let failure {
                    Section {
                        Text(failure).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
            .navigationTitle(isProject ? String(localized: "Edit project", bundle: .module) : String(localized: "Edit person", bundle: .module))
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

    private func addAlias() {
        if draft.addAlias(newAlias) { newAlias = "" }
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
