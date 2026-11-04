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
        .sensoryFeedback(.success, trigger: model.completions)
        .alert("Couldn't update that", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("OK", role: .cancel) {}
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

        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("To-do")
            if detail.todos.isEmpty {
                Text("Nothing due on this project.").font(.subheadline).foregroundStyle(PsycheColor.muted)
            } else {
                PaperCard {
                    ForEach(Array(detail.todos.enumerated()), id: \.element.id) { index, todo in
                        if index > 0 { HairlineDivider() }
                        todoRow(todo)
                    }
                }
            }
        }

        if !detail.notes.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Notes")
                PaperCard {
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
            EvidenceLine("Because", detail.evidence)
        }
        EditOnMacNote(text: "Edit on your Mac: renaming, deadlines, merging projects.")
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
