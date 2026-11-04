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

/// A person (docs/design/ios-app-2026.md §4.5): what Psyche knows, with "That's right" and "Remove" on
/// each fact. Names, aliases and merging say "Edit on your Mac".
struct PersonPage: View {
    @State private var model: PersonModel
    @State private var retracting: MemoryFact?

    init(id: String, store: any PsycheBackend) {
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
                        Text("Couldn't load this").font(.headline)
                        Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        Button("Try again") { Task { await model.load() } }
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
        .confirmationDialog(
            "Remove this fact?", isPresented: Binding(get: { retracting != nil }, set: { if !$0 { retracting = nil } }),
            titleVisibility: .visible, presenting: retracting
        ) { fact in
            Button("Remove", role: .destructive) { Task { await model.retract(fact) } }
            Button("Keep it", role: .cancel) {}
        } message: { fact in
            Text("\u{201C}\(fact.text)\u{201D} stops shaping what Psyche does.")
        }
        .alert("Couldn't change that", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
    }

    @ViewBuilder
    private func content(_ detail: PersonDetail) -> some View {
        HStack(spacing: 14) {
            InitialsAvatar(detail.person.initials, size: 56)
            VStack(alignment: .leading, spacing: 3) {
                Text(detail.person.name).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                EvidenceLine([detail.person.detail])
            }
        }
        .accessibilityElement(children: .combine)

        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("What Psyche knows")
            if detail.facts.isEmpty {
                Text("Nothing yet.").font(.subheadline).foregroundStyle(PsycheColor.muted)
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
                SectionHeader("Recent")
                PaperStack {
                    ForEach(Array(detail.recent.enumerated()), id: \.element.id) { index, fact in
                        if index > 0 { HairlineDivider() }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(fact.text).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            EvidenceLine(fact.evidence)
                        }
                        .padding(PsycheMetrics.rowPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }

        EditOnMacNote(text: "Edit on your Mac: names, aliases, merging people.")
    }

    private func factRow(_ fact: MemoryFact) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(fact.text).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    .multilineTextAlignment(.leading)
                EvidenceLine(fact.confirmed ? fact.evidence + ["confirmed"] : fact.evidence)
            }
            Spacer(minLength: 0)
            Menu {
                if !fact.confirmed {
                    Button { Task { await model.confirm(fact) } } label: { Label("That's right", systemImage: "checkmark") }
                }
                Button(role: .destructive) { retracting = fact } label: { Label("Remove", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PsycheColor.muted)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Actions for this fact")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 8)
    }
}
