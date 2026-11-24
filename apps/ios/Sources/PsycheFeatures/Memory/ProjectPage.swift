import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class ProjectModel {
    private(set) var phase: LoadPhase<ProjectDetail> = .idle
    private(set) var overrides: [String: Bool] = [:]
    private(set) var completions = 0
    /// Bumped on each saved edit or forgotten fact, so the view can play one haptic.
    private(set) var changes = 0
    var notice: String?
    /// The Space linked to this project, if there is one.
    private(set) var spaceID: String?
    private(set) var makingSpace = false
    private var pending: Set<String> = []
    private let id: String
    private let store: any PsycheBackend

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.project(id: id))
            overrides = overrides.filter { pending.contains($0.key) }
            // A failed lookup only hides the link: the page itself loaded.
            if let linked = try? await store.spaceID(forProject: id) { spaceID = linked }
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

    /// "Make a Space": the owner's tap. Returns the new Space's id so the page can open it.
    func makeSpace(named name: String) async -> String? {
        guard spaceID == nil, !makingSpace else { return spaceID }
        makingSpace = true
        defer { makingSpace = false }
        do {
            let made = try await store.makeSpace(forProject: id, named: name)
            spaceID = made
            return made
        } catch {
            notice = error.localizedDescription
            return nil
        }
    }

    /// Saves the owner's name, status or due date (memory.entities.update). Throws so the sheet shows the Gateway's words.
    func updateCard(_ update: EntityChanges, ifMatch: String?) async throws {
        try await store.updateEntity(id: id, changes: update, ifMatch: ifMatch)
        changes += 1
        await load()
    }

    /// Saves the owner's value for a project fact. Throws so the edit sheet shows the Gateway's words.
    /// The project is an entity like a person, so the same `memory.entities.facts.set` call takes its id.
    func edit(_ fact: MemoryFact, value: String) async throws {
        guard let attribute = fact.attribute else {
            throw BackendError.refused(String(localized: "Edit this on your Mac.", bundle: .module))
        }
        try await store.editFact(personID: id, attribute: attribute, value: value)
        changes += 1
        await load()
    }

    /// "Forget": the fact leaves the page. A failure shows as the page's alert.
    func retract(_ fact: MemoryFact) async {
        do {
            try await store.retractFact(personID: id, factID: fact.id)
            changes += 1
            await load()
        } catch {
            notice = error.localizedDescription
        }
    }

    func isDone(_ todo: TodoItem) -> Bool { overrides[todo.id] ?? todo.done }

    func toggle(_ todo: TodoItem) {
        let target = !isDone(todo)
        overrides[todo.id] = target
        pending.insert(todo.id)
        if target { completions += 1 }
        Task {
            do {
                try await store.setTodo(id: todo.id, done: target)
            } catch {
                overrides[todo.id] = nil
                notice = error.localizedDescription
            }
            pending.remove(todo.id)
        }
    }
}

/// A project (docs/design/ios-app-2026.md §4.5): progress, its to-dos, what Psyche noted, and where the
/// page comes from. Each noted fact has "Edit" and "Forget", as on a person's page. Bigger edits say
/// "Edit on your Mac".
struct ProjectPage: View {
    @State private var model: ProjectModel
    @State private var openedSpace: Route?
    @State private var retracting: MemoryFact?
    @State private var editing: MemoryFact?
    @State private var editingCard = false

