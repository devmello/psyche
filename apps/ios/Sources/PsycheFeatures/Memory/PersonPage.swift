import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class PersonModel {
    private(set) var phase: LoadPhase<PersonDetail> = .idle
    var notice: String?
    private(set) var changes = 0
    private let id: String
    private let store: any PsycheBackend

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.person(id: id))
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.memory), .resynced: await load()
            default: break
            }
        }
    }

    func confirm(_ fact: MemoryFact) async {
        await write { try await self.store.confirmFact(personID: self.id, factID: fact.id) }
    }

    func retract(_ fact: MemoryFact) async {
        await write { try await self.store.retractFact(personID: self.id, factID: fact.id) }
    }

    /// Saves the owner's name and aliases (memory.entities.update). Throws so the sheet shows the Gateway's words.
    func updateCard(_ update: EntityChanges, ifMatch: String?) async throws {
        try await store.updateEntity(id: id, changes: update, ifMatch: ifMatch)
        changes += 1
        await load()
    }

    /// Saves the owner's value. Throws so the edit sheet shows the Gateway's words beside its field
    /// (a refusal stays on the sheet, so the owner can change the value and try again).
    func edit(_ fact: MemoryFact, value: String) async throws {
        guard let attribute = fact.attribute else { throw BackendError.refused("Edit this on your Mac.") }
        try await store.editFact(personID: id, attribute: attribute, value: value)
        changes += 1
        await load()
    }

    /// A merge or split changed people: the sheets report it so the Memory screens reload too.
    func noteChanged() {
        changes += 1
    }

    private func write(_ action: () async throws -> Void) async {
        do {
            try await action()
            changes += 1
            await load()
        } catch {
            notice = error.localizedDescription
        }
    }
}

