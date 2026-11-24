import PsycheDesign
import PsycheStore
import SwiftUI

/// "Merge with…" on a person: pick another person, confirm by name, and merge into this one. Cancel is always there,
/// both on the sheet and on the confirm alert. A refusal from the Gateway stays on the sheet in its own words.
struct PersonMergeSheet: View {
    let current: PersonItem
    let store: any PsycheBackend
    let onMerged: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [EntityRef] = []
    @State private var choice: EntityRef?
    @State private var merging = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Search people", bundle: .module), text: $query)
                        .accessibilityIdentifier("mergeSearchField")
                        .autocorrectionDisabled()
                }
                Section {
                    let others = results.filter { $0.id != current.id }
                    if others.isEmpty {
                        Text("No one matches.", bundle: .module).foregroundStyle(PsycheColor.muted)
                    }
                    ForEach(others) { ref in
                        Button { choice = ref } label: {
                            HStack {
                                Text(ref.name).foregroundStyle(PsycheColor.text)
                                Spacer(minLength: 0)
                                if choice?.id == ref.id { Image(systemName: "checkmark") }
                            }
                            .contentShape(Rectangle())
                        }
                    }
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(PsycheColor.muted) }
                }
            }
            .navigationTitle(String(localized: "Merge with…", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
            }
            .task(id: query) { await search() }
            .alert(
                String(localized: "Merge \(current.name) and \(choice?.name ?? "")?", bundle: .module),
                isPresented: Binding(get: { choice != nil }, set: { if !$0 { choice = nil } }),
                presenting: choice
            ) { other in
                Button(String(localized: "Merge", bundle: .module)) { Task { await merge(other) } }
                Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
            } message: { _ in
                Text("They become one person, with all their facts and contact details. You can split them again later.", bundle: .module)
            }
        }
    }

    private func search() async {
        do {
            results = try await store.searchPeople(query: query)
        } catch {
            results = []
            failure = error.localizedDescription
        }
    }

    private func merge(_ other: EntityRef) async {
        guard !merging else { return }
        merging = true
        defer { merging = false }
        do {
            let survivor = try await store.mergePerson(id: current.id, with: other.id)
            onMerged(survivor)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}

/// "Split…" on a person: lists the contact details this person holds, moves the chosen ones to a new person, and
/// keeps at least one here. Save stays off until that is true.
struct PersonSplitSheet: View {
    let person: PersonItem
    let store: any PsycheBackend
    let onSplit: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var held: [EntityIdentifier]?
    @State private var picked: Set<EntityIdentifier> = []
    @State private var newName = ""
    @State private var saving = false
    @State private var failure: String?

    private var canSplit: Bool {
        PersonSplitRules.canSplit(held: held, picked: picked, name: newName, saving: saving)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let held {
                    if held.count < 2 {
                        Section {
                            Text("Psyche needs two contact details to split a person. Merging brings them together.", bundle: .module)
                                .foregroundStyle(PsycheColor.muted)
                        }
                    } else {
                        Section {
                            ForEach(held) { row in
                                Toggle(isOn: binding(for: row)) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.value)
                                        Text(row.kind).font(.caption).foregroundStyle(PsycheColor.muted)
                                    }
                                }
                                .disabled(!picked.contains(row) && picked.count >= held.count - 1)
                            }
                        } header: {
                            Text("Move to the new person", bundle: .module)
                        } footer: {
                            Text("At least one detail stays here.", bundle: .module)
                        }
                    }
                } else {
                    Section { ProgressView() }
                }

                Section {
                    TextField(String(localized: "Name", bundle: .module), text: $newName)
                        .accessibilityIdentifier("splitNameField")
                } header: {
                    Text("New person's name", bundle: .module)
                }

                if let failure {
                    Section { Text(failure).foregroundStyle(PsycheColor.muted) }
                }
            }
            .navigationTitle(String(localized: "Split person", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Split person", bundle: .module)) { Task { await split() } }
                        .disabled(!canSplit)
                }
            }
            .task { await load() }
        }
    }

    private func binding(for row: EntityIdentifier) -> Binding<Bool> {
        Binding(
            get: { picked.contains(row) },
            set: { on in
                if on { picked.insert(row) } else { picked.remove(row) }
            })
    }

    private func load() async {
        do {
            held = try await store.personIdentifiers(id: person.id)
        } catch {
            held = []
            failure = error.localizedDescription
        }
    }

    private func split() async {
        guard let held, canSplit else { return }
        saving = true
        defer { saving = false }
        let moving = held.filter { picked.contains($0) }
        do {
            _ = try await store.splitPerson(id: person.id, identifiers: moving, name: newName.trimmingCharacters(in: .whitespacesAndNewlines))
            onSplit()
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}

/// "Add person" on the Memory tab: a name and an optional alias. Save stays off until the name is not empty.
struct AddPersonSheet: View {
    let store: any PsycheBackend
    let onAdded: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var alias = ""
    @State private var saving = false
    @State private var failure: String?

    private var canSave: Bool {
        !saving && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Name", bundle: .module), text: $name)
                        .accessibilityIdentifier("addPersonNameField")
                    TextField(String(localized: "Also known as (optional)", bundle: .module), text: $alias)
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(PsycheColor.muted) }
                }
            }
            .navigationTitle(String(localized: "Add person", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save", bundle: .module)) { Task { await save() } }
                        .disabled(!canSave)
                }
            }
        }
    }

    private func save() async {
        guard canSave else { return }
        saving = true
        defer { saving = false }
        let trimmedAlias = alias.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let id = try await store.createPerson(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                aliases: trimmedAlias.isEmpty ? [] : [trimmedAlias])
            onAdded(id)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}