    init(id: String, store: any PsycheBackend) {
        _model = State(initialValue: ProjectModel(id: id, store: store))
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
        .navigationDestination(item: $openedSpace) { route in RouteView(route: route) }
        .sensoryFeedback(.success, trigger: model.completions)
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
        .sheet(isPresented: $editingCard) {
            if let card = model.phase.value?.card {
                EntityEditSheet(card: card, isProject: true) { update in try await model.updateCard(update, ifMatch: card.etag) }
            }
        }
        .toolbar {
            if model.phase.value?.card != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button(String(localized: "Edit", bundle: .module)) { editingCard = true }
                }
            }
        }
        .alert(String(localized: "Couldn't update that", bundle: .module), isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
    }

    @ViewBuilder
    private func content(_ detail: ProjectDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(detail.project.title).psycheTitle(.title).foregroundStyle(PsycheColor.text)
            ProgressBar(fraction: detail.project.fraction)
            let facts = Self.statusParts(detail.card)
            if !facts.isEmpty { EvidenceLine(facts) }
            EvidenceLine([detail.project.detail])
        }
        .accessibilityElement(children: .combine)

        spaceButton(detail)

        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "To-do", bundle: .module))
            if detail.todos.isEmpty {
                Text("Nothing due on this project.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
            } else {
                PaperStack {
                    ForEach(Array(detail.todos.enumerated()), id: \.element.id) { index, todo in
                        if index > 0 { HairlineDivider() }
                        todoRow(todo)
                    }
                }
            }
        }

        if !detail.notes.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(String(localized: "Notes", bundle: .module))
                PaperStack {
                    ForEach(Array(detail.notes.enumerated()), id: \.element.id) { index, note in
                        if index > 0 { HairlineDivider() }
                        noteRow(note)
                    }
                }
            }
        }

        if !detail.evidence.isEmpty {
            EvidenceLine(String(localized: "Because", bundle: .module), detail.evidence)
        }
        EditOnMacNote(text: String(localized: "Edit on your Mac: merging projects.", bundle: .module))
    }

    /// The status and due date the owner set on the card, as the header's line. Nothing when neither is set.
    static func statusParts(_ card: EntityCard?) -> [String] {
        guard let card else { return [] }
        var parts: [String] = []
        if let status = card.projectStatus {
            switch status {
            case .active: parts.append(String(localized: "Active", bundle: .module))
            case .paused: parts.append(String(localized: "Paused", bundle: .module))
            case .done: parts.append(String(localized: "Done", bundle: .module))
            }
        }
        if let due = card.dueAt {
            parts.append(String(localized: "Due \(due.formatted(date: .abbreviated, time: .omitted))", bundle: .module))
        }
        return parts
    }

    /// "Open Space" for a project that has one, "Make a Space" for one that doesn't. A Space is made only by this tap.
    /// A Keep-private project gets neither: a Space would show on Home and in the Spaces list (SR10).
    @ViewBuilder
    private func spaceButton(_ detail: ProjectDetail) -> some View {
        if detail.isPrivate {
            EmptyView()
        } else if let spaceID = model.spaceID {
            Button { openedSpace = .space(id: spaceID) } label: {
                Label(String(localized: "Open Space", bundle: .module), systemImage: "square.stack")
            }
            .buttonStyle(.psycheOutline).frame(maxWidth: 220)
        } else {
            Button {
                Task { if let made = await model.makeSpace(named: detail.project.title) { openedSpace = .space(id: made) } }
            } label: {
                Label(String(localized: "Make a Space", bundle: .module), systemImage: "square.stack")
            }
            .buttonStyle(.psycheOutline).frame(maxWidth: 220)
            .disabled(model.makingSpace)
        }
    }

    private func noteRow(_ note: MemoryFact) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(note.text).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    .multilineTextAlignment(.leading)
                EvidenceLine(note.evidence)
            }
            Spacer(minLength: 0)
            Menu {
                if note.attribute != nil {
                    Button { editing = note } label: { Label(String(localized: "Edit", bundle: .module), systemImage: "pencil") }
                }
                Button(role: .destructive) { retracting = note } label: { Label(String(localized: "Forget", bundle: .module), systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PsycheColor.muted)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(String(localized: "Actions for this fact", bundle: .module))
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 8)
    }

    private func todoRow(_ todo: TodoItem) -> some View {
        let done = model.isDone(todo)
        return HStack(spacing: 12) {
            Button { model.toggle(todo) } label: { CircleCheck(done: done).frame(width: 44, height: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .padding(.leading, -10)
                .accessibilityLabel(done ? "Mark \(todo.title) not done" : "Mark \(todo.title) done")
            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .font(.psycheRow)
                    .strikethrough(done)
                    .foregroundStyle(done ? PsycheColor.muted : PsycheColor.text)
                EvidenceLine([MemoryModel.displayMeta(todo, done: done)])
            }
            Spacer(minLength: 0)
            if todo.needsYou && !done { NeedsYouDot() }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, PsycheMetrics.rowPadding.leading)
    }
}
