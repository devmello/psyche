import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class ProjectModel {
    private(set) var phase: LoadPhase<ProjectDetail> = .idle
    private(set) var overrides: [String: Bool] = [:]
    private(set) var completions = 0
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
/// page comes from. Read-mostly: bigger edits say "Edit on your Mac".
struct ProjectPage: View {
    @State private var model: ProjectModel
    @State private var openedSpace: Route?

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
                        VStack(alignment: .leading, spacing: 3) {
                            Text(note.text).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            EvidenceLine(note.evidence)
                        }
                        .padding(PsycheMetrics.rowPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }

        if !detail.evidence.isEmpty {
            EvidenceLine(String(localized: "Because", bundle: .module), detail.evidence)
        }
        EditOnMacNote(text: String(localized: "Edit on your Mac: renaming, deadlines, merging projects.", bundle: .module))
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