/// A person (docs/design/ios-app-2026.md §4.5): what Psyche knows, with "That's right", "Edit" and "Forget" on
/// each fact. Names, aliases and merging say "Edit on your Mac".
struct PersonPage: View {
    @State private var model: PersonModel
    @State private var retracting: MemoryFact?
    @State private var editing: MemoryFact?
    @State private var editingCard = false
    @State private var historyFact: MemoryFact?
    @State private var explainingFact: MemoryFact?
    @State private var mergingWith = false
    @State private var splitting = false
    @Environment(Router.self) private var router
    private let id: String
    private let store: any PsycheBackend

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
        _model = State(initialValue: PersonModel(id: id, store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                switch model.phase {
                case .idle, .loading:
                    content(.skeleton).redacted(reason: .placeholder).allowsHitTesting(false)
                case .loaded(let detail):
                    content(detail)
                case .failed(let message):
                    VStack(spacing: 12) {
                        Text("Couldn't load this", bundle: .module).font(.headline)
                        Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
                            .buttonStyle(.psycheOutline).frame(maxWidth: 220)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .refreshable { await model.load() }
        .task {
            await model.load()
            await model.observe()
        }
        .sensoryFeedback(.success, trigger: model.changes)
        .alert(
            String(localized: "Forget this fact?", bundle: .module), isPresented: Binding(get: { retracting != nil }, set: { if !$0 { retracting = nil } }),
            presenting: retracting
        ) { fact in
            Button(String(localized: "Forget", bundle: .module), role: .destructive) { Task { await model.retract(fact) } }
            Button(String(localized: "Keep it", bundle: .module), role: .cancel) {}
        } message: { fact in
            Text("\u{201C}\(fact.text)\u{201D} stops shaping what Psyche does.", bundle: .module)
        }
        .sheet(item: $editing) { fact in
            FactEditSheet(fact: fact) { value in try await model.edit(fact, value: value) }
        }
        .sheet(item: $historyFact) { fact in
            FactHistorySheet(entityID: id, fact: fact, store: store)
        }
        .sheet(item: $explainingFact) { fact in
            FactExplainSheet(fact: fact)
        }
        .sheet(isPresented: $editingCard) {
            if let card = model.phase.value?.card {
                EntityEditSheet(card: card, isProject: false) { update in try await model.updateCard(update, ifMatch: card.etag) }
            }
        }
        .sheet(isPresented: $mergingWith) {
            if let person = model.phase.value?.person {
                PersonMergeSheet(current: person, store: store) { survivor in
                    if case .replace(let next) = PersonMergeNavigation.decide(current: id, survivor: survivor) {
                        if !router.memoryPath.isEmpty { router.memoryPath.removeLast() }
                        router.memoryPath.append(.person(id: next))
                    }
                    model.noteChanged()
                    Task { await model.load() }
                }
            }
        }
        .sheet(isPresented: $splitting) {
            if let person = model.phase.value?.person {
                PersonSplitSheet(person: person, store: store) {
                    model.noteChanged()
                    Task { await model.load() }
                }
            }
        }
        .toolbar {
            if model.phase.value?.card != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button(String(localized: "Edit", bundle: .module)) { editingCard = true }
                }
            }
            if model.phase.value != nil {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button(String(localized: "Merge with…", bundle: .module)) { mergingWith = true }
                        Button(String(localized: "Split…", bundle: .module)) { splitting = true }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel(String(localized: "More actions for this person", bundle: .module))
                    .accessibilityIdentifier("personMenu")
                }
            }
        }
        .alert(String(localized: "Couldn't change that", bundle: .module), isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
    }

    @ViewBuilder
    private func content(_ detail: PersonDetail) -> some View {
        HStack(alignment: .top, spacing: 14) {
            InitialsAvatar(detail.person.initials, size: 56)
            VStack(alignment: .leading, spacing: 3) {
                Text(detail.person.name).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                if let aliases = detail.card?.aliases, !aliases.isEmpty {
                    Text(String(localized: "Also: \(aliases.joined(separator: ", "))", bundle: .module))
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                EvidenceLine([MemoryText.localizingTimes(detail.person.detail)])
            }
        }
        .accessibilityElement(children: .combine)

        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "What Psyche knows", bundle: .module))
            if detail.facts.isEmpty {
                Text("Nothing yet.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
            } else {
                PaperStack {
                    ForEach(Array(detail.facts.enumerated()), id: \.element.id) { index, fact in
                        if index > 0 { HairlineDivider() }
                        factRow(fact)
                    }
                }
            }
        }

        if !detail.recent.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(String(localized: "Recent", bundle: .module))
                PaperStack {
                    ForEach(Array(detail.recent.enumerated()), id: \.element.id) { index, fact in
                        if index > 0 { HairlineDivider() }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(MemoryText.localizingTimes(fact.text)).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            sourceLine(fact.evidence)
                        }
                        .padding(PsycheMetrics.rowPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    /// Where a fact came from, as a sentence ("From your calendar, confirmed") in the system caption style.
    private func sourceLine(_ evidence: [String], confirmed: Bool = false) -> some View {
        Text(MemoryText.evidence(evidence, confirmed: confirmed))
            .font(.caption).foregroundStyle(PsycheColor.muted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func factRow(_ fact: MemoryFact) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(MemoryText.localizingTimes(fact.text)).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    .multilineTextAlignment(.leading)
                sourceLine(fact.evidence, confirmed: fact.confirmed)
            }
            .padding(.vertical, 10)
            Spacer(minLength: 0)
            Menu {
                if !fact.confirmed {
                    Button { Task { await model.confirm(fact) } } label: { Label(String(localized: "That's right", bundle: .module), systemImage: "checkmark") }
                }
                if fact.isEditable {
                    Button { editing = fact } label: { Label(String(localized: "Edit", bundle: .module), systemImage: "pencil") }
                }
                if fact.attribute != nil {
                    Button { historyFact = fact } label: { Label(String(localized: "History", bundle: .module), systemImage: "clock.arrow.circlepath") }
                }
                // Any fact the Gateway sent with provenance: the sheet reads the fact itself.
                if fact.provenance != nil {
                    Button { explainingFact = fact } label: { Label(String(localized: "Why do you believe this?", bundle: .module), systemImage: "questionmark.bubble") }
                        .accessibilityIdentifier("factRow.why")
                }
                Button(role: .destructive) { retracting = fact } label: { Label(String(localized: "Forget", bundle: .module), systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PsycheColor.muted)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(String(localized: "Actions for this fact", bundle: .module))
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
    }
}
